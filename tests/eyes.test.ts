import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { claudeToolPolicy } from '../server/agents/claude.ts';
import { codexArgs } from '../server/agents/codex.ts';
import type { BrowserBridge } from '../server/browserBridge.ts';
import { HttpError } from '../server/errors.ts';
import { capJson, ghAllowed, GhError, ghArgs, LOG_TAIL, logTail, OUTPUT_CAP, repoFromRemote, runGh, type Exec } from '../server/github.ts';
import type { Agent } from '../shared/types.ts';
import { harness, projectDir, settle } from './helpers.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

// ---- the gh allowlist ------------------------------------------------------------------------------

test('only read-only gh commands pass; anything that writes is refused before gh runs', async () => {
  for (const args of [ghArgs.prs('me/web'), ghArgs.pr('me/web', 7), ghArgs.runs('me/web', { branch: 'main' }), ghArgs.run('me/web', '123'), ghArgs.runLog('me/web', '123'), ghArgs.issues('me/web')]) {
    assert.ok(ghAllowed(args), args.join(' '));
  }
  const writes = [
    ['pr', 'merge', '7'], ['pr', 'comment', '7', '--body', 'x'], ['pr', 'close', '7'], ['pr', 'review', '7', '--approve'], ['pr', 'edit', '7', '--add-label', 'x'],
    ['run', 'rerun', '123'], ['run', 'cancel', '123'], ['run', 'delete', '123'], ['workflow', 'run', 'ci.yml'],
    ['issue', 'close', '1'], ['issue', 'create'], ['issue', 'comment', '1'], ['label', 'create', 'x'], ['api', 'repos/me/web', '-X', 'DELETE'],
    ['repo', 'delete', 'me/web'], ['pr', 'list', '--web'], ['pr', 'view', '7', '-w'], ['pr'], [],
  ];
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => { calls.push(args); return { stdout: '[]', stderr: '' }; };
  for (const args of writes) {
    assert.equal(ghAllowed(args), false, args.join(' '));
    await assert.rejects(runGh(args, exec), e => e instanceof GhError && /Refused/.test((e as Error).message));
  }
  assert.deepEqual(calls, [], 'gh never ran');
  // Names that could pass as flags or reach other repos are refused while building the arguments.
  assert.throws(() => ghArgs.runs('me/web', { branch: '--repo=evil/x' }), GhError);
  assert.throws(() => ghArgs.prs('me/web --web'), GhError);
  assert.throws(() => ghArgs.run('me/web', '1;rm -rf /'), GhError);
});

test('gh missing, logged out or slow: a clear message, never a crash', async () => {
  const fail = (error: object): Exec => async () => { throw Object.assign(new Error('failed'), error); };
  await assert.rejects(runGh(ghArgs.prs('me/web'), fail({ code: 'ENOENT' })), /not installed.*gh auth login/);
  await assert.rejects(runGh(ghArgs.prs('me/web'), fail({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' })), /not logged in/);
  await assert.rejects(runGh(ghArgs.prs('me/web'), fail({ killed: true })), /longer than/);
});

test('repos come from GitHub remotes; output and logs are capped with a note', () => {
  assert.equal(repoFromRemote('https://github.com/akashsokik/agentscode.git'), 'akashsokik/agentscode');
  assert.equal(repoFromRemote('git@github.com:akashsokik/agentscode.git'), 'akashsokik/agentscode');
  assert.equal(repoFromRemote('https://github.com/me/site'), 'me/site');
  assert.equal(repoFromRemote('https://gitlab.com/me/site.git'), null);
  const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ number: i, title: 'x'.repeat(200) })));
  const capped = capJson(big);
  assert.ok(JSON.stringify(capped.data).length <= OUTPUT_CAP);
  assert.match(capped.note!, /Showing \d+ of 500/);
  assert.equal(capJson('[1,2]').note, undefined);
  const tail = logTail('a'.repeat(LOG_TAIL + 100));
  assert.equal(tail.log.length, LOG_TAIL);
  assert.ok(tail.note);
});

// ---- who has them --------------------------------------------------------------------------------

test('the SuperAgent, reviewers and testers have the looking tools; developers do not', () => {
  const policy = (role: Agent['role']) => claudeToolPolicy({ role, autonomy: 'ask', useMcp: false }, true).allowedTools!;
  for (const role of ['super', 'reviewer', 'tester'] as const) assert.ok(policy(role).includes('mcp__agentscode__gh_runs') && policy(role).includes('mcp__agentscode__app_screenshot'), role);
  assert.ok(!policy('dev').includes('mcp__agentscode__gh_runs'));
  const reviewer = { role: 'reviewer', autonomy: 'ask', model: '', effort: '', sessionId: null, worktree: null } as unknown as Agent;
  assert.ok(codexArgs(reviewer, 'tok').some(a => a.includes('AGENTSCODE_EYES="1"')));
  assert.ok(!codexArgs({ ...reviewer, role: 'dev' }, 'tok').some(a => a.includes('AGENTSCODE_EYES')));
});

