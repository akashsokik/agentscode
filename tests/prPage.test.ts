import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, Project } from '../shared/types.ts';
import type { Exec } from '../server/github.ts';
import { GhError, ghAllowed, ghArgs } from '../server/github.ts';
import { agentForBranch, PRS_CACHE_MS, PRS_REFRESH_FLOOR_MS, PullRequests } from '../server/githubPrs.ts';
import { createApp } from '../server/app.ts';
import { checksLabel, findIssueKeys, firstIssueKey, inView, isHttpUrl, latestReviews, normalizeCheck, normalizePr, prsInView, viewCounts, type PullRequest } from '../shared/prs.ts';
import { harness, projectDir } from './helpers.ts';

// ---- issue keys -------------------------------------------------------------------------------

test('issue keys: code-hyphen-number, never a decision or note id, and only known codes when given', () => {
  assert.deepEqual(findIssueKeys('feat/ACH-12-short-title').map(k => k.key), ['ACH-12']);
  assert.deepEqual(findIssueKeys('Fixes ACH-12 and OSI-3; see ACH-12 again').map(k => k.key), ['ACH-12', 'OSI-3']);
  assert.deepEqual(findIssueKeys('Per ACH-D7 and ACH-N3, no key here').map(k => k.key), [], 'decision and note ids are not keys');
  assert.deepEqual(findIssueKeys('xACH-4, ACH-4b, ach-4, ACHIEV-3').map(k => k.key), [], 'not inside a word, upper case, a 2-5 letter code (Fen\'s ISSUE_KEY)');
  assert.deepEqual(findIssueKeys('ACH-012 and ACH-12').map(k => k.key), ['ACH-12'], 'a leading zero is the same issue');
  assert.deepEqual(findIssueKeys('feat/ALL-12-x', ['ACH', 'ALL']).map(k => k.key), ['ALL-12'], 'ALL keys link when ALL is known');
  assert.deepEqual(findIssueKeys('UTF-8 and ISO-9001 and ACH-9', ['ACH']).map(k => k.key), ['ACH-9'], 'unknown codes are ignored when codes are given');
  assert.equal(firstIssueKey(['main', 'Title with OSI-2', 'Body with ACH-1'], ['ACH', 'OSI']), 'OSI-2', 'branch, then title, then body');
  assert.equal(firstIssueKey(['feat/ACH-25-x', 'OSI-2'], ['ACH', 'OSI']), 'ACH-25');
  assert.equal(firstIssueKey(['main', '', undefined]), null);
});

// ---- normalising gh's JSON --------------------------------------------------------------------

