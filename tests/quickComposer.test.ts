import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, CreateAgentRequest, SuperState } from '../shared/types.ts';
import { answerQuick, newAgentName, sendQuick, STUCK_MS, targetAgentId, teamStatus, type QuickApi } from '../web/quick/route.ts';
import { harness, projectDir, settle } from './helpers.ts';

const agent = (over: Partial<Agent>): Agent => ({
  id: 'a1', name: 'Ada', engine: 'claude', projectId: null, worktree: null, home: '/h', dreaming: true, model: '', effort: '', autonomy: 'edits', useMcp: false,
  role: 'dev', instructions: '', status: 'idle', activity: '', currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null,
  unread: false, costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null, ...over,
});

/** A fake api that records every call. */
function fakeApi() {
  const calls: unknown[][] = [];
  const api: QuickApi = {
    send: async (id, text) => { calls.push(['send', id, text]); },
    createSuper: async () => { calls.push(['createSuper']); return agent({ id: 'sup-new', name: 'SuperAgent', role: 'super' }); },
    createAgent: async (input: CreateAgentRequest) => { calls.push(['createAgent', input]); return agent({ id: 'new-1', name: input.name }); },
    answerSuper: async (askId, body) => { calls.push(['answerSuper', askId, body]); return { agentId: null, asks: [], log: [] } satisfies SuperState; },
  };
  return { api, calls };
}

test('a quick message goes to the SuperAgent by default, setting it up first when there is none', async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await sendQuick({ kind: 'super' }, '  What is everyone on?  ', { agents: [], superId: 'sup' }, api), { agentId: 'sup', created: false });
  assert.deepEqual(calls, [['send', 'sup', 'What is everyone on?']]);
  calls.length = 0;
  assert.deepEqual(await sendQuick({ kind: 'super' }, 'Hello', { agents: [], superId: null }, api), { agentId: 'sup-new', created: true });
  assert.deepEqual(calls, [['createSuper'], ['send', 'sup-new', 'Hello']]);
  await assert.rejects(sendQuick({ kind: 'super' }, '   ', { agents: [], superId: 'sup' }, api), /Write something/);
});

test('to an existing agent it is a message; to one that is gone it is refused', async () => {
  const { api, calls } = fakeApi();
  const ada = agent({ id: 'ada' });
  assert.deepEqual(await sendQuick({ kind: 'agent', agentId: 'ada' }, 'Fix the header', { agents: [ada], superId: null }, api), { agentId: 'ada', created: false });
  assert.deepEqual(calls, [['send', 'ada', 'Fix the header']]);
  await assert.rejects(sendQuick({ kind: 'agent', agentId: 'gone' }, 'Hi', { agents: [ada], superId: null }, api), /gone/);
});

test('to a new agent in a project it creates one with the first free name, the engine and model, and the message as its task', async () => {
  const { api, calls } = fakeApi();
  const result = await sendQuick({ kind: 'new', projectId: 'web', engine: 'codex', model: 'gpt-6' }, 'Add dark mode', { agents: [agent({ name: 'Ada' }), agent({ id: 'b', name: 'bo' })], superId: null }, api);
  assert.deepEqual(result, { agentId: 'new-1', created: true });
  assert.deepEqual(calls, [['createAgent', { name: 'Cy', engine: 'codex', projectId: 'web', role: 'dev', model: 'gpt-6', task: 'Add dark mode' }]]);
  calls.length = 0;
  await sendQuick({ kind: 'new', projectId: null, engine: 'claude', model: '' }, 'Look around', { agents: [], superId: null }, api);
  assert.deepEqual(calls, [['createAgent', { name: 'Ada', engine: 'claude', projectId: null, role: 'dev', task: 'Look around' }]], 'no model means the default');
  assert.equal(newAgentName(['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fen', 'Gus', 'Hal', 'Ivy', 'Jun', 'Kai', 'Lux', 'Mo', 'Nia', 'Oz', 'Pia', 'Quin', 'Rae', 'Sol', 'Tam', 'Uma', 'Vic', 'Wren', 'Xan'].map(name => ({ name }))), 'Agent 2');
});

