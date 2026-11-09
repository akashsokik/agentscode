import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation, PeerMessage } from '../shared/types.ts';
import {
  commsThreads, inFilter, isUnseen, markSeen, matchesQuery, messageKind, parseSeen, plainLine, STATE_LABEL, threadState, threadTitle, timelineTail,
} from '../web/comms.ts';

const T0 = new Date(2026, 10, 5, 9, 0, 0).getTime();
const MIN = 60_000;

const m = (msg: Partial<PeerMessage> & Pick<PeerMessage, 'id'>): PeerMessage => ({
  conversationId: 'c1', fromAgentId: 'ada', fromName: 'Ada', toAgentId: 'cy', toName: 'Cy',
  text: msg.id, expectsReply: true, ts: T0, status: 'delivered', ...msg,
});
const conv = (c: Partial<Conversation> & Pick<Conversation, 'id'>): Conversation => ({
  startedBy: 'ada', messageLimit: 12, stopped: false, createdAt: T0, ...c,
});

test('groups direct messages by conversation, newest activity first, each oldest first', () => {
  const threads = commsThreads([
    m({ id: 'a2', conversationId: 'a', ts: T0 + 2 * MIN }),
    m({ id: 'b1', conversationId: 'b', ts: T0 + 3 * MIN, fromAgentId: 'bo', fromName: 'Bo' }),
    m({ id: 'a1', conversationId: 'a', ts: T0 + MIN, fromAgentId: 'cy', toAgentId: 'ada' }),
  ], []);
  assert.deepEqual(threads.map(t => t.id), ['b', 'a']);
  assert.deepEqual(threads[1].messages.map(x => x.id), ['a1', 'a2'], 'sorted by time even when stored out of order');
  assert.deepEqual(threads[1].participants, ['cy', 'ada'], 'in order of first appearance');
  assert.equal(threads[1].lastTs, T0 + 2 * MIN);
});

test('channel mentions stay out of Comms', () => {
  const threads = commsThreads([m({ id: 'x', channelId: 'ch', postId: 'p' }), m({ id: 'y', conversationId: 'c2' })], []);
  assert.deepEqual(threads.map(t => t.id), ['c2']);
});

test('active means queued or working, and never once stopped', () => {
  const working = [m({ id: 'w', status: 'delivering' })];
  assert.equal(commsThreads(working, [conv({ id: 'c1' })])[0].active, true);
  assert.equal(commsThreads(working, [conv({ id: 'c1', stopped: true })])[0].active, false);
  assert.equal(commsThreads([m({ id: 'd' })], [])[0].active, false);
});

test('state: stopped beats everything, then working, queued, failure, report, handled', () => {
  const s = (messages: PeerMessage[], stopped = false) => threadState({ conversation: conv({ id: 'c1', stopped }), messages });
  assert.equal(s([m({ id: '1', status: 'delivering' })], true), 'stopped');
  assert.equal(s([m({ id: '1', status: 'queued' }), m({ id: '2', status: 'delivering' })]), 'working');
  assert.equal(s([m({ id: '1', status: 'queued' })]), 'queued');
  assert.equal(s([m({ id: '1' }), m({ id: '2', status: 'failed' })]), 'failed');
  const report = (outcome: 'passed' | 'failed' | 'blocked' | 'done') => m({ id: 'r', report: { outcome, summary: 's', evidence: 'e' } });
  assert.equal(s([report('blocked')]), 'blocked');
  assert.equal(s([report('failed')]), 'failed');
  assert.equal(s([report('passed'), m({ id: 'thanks' })]), 'done', 'a later note does not undo the outcome');
  // A review reads as the work it answers: changes needed is not a failure, a pass approves.
  const asked = m({ id: 'ask', delegation: { kind: 'review', task: 'Review it', acceptanceCriteria: '' } });
  const answer = (outcome: 'passed' | 'failed') => m({ id: 'r', replyTo: 'ask', report: { outcome, summary: 's', evidence: 'e' } });
  assert.equal(s([asked, answer('failed')]), 'changes');
  assert.equal(s([asked, answer('passed')]), 'approved');
  assert.equal(s([m({ id: 'r', text: 'REVIEW RESULT: FAILED', report: { outcome: 'failed', summary: 's', evidence: '' } })]), 'changes', 'known from its own text too');
  assert.equal(inFilter('changes', 'attention'), true);
  assert.equal(STATE_LABEL.changes, 'Changes needed');
  assert.equal(s([m({ id: '1' })]), 'handled');
  assert.equal(threadState({ conversation: undefined, messages: [m({ id: '1' })] }), 'handled');
});

test('filters: active holds work in flight, attention holds trouble', () => {
  assert.equal(inFilter('working', 'active'), true);
  assert.equal(inFilter('queued', 'active'), true);
  assert.equal(inFilter('done', 'active'), false);
  assert.equal(inFilter('failed', 'attention'), true);
  assert.equal(inFilter('blocked', 'attention'), true);
  assert.equal(inFilter('stopped', 'attention'), false);
  assert.equal(inFilter('stopped', 'all'), true);
});

