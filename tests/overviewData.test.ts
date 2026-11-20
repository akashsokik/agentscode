import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentProduced, PRODUCED_TTL_MS, ProducedCache } from '../server/produced.ts';
import { readGit, type GitRunner } from '../server/work.ts';
import type { Agent, PeerMessage, WalkthroughSummary } from '../shared/types.ts';
import { gitEnv, tempDir } from './helpers.ts';

// ACH-73 (ACH-D98, ACH-D100): the Overview's produced work, read from git, walkthroughs and
// reports; nothing is attributed from a shared checkout. There are no plan steps (ACH-D100).

const baseAgent: Agent = {
  id: 'a1', name: 'Ada', engine: 'claude', projectIds: ['p1'], worktree: null, home: '/tmp/podcode-test/agents/a1', dreaming: false, model: '', effort: '',
  autonomy: 'ask', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
  currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
  costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repo() {
  const dir = tempDir('produced');
  const main = path.join(dir, 'app');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'Base');
  const home = path.join(dir, 'home');
  const wt = path.join(home, 'workspace', 'feat');
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  fs.writeFileSync(path.join(wt, 'b.txt'), 'two\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'Add b (X-1)');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'one\nmore\nlines\n');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n');
  fs.symlinkSync(main, path.join(wt, 'node_modules'));
  return { dir, main, home, wt };
}

const message = (over: Partial<PeerMessage>): PeerMessage => ({
  id: 'm', conversationId: 'c', fromAgentId: 'a1', fromName: 'Ada', toAgentId: 's', toName: 'Lead', text: '', expectsReply: false, ts: 1, status: 'delivered', ...over,
});

test('produced: its own worktree\'s commits and changes, its walkthroughs and reports, each with its time', async () => {
  const { home, wt } = repo();
  const agent: Agent = { ...baseAgent, workingIn: { projectId: 'p1', root: wt, branch: 'feat/x', at: 1 } };
  const walkthroughs = [
    { id: 'w1', agentId: 'a1', agentName: 'Ada', title: 'Older', summary: '', stepCount: 1, createdAt: 10, projectId: null, branch: null, commit: null },
    { id: 'w2', agentId: 'a1', agentName: 'Ada', title: 'Newer', summary: '', stepCount: 1, createdAt: 20, projectId: 'p1', branch: 'feat/x', commit: 'abc' },
  ] satisfies WalkthroughSummary[];
  const messages = [
    message({ id: 'r1', ts: 5, report: { outcome: 'passed', summary: 'Tests pass.', evidence: 'npm test' } }),
    message({ id: 'r2', ts: 9, report: { outcome: 'blocked', summary: 'x'.repeat(400), evidence: '' } }),
    message({ id: 'plain', ts: 7, text: 'Just a message' }),
    message({ id: 'other', fromAgentId: 'b2', ts: 8, report: { outcome: 'done', summary: 'Not hers.', evidence: '' } }),
  ];
  const out = await agentProduced({ agent, home, messages, walkthroughs, now: 42 });
  assert.equal(out.at, 42);
  assert.deepEqual(out.where, { folder: wt, branch: 'feat/x', own: true });
  assert.deepEqual(out.commits.map(c => c.subject), ['Add b (X-1)'], 'only the branch\'s own commits, not main\'s');
  assert.match(out.commits[0].hash, /^[0-9a-f]{40}$/);
  assert.ok(out.commits[0].at > 1_000_000_000_000, 'in milliseconds');
  assert.deepEqual(out.uncommitted, { files: 2, added: 3, removed: 0 }, 'a.txt (+2) and new.txt (+1); the node_modules link is not a change');
  assert.deepEqual(out.walkthroughs, [{ id: 'w2', title: 'Newer', createdAt: 20, branch: 'feat/x', commit: 'abc' }, { id: 'w1', title: 'Older', createdAt: 10 }]);
  assert.deepEqual(out.reports.map(r => [r.messageId, r.outcome]), [['r2', 'blocked'], ['r1', 'passed']]);
  assert.equal(out.reports[0].summary.length, 300);
  assert.deepEqual(Object.keys(out.reports[1]).sort(), ['at', 'conversationId', 'messageId', 'outcome', 'summary', 'toAgentId', 'toName']);
});

test('produced: a PodCode worktree is its own and is measured from its base', async () => {
  const { home, wt, main } = repo();
  const agent: Agent = { ...baseAgent, home, worktree: { path: wt, cwd: wt, branch: 'feat/x', base: 'main', baseCommit: '', repoRoot: main, gitDir: path.join(main, '.git') } };
  const out = await agentProduced({ agent, home: null, messages: [], walkthroughs: [] });
  assert.equal(out.where?.own, true);
  assert.deepEqual(out.commits.map(c => c.subject), ['Add b (X-1)']);
});

