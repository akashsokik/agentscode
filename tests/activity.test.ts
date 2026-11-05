import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entry, PeerMessage, ToolCall } from '../shared/types.ts';
import { foldableWork, groupTurnItems, turnItemKey, workKind, workSummaryLine, type TurnItem } from '../web/activity.ts';

let ts = 0;
const e = (entry: Partial<Entry> & Pick<Entry, 'id' | 'kind'>): Entry => ({ agentId: 'a', ts: ++ts, text: entry.id, ...entry });
const tool = (id: string, name: string, summary = '', status: ToolCall['status'] = 'ok') => e({ id, kind: 'tool', text: '', tool: { name, summary, status } });
const prose = (id: string) => e({ id, kind: 'agent', text: `${id} text` });
const peer = (id: string): Entry => {
  const message: PeerMessage = { id, conversationId: 'c', fromAgentId: 'a', fromName: 'Ada', toAgentId: 'b', toName: 'Bo', text: 'hi', expectsReply: false, ts: 0, status: 'delivered' };
  return e({ id: `peer:${id}`, kind: 'peer', peer: message });
};
const shape = (items: TurnItem[]) => items.map(item => `${item.type}:${item.type === 'prose' ? item.entry.id : item.entries.map(x => x.id).join('+')}`);

test('prose stands alone and runs of work between it become groups', () => {
  const items = groupTurnItems([
    tool('t1', 'Read', 'a.ts'),
    tool('t2', 'Grep', 'foo'),
    prose('p1'),
    tool('t3', 'Bash', 'npm test'),
    e({ id: 'd1', kind: 'done' }),
  ]);
  assert.deepEqual(shape(items), ['activity:t1+t2', 'prose:p1', 'activity:t3']);
  assert.equal(turnItemKey(items[0]), 't1', 'a group is keyed by its first step, so it keeps its identity as it grows');
});

test('sending tools are hidden without splitting the run they sit in', () => {
  const items = groupTurnItems([
    tool('t1', 'Read', 'a.ts'),
    tool('s1', 'mcp__agentscode__send_message', 'to Bo'),
    peer('m1'),
    tool('t2', 'Bash', 'ls'),
  ]);
  assert.deepEqual(shape(items), ['activity:t1+peer:m1+t2']);
});

test('errors, results and empty prose are not items', () => {
  const items = groupTurnItems([
    e({ id: 'p0', kind: 'agent', text: '   ' }),
    e({ id: 'x1', kind: 'error' }),
    e({ id: 'd1', kind: 'done' }),
  ]);
  assert.deepEqual(items, []);
});

test('the fold reaches the last group the agent has written past', () => {
  const live = groupTurnItems([tool('t1', 'Read', 'a.ts'), prose('p1'), tool('t2', 'Bash', 'ls')]);
  assert.deepEqual(foldableWork(live), { start: 0, end: 0 }, 'the work in flight stays in view');

  const settled = groupTurnItems([tool('t1', 'Read', 'a.ts'), prose('p1'), tool('t2', 'Bash', 'ls'), prose('p2')]);
  assert.deepEqual(foldableWork(settled), { start: 0, end: 2 }, 'only the answer is left outside');

  assert.equal(foldableWork(groupTurnItems([prose('p1')])), undefined, 'a plain reply has nothing to fold');
  assert.equal(foldableWork(groupTurnItems([tool('t1', 'Read', 'a.ts')])), undefined, 'unanswered work stays open');
});

test('the summary line counts what the work adds up to', () => {
  const steps = [
    tool('t1', 'Read', 'web/a.ts'),
    tool('t2', 'Read', 'web/b.ts'),
    tool('t3', 'Edit', 'web/a.ts'),
    tool('t4', 'Bash', 'npm test'),
    tool('t5', 'Bash', 'npm run build'),
    peer('m1'),
  ];
  assert.equal(workSummaryLine(steps), 'Read 2 files · Edited a.ts · Ran 2 commands · 1 message');
  assert.equal(workSummaryLine(steps, true), 'Read 2 files · Edited a.ts · Running 2 commands · 1 message', 'only the kind in flight is present tense');
  assert.equal(workSummaryLine([tool('t1', 'Edit', 'a.ts, b.ts')]), 'Edited 2 files', 'a Codex edit across files counts each file');
  assert.equal(workSummaryLine([tool('t1', 'Grep', 'x'), tool('t2', 'Read', 'a.ts')]), 'Explored the project');
  assert.equal(workSummaryLine([tool('t1', 'WebSearch', 'x')], true), 'Searching the web');
  assert.equal(workSummaryLine([e({ id: 's1', kind: 'system', text: 'Context compacted.' })]), 'Status update');
});

test('a group takes the icon of the work it did most of', () => {
  assert.equal(workKind([tool('t1', 'Read', 'a'), tool('t2', 'Read', 'b'), tool('t3', 'Bash', 'ls')]), 'research');
  assert.equal(workKind([tool('t1', 'Read', 'a'), tool('t2', 'Edit', 'b')]), 'edit', 'ties go to the weightier kind');
  assert.equal(workKind([peer('m1')]), 'note');
});
