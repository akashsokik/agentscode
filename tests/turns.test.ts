import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entry } from '../shared/types.ts';
import { groupTurns } from '../web/turns.ts';

let ts = 0;
const e = (entry: Partial<Entry> & Pick<Entry, 'id' | 'kind'>): Entry => ({ agentId: 'a', ts: ++ts, text: entry.id, ...entry });

test('a prompt queued mid-turn moves to the turn that runs it', () => {
  const entries = [
    e({ id: 'u1', kind: 'user' }),
    e({ id: 'm1', kind: 'turn', turn: { source: 'user', entryId: 'u1' } }),
    e({ id: 't1', kind: 'tool', tool: { name: 'Read', summary: 'a.ts', status: 'ok' } }),
    e({ id: 'u2', kind: 'user' }), // sent while the first turn ran
    e({ id: 'r1', kind: 'agent' }),
    e({ id: 'd1', kind: 'done' }),
    e({ id: 'm2', kind: 'turn', turn: { source: 'user', entryId: 'u2' } }),
    e({ id: 'r2', kind: 'agent' }),
  ];
  const { sections, queued } = groupTurns(entries, 'a');
  const turns = sections.flatMap(s => (s.type === 'turn' ? [s.turn] : []));
  assert.deepEqual(turns.map(t => t.prompt?.id), ['u1', 'u2']);
  assert.deepEqual(turns[0].items.map(i => i.id), ['t1', 'r1', 'd1'], 'the first turn keeps its own work');
  assert.deepEqual(turns[1].items.map(i => i.id), ['r2']);
  assert.deepEqual(queued, []);
});

test('prompts not started yet are queued, including teammate messages', () => {
  const peer = { id: 'p1', conversationId: 'c', fromAgentId: 'b', fromName: 'Bo', toAgentId: 'a', toName: 'Ada', text: 'hi', expectsReply: true, ts: 0, status: 'queued' as const };
  const entries = [
    e({ id: 'u1', kind: 'user' }),
    e({ id: 'm1', kind: 'turn', turn: { source: 'user', entryId: 'u1' } }),
    e({ id: 'u2', kind: 'user' }),
    e({ id: 'peer:p1', kind: 'peer', peer: peer }),
  ];
  const { queued } = groupTurns(entries, 'a');
  assert.deepEqual(queued.map(q => q.id), ['u2', 'peer:p1']);
});

test('a teammate message that started a turn is that turn\'s prompt', () => {
  const peer = { id: 'p1', conversationId: 'c', fromAgentId: 'b', fromName: 'Bo', toAgentId: 'a', toName: 'Ada', text: 'review', expectsReply: true, ts: 0, status: 'delivered' as const };
  const entries = [
    e({ id: 'peer:p1', kind: 'peer', peer }),
    e({ id: 'm1', kind: 'turn', turn: { source: 'agent', messageId: 'p1' } }),
    e({ id: 'r1', kind: 'agent' }),
  ];
  const { sections } = groupTurns(entries, 'a');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].type === 'turn' && sections[0].turn.prompt?.id, 'peer:p1');
});

test('history from before turn markers splits at user messages', () => {
  const entries = [
    e({ id: 's0', kind: 'system', sessionStart: true }),
    e({ id: 'u1', kind: 'user' }),
    e({ id: 'r1', kind: 'agent' }),
    e({ id: 'u2', kind: 'user' }),
    e({ id: 'r2', kind: 'agent' }),
  ];
  const { sections } = groupTurns(entries, 'a');
  assert.deepEqual(sections.map(s => (s.type === 'turn' ? s.turn.prompt?.id : `note:${s.entry.id}`)), ['note:s0', 'u1', 'u2']);
});