test('produced: nothing is attributed from a shared project checkout', async () => {
  const { home, main } = repo();
  fs.writeFileSync(path.join(main, 'a.txt'), 'changed\n');
  const agent: Agent = { ...baseAgent, workingIn: { projectId: 'p1', root: main, branch: 'main', at: 1 } };
  const out = await agentProduced({ agent, home, messages: [], walkthroughs: [] });
  assert.deepEqual(out.where, { folder: main, branch: 'main', own: false });
  assert.deepEqual(out.commits, [], 'no commits from the user\'s checkout');
  assert.deepEqual(out.uncommitted, { files: 1, added: 1, removed: 1 }, 'a snapshot, marked not its own');
});

test('produced: absent data stays absent', async () => {
  const none = await agentProduced({ agent: baseAgent, home: null, messages: [], walkthroughs: [], now: 1 });
  assert.deepEqual(none, { at: 1, where: null, commits: [], uncommitted: null, walkthroughs: [], reports: [] });
  const plain = tempDir('produced-plain');
  const notGit = await agentProduced({ agent: { ...baseAgent, workingIn: { projectId: 'p1', root: plain, branch: null, at: 1 } }, home: null, messages: [], walkthroughs: [] });
  assert.deepEqual(notGit.where, { folder: plain, branch: null, own: false });
  assert.equal(notGit.uncommitted, null);
  const gone = await agentProduced({ agent: { ...baseAgent, workingIn: { projectId: 'p1', root: path.join(plain, 'missing'), branch: null, at: 1 } }, home: null, messages: [], walkthroughs: [] });
  assert.equal(gone.where, null);
});

test('produced is a read-only GET behind the app\'s own guards, and git runs through the hardened reader', () => {
  const app = fs.readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
  const guards = app.indexOf('app.use(userOnly(auth));');
  const route = app.indexOf("app.get('/api/agents/:id/produced'");
  assert.ok(guards > 0 && route > guards, 'registered after localOnly and userOnly');
  const source = fs.readFileSync(new URL('../server/produced.ts', import.meta.url), 'utf8');
  assert.match(source, /git = input\.git \?\? readGit/);
  assert.doesNotMatch(source, /execFile|spawn|gitRun/);
});

test('L1: new files count their lines, so a change never reads "+0"; binary ones count none', async () => {
  const { home, wt } = repo();
  git(wt, 'mv', 'b.txt', 'c.txt');
  fs.writeFileSync(path.join(wt, 'three.txt'), 'x\ny\nz');
  fs.writeFileSync(path.join(wt, 'blob.bin'), Buffer.concat([Buffer.alloc(8191, 10), Buffer.from([0, 10])]));
  fs.mkdirSync(path.join(wt, 'dir'));
  fs.writeFileSync(path.join(wt, 'dir', 'inner.txt'), 'in\n');
  const agent: Agent = { ...baseAgent, workingIn: { projectId: 'p1', root: wt, branch: 'feat/x', at: 1 } };
  const out = await agentProduced({ agent, home, messages: [], walkthroughs: [] });
  // a.txt +2; new.txt +1; three.txt +3 (no final newline); dir/inner.txt +1; blob.bin 0; the rename b -> c counts once.
  assert.deepEqual(out.uncommitted, { files: 6, added: 7, removed: 0 });
});

test('the untracked byte budget bounds line counting but keeps the full changed-file count', async () => {
  const { home, main } = repo();
  const contents = Buffer.alloc(1024 * 1024, 120);
  for (let i = 0; i < 17; i++) fs.writeFileSync(path.join(main, `file-${i}`), contents);
  const agent: Agent = { ...baseAgent, workingIn: { projectId: 'p1', root: main, branch: 'main', at: 1 } };
  const out = await agentProduced({ agent, home, messages: [], walkthroughs: [] });
  assert.deepEqual(out.uncommitted, { files: 17, added: 16, removed: 0 });
});

test('L2: an agent with its own worktree shows that worktree, even after it read the user\'s checkout', async () => {
  const { wt, main } = repo();
  const agent: Agent = {
    ...baseAgent,
    worktree: { path: wt, cwd: wt, branch: 'feat/x', base: 'main', baseCommit: '', repoRoot: main, gitDir: path.join(main, '.git') },
    workingIn: { projectId: 'p1', root: main, branch: 'main', at: 1 },
  };
  const out = await agentProduced({ agent, home: null, messages: [], walkthroughs: [] });
  assert.deepEqual(out.where, { folder: wt, branch: 'feat/x', own: true });
  assert.deepEqual(out.commits.map(c => c.subject), ['Add b (X-1)']);
});