test('a question is answered with a choice, or put aside', async () => {
  const { api, calls } = fakeApi();
  await answerQuick(api, 'q1', 'Merge it');
  await answerQuick(api, 'q2', null);
  assert.deepEqual(calls, [['answerSuper', 'q1', { answer: 'Merge it' }], ['answerSuper', 'q2', { dismiss: true }]]);
});

test('the team strip: who needs you first, then stuck, working, failed, done and idle; never the SuperAgent', () => {
  const now = 10 * STUCK_MS;
  const team = teamStatus([
    agent({ id: 's', name: 'SuperAgent', role: 'super', status: 'working' }),
    agent({ id: '1', name: 'Idle', status: 'idle' }),
    agent({ id: '2', name: 'Busy', status: 'working', activity: 'Running tests', turnStartedAt: now - 60_000 }),
    agent({ id: '3', name: 'Long', status: 'working', turnStartedAt: now - STUCK_MS - 1 }),
    agent({ id: '4', name: 'Asks', status: 'working' }),
    agent({ id: '5', name: 'Broke', status: 'error', error: 'Rate limited' }),
    agent({ id: '6', name: 'Done', status: 'done', lastSummary: 'Shipped it.' }),
  ], [{ agentId: '4' }], now);
  assert.deepEqual(team.map(m => [m.name, m.state]), [['Asks', 'needs-you'], ['Long', 'stuck'], ['Busy', 'working'], ['Broke', 'failed'], ['Done', 'done'], ['Idle', 'idle']]);
  assert.equal(team.find(m => m.name === 'Busy')!.detail, 'Running tests');
  assert.equal(team.find(m => m.name === 'Done')!.detail, 'Shipped it.');
  assert.equal(targetAgentId({ kind: 'super' }, 'sup'), 'sup');
  assert.equal(targetAgentId({ kind: 'new', projectId: null, engine: 'claude', model: '' }, 'sup'), null);
});

test('end to end against the server: each target, and answering a question from the window', async () => {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const api: QuickApi = {
    send: async (id, text) => h.manager.send(id, text),
    createSuper: () => h.manager.createSuper(),
    createAgent: input => h.manager.create(input),
    answerSuper: async (askId, body) => h.manager.answerSuper(askId, body),
  };
  const team = () => ({ agents: [...h.store.agents.values()], superId: h.manager.superId() });

  const toSuper = await sendQuick({ kind: 'super' }, 'Who is free?', team(), api);
  assert.equal(h.store.agents.get(toSuper.agentId)!.role, 'super', 'set up on the way');
  await settle();
  assert.ok(h.store.readEntries(toSuper.agentId).some(e => e.kind === 'user' && e.text === 'Who is free?'));

  await sendQuick({ kind: 'agent', agentId: ada.id }, 'Fix the header', team(), api);
  assert.ok(h.store.readEntries(ada.id).some(e => e.kind === 'user' && e.text === 'Fix the header'));

  const fresh = await sendQuick({ kind: 'new', projectId: web.id, engine: 'claude', model: '' }, 'Write the release notes', team(), api);
  const made = h.store.agents.get(fresh.agentId)!;
  assert.equal(made.name, 'Bo');
  assert.equal(made.projectId, web.id);
  await settle();
  assert.ok(h.store.readEntries(made.id).some(e => e.kind === 'user' && e.text === 'Write the release notes'));

  // The SuperAgent asks; the window answers.
  const runner = h.runner(toSuper.agentId);
  const { asked } = await h.manager.commsTool(runner.ctx.commsToken!, 'ask_user', { question: 'Merge Ada\'s branch?', options: ['Merge it', 'Not yet'] }) as { asked: { id: string } };
  await answerQuick(api, asked.id, 'Not yet');
  assert.equal(h.manager.superView().asks.find(a => a.id === asked.id)!.answer, 'Not yet');
  assert.ok(h.store.readEntries(toSuper.agentId).some(e => e.kind === 'user' && e.text === 'Not yet'));
});
