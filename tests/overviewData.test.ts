import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeRunner } from '../server/agents/claude.ts';
import { CodexRunner } from '../server/agents/codex.ts';
import { claudePlanSteps, codexPlanSteps } from '../server/agents/plan.ts';
import type { RunnerHooks } from '../server/agents/runner.ts';
import { agentProduced } from '../server/produced.ts';
import type { Agent, AgentPlan, PeerMessage, WalkthroughSummary } from '../shared/types.ts';
import { gitEnv, harness, projectDir, settle, tempDir } from './helpers.ts';

// ACH-73 (ACH-D98): the Overview's data. A plan is only what the engine reported; produced work is
// read from git, walkthroughs and reports, and nothing is attributed from a shared checkout.

const baseAgent: Agent = {
  id: 'a1', name: 'Ada', engine: 'claude', projectIds: ['p1'], worktree: null, home: '/tmp/podcode-test/agents/a1', dreaming: false, model: '', effort: '',
  autonomy: 'ask', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
  currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
  costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
};
type Reported = { steps: AgentPlan['steps']; engine: AgentPlan['engine'] } | null;
function planHooks(plans: Reported[]): RunnerHooks {
  return {
    session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {},
    approval: async () => ({ allow: true }), closed: () => {}, plan: plan => plans.push(plan),
  };
}

test('Claude todos: completed is done, in_progress is active, anything else pending; no text, no step', () => {
  assert.deepEqual(claudePlanSteps({ todos: [
    { content: 'Read the code', status: 'completed', activeForm: 'Reading' },
    { content: 'Write the fix', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' },
    { content: 'Odd status', status: 'whatever' },
    { content: '  ', status: 'completed' },
    { status: 'pending' },
    'not a todo',
  ] }), [
    { text: 'Read the code', status: 'done' },
    { text: 'Write the fix', status: 'active' },
    { text: 'Run the tests', status: 'pending' },
    { text: 'Odd status', status: 'pending' },
  ]);
  for (const junk of [undefined, null, {}, { todos: 'x' }, []]) assert.deepEqual(claudePlanSteps(junk), []);
});

test('Codex plan: completed is done, everything else pending, never active', () => {
  assert.deepEqual(codexPlanSteps([{ text: 'Plan', completed: true }, { text: 'Build', completed: false }, { text: 'Ship' }, { completed: true }]), [
    { text: 'Plan', status: 'done' }, { text: 'Build', status: 'pending' }, { text: 'Ship', status: 'pending' },
  ]);
  assert.deepEqual(codexPlanSteps(undefined), []);
});

test('the Claude runner reports its main loop\'s TodoWrite as the plan, not a helper\'s', async () => {
  const plans: Reported[] = [];
  const fake = (() => {
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      yield { type: 'assistant', uuid: 'h1', parent_tool_use_id: 'task-1', message: { content: [{ type: 'tool_use', id: 't0', name: 'TodoWrite', input: { todos: [{ content: 'Helper step', status: 'pending' }] } }] } };
      yield { type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Fix it', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] } }] } };
      yield { type: 'assistant', uuid: 'u2', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [] } }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0 };
      await new Promise(() => {});
    }
    return Object.assign(run(), { interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {}, applyFlagSettings: async () => {}, close: () => {} });
  }) as unknown as typeof query;
  const runner = new ClaudeRunner({ agent: () => baseAgent, project: null, cwd: '/tmp', binPath: '/usr/local/bin/claude', hooks: planHooks(plans) }, fake);
  runner.send('Go');
  await settle(10);
  assert.deepEqual(plans, [
    { steps: [{ text: 'Fix it', status: 'active' }, { text: 'Test it', status: 'pending' }], engine: 'claude' },
    null,
  ], 'the helper\'s todos are not the plan; an emptied list clears it');
  runner.close();
});

test('the Codex runner reports its todo_list as the plan', async () => {
  const dir = tempDir('codex-plan');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh
cat > /dev/null
echo '{"type":"thread.started","thread_id":"thread-1"}'
echo '{"type":"item.completed","item":{"id":"p1","type":"todo_list","items":[{"text":"Read","completed":true},{"text":"Change","completed":false}]}}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Done."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`, { mode: 0o755 });
  const plans: Reported[] = [];
  const runner = new CodexRunner({ agent: () => ({ ...baseAgent, engine: 'codex' }), project: null, cwd: dir, binPath: bin, hooks: planHooks(plans) });
  runner.send('Go');
  for (let i = 0; i < 200 && runner.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(plans.at(-1), { steps: [{ text: 'Read', status: 'done' }, { text: 'Change', status: 'pending' }], engine: 'codex' });
});

test('on the agent: a reported plan is kept after the turn, cleared by the next turn and a new session; none is made up', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  const cy = await h.manager.create({ name: 'Cy', engine: 'codex', projectId: project.id });
  const live = (id: string) => h.store.agents.get(id)!;

  h.manager.send(ada.id, 'Fix it');
  const runner = h.runner(ada.id);
  assert.equal(live(ada.id).plan, null, 'a turn starts with no plan');
  runner.ctx.hooks.plan!({ steps: [{ text: 'Fix', status: 'active' }], engine: 'claude' });
  const plan = live(ada.id).plan!;
  assert.deepEqual(plan.steps, [{ text: 'Fix', status: 'active' }]);
  assert.equal(plan.engine, 'claude');
  assert.ok(plan.updatedAt > 0);
  runner.complete();
  await settle();
  assert.deepEqual(live(ada.id).plan?.steps, [{ text: 'Fix', status: 'active' }], 'kept after the turn, as last reported');

  h.manager.send(ada.id, 'Next thing');
  assert.equal(live(ada.id).plan, null, 'the next turn does not inherit it');
  runner.ctx.hooks.plan!({ steps: [{ text: 'Again', status: 'pending' }], engine: 'claude' });
  runner.ctx.hooks.plan!(null);
  assert.equal(live(ada.id).plan, null, 'an emptied list clears it');
  runner.ctx.hooks.plan!({ steps: [{ text: 'Again', status: 'pending' }], engine: 'claude' });
  runner.complete();
  await settle();
  await h.manager.newSession(ada.id);
  assert.equal(live(ada.id).plan, null, 'a new session clears it');

  h.manager.send(cy.id, 'Go');
  h.runner(cy.id).complete();
  await settle();
  assert.ok(!live(cy.id).plan, 'a turn that reports no plan has none');
});

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
  assert.deepEqual(out.uncommitted, { files: 2, added: 2, removed: 0 }, 'a.txt and new.txt; the node_modules link is not a change');
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
