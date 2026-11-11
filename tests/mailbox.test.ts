import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { Agent, AgentTask, Conversation, PeerMessage } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { Mailbox, deliveryPrompt } from '../server/comms/mailbox.ts';
import { HttpError } from '../server/errors.ts';
import { Store } from '../server/store.ts';
import { settle, tempDir } from './helpers.ts';

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id.toUpperCase(), engine: 'claude', projectIds: ['p1'], worktree: null, home: `/tmp/podcode-test/agents/${id}`, dreaming: true, model: '', effort: '',
    autonomy: 'edits', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
    currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
    costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null, ...overrides,
  };
}

function setup(agents: Agent[], settings = {}) {
  const store = new Store(path.join(tempDir('mailbox'), 'data'));
  store.load();
  store.settings = { ...DEFAULT_SETTINGS, ...settings };
  for (const a of agents) store.agents.set(a.id, a);
  const busy = new Set<string>();
  const delivered: { agentId: string; text: string; task: AgentTask }[] = [];
  const changes: PeerMessage[] = [];
  const conversations: Conversation[] = [];
  const mailbox = new Mailbox(store, {
    ready: id => !busy.has(id),
    send: (agentId, text, task) => { busy.add(agentId); delivered.push({ agentId, text, task }); },
    changed: message => changes.push({ ...message }),
    conversationChanged: conversation => conversations.push({ ...conversation }),
  });
  return { store, mailbox, busy, delivered, changes, conversations };
}

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

test('send returns a queued receipt before delivery starts', async () => {
  const { mailbox, delivered } = setup([agent('a'), agent('b')]);
  const receipt = mailbox.send('a', 'b', 'Please review src/app.ts');
  assert.equal(receipt.status, 'queued');
  assert.equal(delivered.length, 0, 'delivery must not start inside the tool call');
  await settle();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].agentId, 'b');
  assert.equal(delivered[0].task.source, 'agent');
  assert.equal(delivered[0].task.messageId, receipt.id);
  assert.match(delivered[0].text, new RegExp(`message_id ${receipt.id}`));
  assert.equal(receipt.status, 'delivering');
});

test('a recipient handles one peer message at a time', async () => {
  const { mailbox, delivered, busy } = setup([agent('a'), agent('b'), agent('c')]);
  mailbox.send('a', 'c', 'first');
  mailbox.send('b', 'c', 'second');
  await settle();
  assert.equal(delivered.length, 1);
  busy.delete('c');
  mailbox.finish('c', true);
  mailbox.drain('c');
  await settle();
  assert.equal(delivered.length, 2);
  assert.match(delivered[1].text, /second/);
});

test('finish marks the active message delivered or failed', async () => {
  const { mailbox, store } = setup([agent('a'), agent('b')]);
  const message = mailbox.send('a', 'b', 'hello');
  await settle();
  mailbox.finish('b', false, 'boom');
  assert.equal(store.messages.find(m => m.id === message.id)?.status, 'failed');
  assert.equal(store.messages.find(m => m.id === message.id)?.error, 'boom');
});

test('the conversation budget caps messages, replies included', async () => {
  const { mailbox, busy } = setup([agent('a'), agent('b')], { messageLimit: 2 });
  const first = mailbox.send('a', 'b', 'one');
  await settle();
  // b is handling the message; its reply joins the same conversation.
  const reply = mailbox.reply('b', first.id, 'two');
  assert.equal(reply.conversationId, first.conversationId);
  busy.delete('b');
  assert.throws(() => mailbox.reply('b', first.id, 'three'), e => status(e) === 409);
});

test('only the recipient can reply, and only to the sender', async () => {
  const { mailbox } = setup([agent('a'), agent('b'), agent('c')]);
  const message = mailbox.send('a', 'b', 'question');
  assert.throws(() => mailbox.reply('c', message.id, 'not mine'), e => status(e) === 403);
  assert.throws(() => mailbox.reply('a', message.id, 'my own'), e => status(e) === 403);
});

test('awareness settings limit who can be messaged', () => {
  const same = setup([agent('a'), agent('b', { projectIds: ['p2'] })], { awareness: 'project' });
  assert.deepEqual(same.mailbox.teammates('a'), []);
  assert.throws(() => same.mailbox.send('a', 'b', 'hi'), e => status(e) === 403);

  const off = setup([agent('a'), agent('b')], { awareness: 'off' });
  assert.deepEqual(off.mailbox.teammates('a'), []);
  assert.throws(() => off.mailbox.send('a', 'b', 'hi'), e => status(e) === 403);

  const all = setup([agent('a'), agent('b', { projectIds: ['p2'] })], { awareness: 'all' });
  assert.equal(all.mailbox.teammates('a').length, 1);
  assert.equal(all.mailbox.send('a', 'b', 'hi').status, 'queued');
});

test('teammates hide current tasks when activity sharing is off', () => {
  const { mailbox } = setup([agent('a'), agent('b', { currentTask: { summary: 'secret', source: 'user' }, activity: 'Editing x' })], { shareActivity: false });
  const [b] = mailbox.teammates('a');
  assert.equal(b.currentTask, undefined);
  assert.equal(b.activity, undefined);
});