// ---- through the server --------------------------------------------------------------------------

async function team() {
  const calls: string[][] = [];
  let reply: (args: string[]) => string = () => '[]';
  const h = harness();
  const manager = h.manager as unknown as { ghExec: Exec; gitRemote: (dir: string) => Promise<string | null> };
  manager.ghExec = async (_bin, args) => { calls.push(args); return { stdout: reply(args), stderr: '' }; };
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const api = h.manager.addProject({ path: projectDir(h.dir, 'api') });
  manager.gitRemote = async dir => (dir.endsWith('web') ? 'git@github.com:me/web.git' : null);
  const rhea = await h.manager.create({ name: 'Rhea', engine: 'claude', projectId: null, role: 'reviewer' });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  h.manager.send(rhea.id, 'Review.');
  h.manager.send(ada.id, 'Code.');
  await settle();
  const call = (agentId: string, tool: string, args: Record<string, unknown>) => h.manager.commsTool(h.runner(agentId).ctx.commsToken!, tool, args);
  return { ...h, web, api, rhea, ada, call, calls, setReply: (fn: (args: string[]) => string) => { reply = fn; } };
}

test('gh tools through the server: projects map to repos, ones without a GitHub remote are skipped, developers are refused', async () => {
  const t = await team();
  t.setReply(() => JSON.stringify([{ number: 7, title: 'Dark mode' }]));
  const prs = await t.call(t.rhea.id, 'gh_prs', {}) as { results: { project: string; repo?: string; pullRequests?: unknown[]; note?: string }[] };
  assert.deepEqual(prs.results.map(r => [r.project, r.repo ?? null, r.note ?? null]), [['web', 'me/web', null], ['api', null, 'No GitHub remote (origin): skipped.']]);
  assert.deepEqual(t.calls[0].slice(0, 4), ['pr', 'list', '--repo', 'me/web']);
  await assert.rejects(t.call(t.rhea.id, 'gh_runs', { project: 'api' }), e => status(e) === 409 && /no GitHub remote/.test((e as Error).message));
  await assert.rejects(t.call(t.ada.id, 'gh_prs', {}), e => status(e) === 403);

  // A failed run comes with the tail of its failed steps' log.
  t.setReply(args => (args.includes('--log-failed') ? 'x'.repeat(LOG_TAIL + 50) : JSON.stringify({ databaseId: 9, conclusion: 'failure', jobs: [] })));
  const run = await t.call(t.rhea.id, 'gh_run', { project: 'web', run_id: '9' }) as { run: { conclusion: string }; failedLog: string; logNote: string };
  assert.equal(run.run.conclusion, 'failure');
  assert.equal(run.failedLog.length, LOG_TAIL);
  assert.ok(t.calls.some(args => args.join(' ') === 'run view 9 --repo me/web --log-failed'));
  // Branch names that look like flags never reach gh.
  await assert.rejects(t.call(t.rhea.id, 'gh_runs', { project: 'web', branch: '--web' }), e => status(e) === 400);
});

test('app_screenshot: desktop only; in the app it asks main for the window, saved in the agent\'s home, opening a tab first if asked', async () => {
  const t = await team();
  await assert.rejects(t.call(t.rhea.id, 'app_screenshot', {}), e => status(e) === 409 && /desktop app/.test((e as Error).message));
  const requests: { op: string; args: Record<string, unknown> }[] = [];
  const fake = { available: true, request: async (_agent: string, op: string, args: Record<string, unknown>) => { requests.push({ op, args }); return { path: args.path, width: 1440, height: 900, window: args.window }; } } as unknown as BrowserBridge;
  Object.defineProperty(t.manager, 'browser', { value: fake });
  const shot = await t.call(t.rhea.id, 'app_screenshot', { agent: 'Ada' }) as { path: string; width: number };
  assert.equal(requests[0].op, 'app_screenshot');
  assert.equal(requests[0].args.openAgent, t.ada.id);
  assert.equal(path.dirname(shot.path), path.join(t.rhea.home, 'screens'));
  assert.equal(shot.width, 1440);
  await assert.rejects(t.call(t.ada.id, 'app_screenshot', {}), e => status(e) === 403);
});
