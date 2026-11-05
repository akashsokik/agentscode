import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entry, PeerMessage, ToolCall } from '../shared/types.ts';
import { foldableWork, groupTurnItems, isDreamLine, keptInView, memoryLine, turnItemKey, workKind, workSummaryLine, type TurnItem } from '../web/activity.ts';

let ts = 0;
const e = (entry: Partial<Entry> & Pick<Entry, 'id' | 'kind'>): Entry => ({ agentId: 'a', ts: ++ts, text: entry.id, ...entry });
const tool = (id: string, name: string, summary = '', status: ToolCall['status'] = 'ok') => e({ id, kind: 'tool', text: '', tool: { name, summary, status } });
const prose = (id: string) => e({ id, kind: 'agent', text: `${id} text` });
const peer = (id: string): Entry => {
  const message: PeerMessage = { id, conversationId: 'c', fromAgentId: 'a', fromName: 'Ada', toAgentId: 'b', toName: 'Bo', text: 'hi', expectsReply: false, ts: 0, status: 'delivered' };
  return e({ id: `peer:${id}`, kind: 'peer', peer: message });
};
const shape = (items: TurnItem[]) => items.map(item => `${item.type}:${item.type === 'activity' ? item.entries.map(x => x.id).join('+') : item.entry.id}`);

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

test('remember and forget calls stand alone as memory lines, splitting the work around them', () => {
  const items = groupTurnItems([
    tool('t1', 'Read', 'a.ts'),
    tool('r1', 'mcp__agentscode__remember', 'Remembered: the user wants no emojis'),
    tool('t2', 'Bash', 'ls'),
    tool('f1', 'agentscode.forget', 'Forgot: use port 4317'),
  ]);
  assert.deepEqual(shape(items), ['activity:t1', 'memory:r1', 'activity:t2', 'memory:f1']);
  assert.equal(turnItemKey(items[1]), 'r1');
});

test('a memory line alone does not make a fold', () => {
  const items = groupTurnItems([tool('r1', 'mcp__agentscode__remember', 'Remembered: x'), prose('p1')]);
  assert.equal(foldableWork(items), undefined);
});

test('a memory line inside a fold stays in view under it', () => {
  const items = groupTurnItems([
    tool('t1', 'Read', 'a.ts'),
    tool('r1', 'mcp__agentscode__remember', 'Remembered: x'),
    tool('t2', 'Bash', 'ls'),
    prose('p1'),
  ]);
  const fold = foldableWork(items);
  assert.deepEqual(fold, { start: 0, end: 2 });
  assert.deepEqual(shape(keptInView(items, fold)), ['memory:r1']);
  assert.deepEqual(keptInView(items, undefined), []);
});

test('memory lines read by the state of the call, with the verb said once', () => {
  const remember = (summary: string, status: ToolCall['status'] = 'ok'): ToolCall => ({ name: 'mcp__agentscode__remember', summary, status });
  assert.deepEqual(memoryLine(remember('Remembered: the user wants no emojis')), { verb: 'Remembered', text: 'the user wants no emojis' });
  assert.deepEqual(memoryLine(remember('the user wants no emojis', 'running')), { verb: 'Remembering', text: 'the user wants no emojis' });
  assert.deepEqual(memoryLine(remember('Remembered: x', 'error')), { verb: 'Could not remember', text: 'x' });
  assert.deepEqual(memoryLine({ name: 'agentscode.forget', summary: 'Forgot: use port 4317', status: 'ok' }), { verb: 'Forgot', text: 'use port 4317' });
});

test('a dream line stands alone and stays in view, while other status lines stay work', () => {
  const dreamed = e({ id: 'dr1', kind: 'system', text: 'Dreamed: +2 -1, soul change proposed' });
  assert.equal(isDreamLine(dreamed), true);
  assert.equal(isDreamLine(e({ id: 's1', kind: 'system', text: 'Context compacted' })), false);
  assert.equal(isDreamLine(e({ id: 'a1', kind: 'agent', text: 'Dreamed: of sheep' })), false);
  const items = groupTurnItems([tool('t1', 'Read', 'a.ts'), dreamed, e({ id: 's1', kind: 'system', text: 'Context compacted' }), prose('p1')]);
  assert.deepEqual(shape(items), ['activity:t1', 'dream:dr1', 'activity:s1', 'prose:p1']);
  assert.deepEqual(shape(keptInView(items, foldableWork(items))), ['dream:dr1']);
});