test('L3: with no local base branch, origin\'s copy of it is the base', async () => {
  const { dir, main } = repo();
  const home = path.join(dir, 'home2');
  const clone = path.join(home, 'clone');
  fs.mkdirSync(home);
  git(dir, 'clone', '-q', main, clone);
  git(clone, 'checkout', '-q', '-b', 'feat/y');
  git(clone, 'branch', '-q', '-D', 'main');
  fs.writeFileSync(path.join(clone, 'y.txt'), 'y\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'Add y');
  const byDefault = await agentProduced({ agent: { ...baseAgent, workingIn: { projectId: 'p1', root: clone, branch: 'feat/y', at: 1 } }, home, messages: [], walkthroughs: [] });
  assert.deepEqual(byDefault.commits.map(c => c.subject), ['Add y'], 'origin/HEAD names main, found as origin/main');
  const wt = { path: clone, cwd: clone, branch: 'feat/y', base: 'main', baseCommit: '', repoRoot: clone, gitDir: path.join(clone, '.git') };
  const byWorktree = await agentProduced({ agent: { ...baseAgent, worktree: wt }, home: null, messages: [], walkthroughs: [] });
  assert.deepEqual(byWorktree.commits.map(c => c.subject), ['Add y'], 'a worktree base found as origin/main');
});

test('L4: the git half is read once per agent until the turn ends, the panel asks fresh, the folder changes or a minute passes', async () => {
  const { home, wt, main } = repo();
  let calls = 0;
  const counting: GitRunner = (args, cwd) => { calls++; return readGit(args, cwd); };
  const cache = new ProducedCache();
  const agent: Agent = { ...baseAgent, workingIn: { projectId: 'p1', root: wt, branch: 'feat/x', at: 1 } };
  const read = (over: { now?: number; fresh?: boolean; agent?: Agent; messages?: PeerMessage[] } = {}) =>
    agentProduced({ agent: over.agent ?? agent, home, messages: over.messages ?? [], walkthroughs: [], git: counting, cache, now: over.now ?? 1000, fresh: over.fresh });
  const first = await read();
  const used = calls;
  assert.ok(used > 0);
  const [a, b] = await Promise.all([read(), read()]);
  assert.equal(calls, used, 'reused, also by callers at the same time');
  assert.deepEqual(a.commits, first.commits);
  assert.deepEqual(b.uncommitted, first.uncommitted);
  const withReport = await read({ now: 1250, messages: [message({ id: 'r', ts: 2, report: { outcome: 'done', summary: 'New.', evidence: '' } })] });
  assert.equal(withReport.at, first.at, 'a cache hit keeps the time of the original git reading');
  assert.equal(withReport.reports.length, 1, 'reports are always current');
  assert.equal(calls, used, 'and cost no git');
  assert.equal((await read({ fresh: true, now: 1500 })).at, 1500);
  assert.equal(calls, used * 2, 'the panel opening reads again');
  cache.invalidate(agent.id);
  await read();
  assert.equal(calls, used * 3, 'a turn end reads again');
  await read({ now: 1000 + PRODUCED_TTL_MS });
  assert.equal(calls, used * 4, 'a minute later reads again');
  await read({ now: 1000 + PRODUCED_TTL_MS, agent: { ...agent, workingIn: { projectId: 'p1', root: main, branch: 'main', at: 2 } } });
  assert.ok(calls > used * 4, 'another folder is another reading');
  const manager = fs.readFileSync(new URL('../server/manager.ts', import.meta.url), 'utf8');
  assert.match(manager, /private onTurnEnd\(agentId: string, result: TurnResult\): void \{\n    this\.producedCache\.invalidate\(agentId\);/);
  const app = fs.readFileSync(new URL('../server/app.ts', import.meta.url), 'utf8');
  assert.match(app, /manager\.produced\(param\(req, 'id'\), req\.query\.fresh === '1'\)/);
});

test('ACH-D100: no plan steps are captured or sent for any agent', () => {
  assert.equal(fs.existsSync(new URL('../server/agents/plan.ts', import.meta.url)), false);
  const types = fs.readFileSync(new URL('../shared/types.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(types, /AgentPlan|PlanStep/);
  const agentType = types.slice(types.indexOf('export interface Agent {'), types.indexOf('\n}\n', types.indexOf('export interface Agent {')));
  assert.ok(agentType.length > 100);
  assert.doesNotMatch(agentType, /\bplan\?:/, 'the Agent has no plan field');
  for (const file of ['claude.ts', 'codex.ts', 'runner.ts', 'scoped.ts']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../server/agents/${file}`, import.meta.url), 'utf8'), /hooks\.plan|plan\?\(|PlanSteps/, file);
  }
});
