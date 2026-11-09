import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, Approval, SuperAsk } from '../shared/types.ts';
import { agentsSummary, approvalWords, needsYou, railAgentTask } from '../web/sidebar/agentRail.ts';

const agent = (id: string, fields: Partial<Agent> = {}): Agent => ({ id, name: id, status: 'idle', activity: '', lastActiveAt: 0, currentTask: null, ...fields }) as Agent;
const approval = (id: string, agentId: string, createdAt: number, fields: Partial<Approval> = {}): Approval => ({ id, agentId, createdAt, type: 'tool', toolName: 'Bash', title: 'Run npm test?', detail: '', description: '', canAlwaysAllow: false, ...fields }) as Approval;

test('an approval reads as words after the agent\'s name', () => {
  assert.equal(approvalWords({ type: 'tool', title: 'Run npm publish?' }), 'wants to run npm publish');
  assert.equal(approvalWords({ type: 'tool', title: 'Use github create_issue?' }), 'wants to use github create_issue');
  // An all-caps or odd opening is left as written.
  assert.equal(approvalWords({ type: 'tool', title: 'URL fetch?' }), 'wants to URL fetch');
  assert.equal(approvalWords({ type: 'tool', title: '' }), 'needs your OK');
  assert.equal(approvalWords({ type: 'plan', title: 'Plan ready' }), 'has a plan for your OK');
  assert.equal(approvalWords({ type: 'question', title: 'Question', questions: [{ question: 'Which staging URL?', header: '', options: [], multiSelect: false }] }), 'asks: Which staging URL?');
  assert.equal(approvalWords({ type: 'question', title: 'Pick one' }), 'asks: Pick one');
});

test('Needs you lists approvals, the SuperAgent\'s open asks and waiting agents, the longest wait first', () => {
  const agents = [agent('fen'), agent('kai', { status: 'waiting', activity: 'Waiting for approval', lastActiveAt: 1 }), agent('boss', { name: 'SuperAgent' }), agent('zed', { status: 'waiting', lastActiveAt: 5 }), agent('ada', { status: 'working' })];
  const asks = [{ id: 'a1', question: 'Merge feat/dark-mode?', createdAt: 20 }, { id: 'a2', question: 'Old one', createdAt: 2, answeredAt: 3 }] as SuperAsk[];
  const list = needsYou({ agents, approvals: [approval('p1', 'fen', 30), approval('p2', 'kai', 10, { title: 'Edit app.ts?' })], asks, superId: 'boss' });
  assert.deepEqual(list.shown.map(i => [i.who, i.what]), [
    ['zed', 'is waiting for you'],
    ['kai', 'wants to edit app.ts'],
    ['SuperAgent', 'asks: Merge feat/dark-mode?'],
    ['fen', 'wants to run npm test'],
  ]);
  // kai's approval covers kai: the agent is not listed a second time for being in "waiting".
  assert.equal(list.total, 4);
  assert.equal(list.more, 0);
  assert.equal(new Set(list.shown.map(i => i.key)).size, 4);
});

test('Needs you folds what does not fit into a count, and is empty when nothing waits', () => {
  const agents = [agent('a'), agent('b'), agent('c')];
  const approvals = [approval('1', 'a', 1), approval('2', 'b', 2), approval('3', 'c', 3), approval('4', 'a', 4), approval('5', 'gone', 0)];
  const list = needsYou({ agents, approvals, asks: [], superId: null }, 3);
  // An approval whose agent was removed is not listed.
  assert.deepEqual([list.shown.map(i => i.key), list.more, list.total], [['approval:1', 'approval:2', 'approval:3'], 1, 4]);
  assert.deepEqual(needsYou({ agents, approvals: [], asks: [{ id: 'x', question: 'q', createdAt: 1 } as SuperAsk], superId: null }), { shown: [], more: 0, total: 0 });
});

test('a folded section, a project row and a rail icon say how many need you, or that one works', () => {
  const agents = [agent('a', { status: 'working' }), agent('b', { status: 'waiting' }), agent('c')];
  assert.deepEqual(agentsSummary(agents, new Set(['c'])), { needsYou: 2, working: true });
  // A working agent with an approval pending is waiting on you, not working.
  assert.deepEqual(agentsSummary([agent('a', { status: 'working' })], new Set(['a'])), { needsYou: 1, working: false });
  assert.deepEqual(agentsSummary([], new Set()), { needsYou: 0, working: false });
});

test('an agent row takes a second line only while the agent is active and has something to say', () => {
  const task = { summary: 'Fix the build' } as Agent['currentTask'];
  assert.equal(railAgentTask(agent('a', { status: 'working', currentTask: task }), false), 'Fix the build');
  assert.equal(railAgentTask(agent('a', { status: 'working', currentTask: task }), false, 'SuperAgent'), 'from SuperAgent: Fix the build');
  assert.equal(railAgentTask(agent('a', { status: 'working', activity: 'Reading files' }), false), 'Reading files');
  assert.equal(railAgentTask(agent('a', { status: 'idle', currentTask: task }), true), 'Fix the build');
  // Idle, done or failed: one line again, whatever it last worked on.
  assert.equal(railAgentTask(agent('a', { status: 'idle', currentTask: task }), false), null);
  assert.equal(railAgentTask(agent('a', { status: 'done', currentTask: task }), false), null);
  assert.equal(railAgentTask(agent('a', { status: 'working' }), false), null);
});