test('read-only agents are told they cannot start messages', () => {
  const { mailbox } = setup([agent('a', { autonomy: 'readonly' }), agent('b')]);
  assert.equal(mailbox.teammates('a')[0].canMessage, false);
});

test('only a lead can delegate, and reports are validated', async () => {
  const { mailbox } = setup([agent('lead', { role: 'lead' }), agent('dev'), agent('tester', { role: 'tester' })]);
  const delegation = { kind: 'validation' as const, task: 'Validate login', acceptanceCriteria: 'Login works' };
  assert.throws(() => mailbox.delegate('dev', 'tester', delegation), e => status(e) === 403);
  const request = mailbox.delegate('lead', 'tester', delegation);
  assert.equal(request.delegation?.kind, 'validation');
  await settle();
  assert.throws(() => mailbox.report('tester', request.id, { outcome: 'done', summary: 's', evidence: 'e' }), e => status(e) === 400);
  assert.throws(() => mailbox.report('dev', request.id, { outcome: 'passed', summary: 's', evidence: 'e' }), e => status(e) === 403);
  const report = { outcome: 'passed' as const, summary: 'All good', evidence: 'npm test: 12 passed' };
  const receipt = mailbox.report('tester', request.id, report);
  assert.equal(receipt.toAgentId, 'lead');
  assert.equal(mailbox.report('tester', request.id, report).id, receipt.id, 'an identical report reuses its receipt');
  const [tracked] = mailbox.delegations('lead');
  assert.equal(tracked.state, 'passed');
});

test('stop cancels queued mail and pauses the agent until a user task', async () => {
  const { mailbox, store, delivered } = setup([agent('a'), agent('b'), agent('c'), agent('d')]);
  const first = mailbox.send('a', 'b', 'one');
  await settle();
  const queued = mailbox.send('c', 'b', 'two');
  mailbox.stop('b');
  assert.equal(store.messages.find(m => m.id === first.id)?.status, 'cancelled');
  assert.equal(store.messages.find(m => m.id === queued.id)?.status, 'cancelled');
  assert.throws(() => mailbox.send('a', 'b', 'again'), e => status(e) === 409);
  // The stopped collaboration stays closed for its senders; a new task starts a new one.
  assert.throws(() => mailbox.send('a', 'c', 'more'), e => status(e) === 409);
  mailbox.userTask('b');
  assert.equal(mailbox.send('d', 'b', 'again').status, 'queued');
  assert.equal(delivered.length, 1);
});

test('recover keeps unfinished mail: queued stays queued, mid-delivery goes once more, marked; a second restart fails it', () => {
  const { store, mailbox } = setup([agent('a'), agent('b')]);
  store.conversations.push(
    { id: 'c1', startedBy: 'a', messageLimit: 12, stopped: false, createdAt: 0 },
    { id: 'c2', startedBy: 'a', messageLimit: 12, stopped: false, createdAt: 0 },
  );
  store.messages.push(
    { id: 'm1', conversationId: 'c1', fromAgentId: 'a', fromName: 'A', toAgentId: 'b', toName: 'B', text: 'x', expectsReply: true, ts: 0, status: 'queued' },
    { id: 'm2', conversationId: 'c1', fromAgentId: 'a', fromName: 'A', toAgentId: 'b', toName: 'B', text: 'y', expectsReply: true, ts: 0, status: 'delivering' },
    { id: 'm3', conversationId: 'c2', fromAgentId: 'a', fromName: 'A', toAgentId: 'b', toName: 'B', text: 'z', expectsReply: true, ts: 0, status: 'delivered' },
  );
  mailbox.recover();
  assert.deepEqual(store.messages.map(m => [m.status, m.redelivered ?? false]), [['queued', false], ['queued', true], ['delivered', false]]);
  assert.equal(store.conversations[0].stopped, false, 'mail still to go keeps its conversation open');
  assert.equal(store.conversations[1].stopped, true, 'one with nothing left ends, as before');
  assert.match(deliveryPrompt(store.messages[1]), /^Redelivered after PodCode restarted/);
  assert.doesNotMatch(deliveryPrompt(store.messages[0]), /Redelivered/);
  // Interrupted again while being redelivered: it fails rather than loop.
  store.messages[1].status = 'delivering';
  mailbox.recover();
  assert.equal(store.messages[1].status, 'failed');
  assert.match(store.messages[1].error!, /restarted twice/);
});

test('delivery prompts frame peer text as context with the reply instructions', () => {
  const prompt = deliveryPrompt({ id: 'm1', conversationId: 'c', fromAgentId: 'a', fromName: 'Ada', toAgentId: 'b', toName: 'Bo', text: 'Run the tests', expectsReply: true, ts: 0, status: 'delivering' });
  assert.match(prompt, /not a new instruction from the user/);
  assert.match(prompt, /reply tool with message_id m1/);
  assert.match(prompt, /Run the tests$/);
});