test('plainLine keeps the first line of prose and drops its markdown', () => {
  assert.equal(plainLine('\n\n## Fix the **login** `redirect`\nmore'), 'Fix the login redirect');
  assert.equal(plainLine('- see [the docs](https://x.y)  now'), 'see the docs now');
  assert.equal(plainLine('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
  assert.equal(plainLine('   '), '');
});

test('title: a delegation names its task, a report its summary, otherwise the first words', () => {
  assert.equal(threadTitle({ messages: [m({ id: '1', text: 'ignored', delegation: { kind: 'review', task: 'Review the diff', acceptanceCriteria: 'ok' } })] }), 'Review the diff');
  assert.equal(threadTitle({ messages: [m({ id: '1', report: { outcome: 'passed', summary: 'All green', evidence: '' } })] }), 'All green');
  assert.equal(threadTitle({ messages: [m({ id: '1', text: '' }), m({ id: '2', text: 'Can you check CI?' })] }), 'Can you check CI?', 'skips empty messages');
  assert.equal(threadTitle({ messages: [m({ id: '1', text: ' ' })] }), 'Untitled conversation');
});

test('message kinds', () => {
  assert.equal(messageKind(m({ id: '1', report: { outcome: 'done', summary: '', evidence: '' } })), 'Report');
  assert.equal(messageKind(m({ id: '1', delegation: { kind: 'testing', task: 't', acceptanceCriteria: 'a' } })), 'Delegation');
  assert.equal(messageKind(m({ id: '1', replyTo: '0' })), 'Reply');
  assert.equal(messageKind(m({ id: '1' })), 'Request');
  assert.equal(messageKind(m({ id: '1', expectsReply: false })), 'Note');
});

test('search needs every word, across names and every part of a message', () => {
  const thread = { messages: [m({ id: '1', text: 'Fix the flaky test', report: { outcome: 'failed', summary: 'Timeout', evidence: 'npm test exited 1' } })] };
  assert.equal(matchesQuery(thread, ['Ada', 'Cy'], ''), true);
  assert.equal(matchesQuery(thread, ['Ada', 'Cy'], 'flaky ada'), true);
  assert.equal(matchesQuery(thread, ['Ada', 'Cy'], 'EXITED timeout'), true, 'case-insensitive, reaches the evidence');
  assert.equal(matchesQuery(thread, ['Ada', 'Cy'], 'flaky bo'), false);
});

test('timeline tail: who is working, a spent budget, then the stop', () => {
  const messages = [
    m({ id: '1', status: 'delivering' }),
    m({ id: '2', status: 'delivering' }),
    m({ id: '3', status: 'delivering', fromAgentId: 'cy', fromName: 'Cy', toAgentId: 'bo', toName: 'Bo' }),
  ];
  assert.deepEqual(timelineTail({ conversation: conv({ id: 'c1' }), messages }), [
    { kind: 'working', agentId: 'cy', name: 'Cy', forName: 'Ada' },
    { kind: 'working', agentId: 'bo', name: 'Bo', forName: 'Cy' },
  ], 'one stop per agent at work');
  assert.deepEqual(timelineTail({ conversation: conv({ id: 'c1', messageLimit: 3, stopped: true }), messages }), [
    { kind: 'budget', used: 3, limit: 3 },
    { kind: 'stopped' },
  ], 'nobody is working in a stopped conversation');
  assert.deepEqual(timelineTail({ conversation: conv({ id: 'c1', messageLimit: 0 }), messages: [m({ id: '1' })] }), [], 'unlimited never runs out');
});

test('seen: everything before the store began is read; opening marks up to the latest message', () => {
  const store = parseSeen(null, T0);
  const old = { id: 'old', lastTs: T0 - MIN };
  const fresh = { id: 'fresh', lastTs: T0 + MIN };
  assert.equal(isUnseen(old, store), false);
  assert.equal(isUnseen(fresh, store), true);
  const after = markSeen(store, [fresh, old]);
  assert.equal(isUnseen(fresh, after), false);
  assert.deepEqual(after.items, { fresh: T0 + MIN }, 'only what was unread is recorded');
  assert.equal(markSeen(after, [fresh]), after, 'unchanged store comes back as is');
  assert.equal(isUnseen({ id: 'fresh', lastTs: T0 + 2 * MIN }, after), true, 'a newer message makes it new again');
});

test('a stored seen record survives a round trip, and junk starts over', () => {
  const store = { since: T0, items: { a: T0 + MIN } };
  assert.deepEqual(parseSeen(JSON.stringify(store), T0 + 99), store);
  assert.deepEqual(parseSeen('{"since":1,"items":{"a":"x","b":2}}', T0), { since: 1, items: { b: 2 } });
  assert.deepEqual(parseSeen('not json', T0), { since: T0, items: {} });
  assert.deepEqual(parseSeen('[1]', T0), { since: T0, items: {} });
});