test('checks: check runs and status contexts become success, failure, pending or skipped', () => {
  assert.equal(normalizeCheck({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }).state, 'success');
  assert.equal(normalizeCheck({ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/1' }).url, 'https://x/1');
  for (const c of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    assert.equal(normalizeCheck({ status: 'COMPLETED', conclusion: c }).state, 'failure', c);
  }
  assert.equal(normalizeCheck({ status: 'IN_PROGRESS', conclusion: '' }).state, 'pending');
  assert.equal(normalizeCheck({ status: 'COMPLETED', conclusion: 'SKIPPED' }).state, 'skipped');
  assert.equal(normalizeCheck({ __typename: 'StatusContext', context: 'ci/vercel', state: 'SUCCESS' }).name, 'ci/vercel');
  assert.equal(normalizeCheck({ __typename: 'StatusContext', context: 'x', state: 'ERROR' }).state, 'failure');
  assert.equal(normalizeCheck({ __typename: 'StatusContext', context: 'x', state: 'PENDING' }).state, 'pending');
  assert.deepEqual(checksLabel({ total: 0, passed: 0, failed: 0, pending: 0 }), { text: 'No checks', tone: 'muted' });
  assert.deepEqual(checksLabel({ total: 4, passed: 2, failed: 2, pending: 0 }), { text: '2 of 4 failing', tone: 'danger' });
  assert.deepEqual(checksLabel({ total: 3, passed: 2, failed: 0, pending: 1 }), { text: '1 running', tone: 'pending' });
  assert.deepEqual(checksLabel({ total: 3, passed: 3, failed: 0, pending: 0 }), { text: '3 passed', tone: 'success' });
});

test('reviews: each reviewer once, their latest verdict; a later comment does not undo an approval', () => {
  const reviews = latestReviews([
    { author: { login: 'rhea' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-11-12T10:00:00Z' },
    { author: { login: 'rhea' }, state: 'APPROVED', submittedAt: '2026-11-12T11:00:00Z' },
    { author: { login: 'rhea' }, state: 'COMMENTED', submittedAt: '2026-11-12T12:00:00Z' },
    { author: { login: 'bo' }, state: 'COMMENTED' },
  ]);
  assert.deepEqual(reviews.map(r => [r.author, r.state]), [['rhea', 'approved'], ['bo', 'commented']]);
});

const raw = (extra: Record<string, unknown> = {}) => ({
  number: 57, title: 'Issues phase 1', url: 'https://github.com/o/r/pull/57', state: 'OPEN', isDraft: false,
  author: { login: 'akashsokik', is_bot: false }, headRefName: 'feat/ACH-25-linear-issues', updatedAt: '2026-11-13T07:00:00Z',
  reviewDecision: '', reviews: [], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'test' }], body: '',
  ...extra,
});

test('a PR is normalised: state, draft, checks, the issue key and the agent behind the branch', () => {
  const pr = normalizePr(raw(), 'o/r', { codes: ['ACH'], agentFor: b => (b === 'feat/ACH-25-linear-issues' ? 'fen-id' : undefined) });
  assert.equal(pr.id, 'o/r#57');
  assert.equal(pr.state, 'open');
  assert.equal(pr.issueKey, 'ACH-25');
  assert.equal(pr.agentId, 'fen-id');
  assert.deepEqual(pr.checksSummary, { total: 1, passed: 1, failed: 0, pending: 0 });
  assert.equal(normalizePr(raw({ isDraft: true }), 'o/r').state, 'draft');
  assert.equal(normalizePr(raw({ state: 'MERGED', mergedAt: '2026-11-12T00:00:00Z' }), 'o/r').state, 'merged');
  assert.equal(normalizePr(raw({ author: { login: 'dependabot[bot]', is_bot: true } }), 'o/r').authorIsBot, true);
  assert.equal(normalizePr(raw({ headRefName: 'main', title: 'Fix', body: 'Closes ACH-3' }), 'o/r', { codes: ['ACH'] }).issueKey, 'ACH-3', 'the body is read too');
  assert.equal(normalizePr(raw({ headRefName: 'main', title: 'Bump UTF-8 lib' }), 'o/r', { codes: ['ACH'] }).issueKey, undefined);
});

test('the agent behind a branch: its worktree branch, or agent/<name>', () => {
  const agents = [
    { id: 'a1', name: 'Fen', worktree: { branch: 'feat/ACH-25-x' } },
    { id: 'a2', name: 'Ada', worktree: null },
  ] as unknown as Agent[];
  assert.equal(agentForBranch(agents, 'feat/ACH-25-x'), 'a1');
  assert.equal(agentForBranch(agents, 'agent/ada/fix-it'), 'a2');
  assert.equal(agentForBranch(agents, 'agents/Ada'), 'a2');
  assert.equal(agentForBranch(agents, 'feat/other'), undefined);
});

// ---- views ------------------------------------------------------------------------------------

test('views: Open, Needs review, Checks failing and Merged, with counts and newest first', () => {
  const make = (n: number, extra: Record<string, unknown>) => normalizePr(raw({ number: n, ...extra }), 'o/r');
  const prs: PullRequest[] = [
    make(1, { updatedAt: '2026-11-10T00:00:00Z' }),
    make(2, { updatedAt: '2026-11-12T00:00:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
    make(3, { isDraft: true, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    make(4, { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }], reviewDecision: 'CHANGES_REQUESTED' }),
    make(5, { state: 'MERGED', mergedAt: '2026-11-11T00:00:00Z', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }),
    make(6, { state: 'MERGED', mergedAt: '2026-11-12T00:00:00Z' }),
    make(7, { state: 'CLOSED' }),
  ];
  assert.deepEqual(viewCounts(prs), { open: 4, needsReview: 2, checksFailing: 2, merged: 2 });
  assert.ok(!inView(prs[2], 'needsReview'), 'a draft does not wait on a review');
  assert.ok(inView(prs[2], 'checksFailing'), 'a draft with failing checks still shows there');
  assert.ok(!inView(prs[4], 'checksFailing'), 'merged PRs are never "checks failing"');
  assert.ok(!inView(prs[6], 'open') && !inView(prs[6], 'merged'), 'closed without merging shows nowhere');
  assert.deepEqual(prsInView(prs, 'merged').map(p => p.number), [6, 5], 'merged: newest merge first');
  assert.deepEqual(prsInView(prs, 'needsReview').map(p => p.number), [4, 2], 'newest update first');
});

// ---- the service ------------------------------------------------------------------------------

const project = (id: string, name: string, code: string, extra: Partial<Project> = {}) => ({ id, name, path: `/x/${name}`, code, exists: true, isGit: true, createdAt: 0, ...extra }) as Project;

function service(opts: { repos: Record<string, string | null>; gh: (args: string[]) => Promise<string>; projects?: Project[]; now?: () => number }) {
  const calls: string[][] = [];
  const projects = opts.projects ?? [project('p1', 'agent-comms-harness', 'ACH'), project('p2', 'orca-site', 'OSI'), project('p3', 'orcabox', 'OBX')];
  const prs = new PullRequests({
    projects: () => projects,
    agents: () => [],
    repoOf: async p => opts.repos[p.name] ?? null,
    gh: async args => { calls.push(args); assert.ok(ghAllowed(args), `read-only: ${args.join(' ')}`); return opts.gh(args); },
    now: opts.now,
  });
  return { prs, calls };
}

test('the service reads open and merged PRs per repo, once per shared repo, and lists projects not on GitHub', async () => {
  const projects = [project('p1', 'agent-comms-harness', 'ACH'), project('p1b', 'harness-copy', 'HCO'), project('p2', 'orca-site', 'OSI'), project('p3', 'orcabox', 'OBX'), project('p4', 'gone', 'GON', { exists: false })];
  const { prs, calls } = service({
    projects,
    repos: { 'agent-comms-harness': 'o/agentscode', 'harness-copy': 'o/agentscode', 'orca-site': 'o/site', orcabox: null },
    gh: async args => JSON.stringify(args.includes('merged') ? [raw({ number: 3, state: 'MERGED', mergedAt: '2026-11-11T00:00:00Z' })] : [raw({ number: args[3] === 'o/site' ? 9 : 57, title: 'Fixes OSI-1' })]),
  });
  const data = await prs.list();
  assert.equal(calls.length, 4, 'two repos, open and merged each');
  assert.deepEqual(calls[0].slice(0, 6), ['pr', 'list', '--repo', calls[0][3], '--state', calls[0][5]]);
  assert.equal(data.pullRequests.length, 4);
  const ach = data.pullRequests.find(p => p.id === 'o/agentscode#57')!;
  assert.deepEqual(ach.projects.map(p => p.code), ['ACH', 'HCO'], 'both checkouts of the repo own it');
  assert.equal(ach.issueKey, 'ACH-25', 'the branch key wins over the title');
  assert.deepEqual(data.skipped, [{ project: 'gone', reason: 'The folder is missing.' }, { project: 'orcabox', reason: 'No GitHub remote.' }]);
  assert.equal(data.error, undefined);
});

test('the service caches for a minute, shares a read in flight, and reads again on refresh', async () => {
  let clock = 1_000_000;
  const { prs, calls } = service({ repos: { 'agent-comms-harness': 'o/r' }, projects: [project('p1', 'agent-comms-harness', 'ACH')], gh: async () => '[]', now: () => clock });
  await Promise.all([prs.list(), prs.list()]);
  assert.equal(calls.length, 2, 'one read (open and merged) for two callers at once');
  await prs.list();
  assert.equal(calls.length, 2, 'cached');
  clock += PRS_CACHE_MS + 1;
  await prs.list();
  assert.equal(calls.length, 4, 'stale after a minute');
  await prs.list(true);
  assert.equal(calls.length, 4, 'a refresh right after a read gets that read');
  for (let i = 0; i < 5; i++) await prs.list(true);
  assert.equal(calls.length, 4, 'repeated refreshes never stack up gh calls');
  clock += PRS_REFRESH_FLOOR_MS;
  await prs.list(true);
  assert.equal(calls.length, 6, 'a refresh after the floor reads again');
});

test('gh missing or logged out is one error for the page; a repo that fails is skipped with its reason', async () => {
  const missing = service({ repos: { 'agent-comms-harness': 'o/r', 'orca-site': 'o/s' }, gh: async () => { throw new GhError('The GitHub CLI (gh) is not installed on this machine.'); } });
  const a = await missing.prs.list();
  assert.match(a.error!, /not installed/);
  assert.deepEqual(a.pullRequests, []);
  const partial = service({
    repos: { 'agent-comms-harness': 'o/r', 'orca-site': 'o/s' },
    gh: async args => { if (args[3] === 'o/s') throw new GhError('gh failed: HTTP 404: Not Found'); return '[]'; },
  });
  const b = await partial.prs.list();
  assert.equal(b.error, undefined);
  assert.ok(b.skipped.some(s => s.project === 'orca-site' && /404/.test(s.reason)));
});

test('ghArgs.prsPage asks only for what the page shows, through a read-only command', () => {
  const open = ghArgs.prsPage('o/r', 'open');
  assert.ok(ghAllowed(open));
  assert.deepEqual(open.slice(0, 6), ['pr', 'list', '--repo', 'o/r', '--state', 'open']);
  assert.match(open.at(-1)!, /statusCheckRollup/);
  assert.match(open.at(-1)!, /reviews/);
  assert.throws(() => ghArgs.prsPage('not a repo; rm', 'merged'), GhError);
});

// ---- the route --------------------------------------------------------------------------------

test('GET /api/github/prs serves the page data; ?refresh=1 is honoured, past the 10 s floor', async () => {
  const h = harness();
  h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const calls: string[][] = [];
  const manager = h.manager as unknown as { ghExec: Exec; gitRemote: (dir: string) => Promise<string | null> };
  manager.ghExec = async (_bin, args) => { calls.push(args); return { stdout: JSON.stringify(args.includes('merged') ? [] : [raw()]), stderr: '' }; };
  manager.gitRemote = async () => 'git@github.com:me/web.git';
  const server = createApp(h.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address() as { port: number };
    const first = await (await fetch(`http://127.0.0.1:${port}/api/github/prs`)).json() as { pullRequests: PullRequest[] };
    assert.equal(first.pullRequests[0].id, 'me/web#57');
    assert.equal(first.pullRequests[0].projects[0].name, 'web');
    await fetch(`http://127.0.0.1:${port}/api/github/prs`);
    assert.equal(calls.length, 2, 'the second call is cached');
    await fetch(`http://127.0.0.1:${port}/api/github/prs?refresh=1`);
    assert.equal(calls.length, 2, 'a refresh within 10 s of the last read gets that read (the floor is tested on the service)');
  } finally {
    server.close();
  }
});

test('a GitHub App author reads as the app (dependabot), and is a bot', () => {
  const pr = normalizePr(raw({ author: { login: 'app/dependabot', is_bot: true } }), 'o/r');
  assert.equal(pr.author, 'dependabot');
  assert.equal(pr.authorIsBot, true);
});

test('navigation: one Pull requests tab, whichever PR is selected', async () => {
  const { tabKey } = await import('../web/layout.ts');
  assert.equal(tabKey({ kind: 'pullRequests', prId: 'o/r#1' }), tabKey({ kind: 'pullRequests' }));
});

test('ALL is among the codes a PR key may name, so issues with no project link too', async () => {
  const { prs } = service({ repos: { 'agent-comms-harness': 'o/r' }, projects: [project('p1', 'agent-comms-harness', 'ACH')], gh: async args => JSON.stringify(args.includes('merged') ? [] : [raw({ headRefName: 'feat/ALL-12-shared' })]) });
  const data = await prs.list();
  assert.equal(data.pullRequests[0].issueKey, 'ALL-12');
});

test('only http and https links from GitHub data become hrefs', () => {
  assert.ok(isHttpUrl('https://github.com/o/r/actions/runs/1'));
  assert.ok(isHttpUrl('http://ci.example.test/job/2'));
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', '//host/path', 'not a url', '', undefined]) {
    assert.equal(isHttpUrl(bad), false, String(bad));
  }
});

test('polling: every 5 minutes with the page open, every 30 for the sidebar count, never with nothing showing', async () => {
  const { pollInterval, isDue, PAGE_POLL_MS, COUNT_POLL_MS } = await import('../shared/prs.ts');
  assert.equal(pollInterval(1, 1), PAGE_POLL_MS);
  assert.equal(pollInterval(0, 2), COUNT_POLL_MS);
  assert.equal(pollInterval(0, 0), null);
  assert.equal(isDue(undefined, PAGE_POLL_MS), true, 'never read');
  assert.equal(isDue(1_000, PAGE_POLL_MS, 1_000 + PAGE_POLL_MS - 1), false);
  assert.equal(isDue(1_000, PAGE_POLL_MS, 1_000 + PAGE_POLL_MS), true);
  assert.equal(isDue(1_000, COUNT_POLL_MS, 1_000 + PAGE_POLL_MS), false, 'the count alone waits 30 minutes');
  assert.equal(isDue(0, null, 10 ** 12), false, 'nothing showing: no read');
});
