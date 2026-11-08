import assert from 'node:assert/strict';
import test from 'node:test';
import type { WalkthroughStep } from '../shared/types.ts';
import { codeChanged, currentLines, stepQuestion } from '../web/walkthrough.ts';

const step: WalkthroughStep = { kind: 'code', title: 'Limits', body: '', path: 'server/a.ts', startLine: 2, endLine: 3, excerpt: 'b\nc' };

test('a code step is current until its lines change', () => {
  assert.equal(currentLines('a\nb\nc\nd\n', 2, 3), 'b\nc');
  assert.equal(currentLines('a\n', 2, 3), undefined);
  assert.equal(codeChanged(step, 'a\nb\nc\nd\n'), false);
  assert.equal(codeChanged(step, 'a\nB\nc\n'), true);
  assert.equal(codeChanged(step, 'a\n'), true);
  assert.equal(codeChanged({ kind: 'note', title: 'n', body: 'x' }, ''), false);
});

test('a step question names the walkthrough, the step and where it points', () => {
  const text = stepQuestion('Rate limits', 1, step, '  Why 40?  ');
  assert.equal(text, 'About step 2 of your walkthrough "Rate limits", "Limits" (server/a.ts:2-3):\n\nWhy 40?');
});

test('the walkthrough tool call stands on its own in the transcript and reads its result', async () => {
  const { groupTurnItems, walkthroughResult } = await import('../web/activity.ts');
  const output = JSON.stringify({ created: { id: '20261108-abcdef12', title: 'Rate limits', stepCount: 4 } });
  const tool = { name: 'mcp__agentscode__create_walkthrough', summary: '', status: 'ok' as const, output };
  assert.deepEqual(walkthroughResult(tool), { id: '20261108-abcdef12', title: 'Rate limits', stepCount: 4 });
  assert.equal(walkthroughResult({ ...tool, status: 'error' }), null);
  assert.equal(walkthroughResult({ ...tool, output: 'Walkthrough not saved.' }), null);
  assert.deepEqual(walkthroughResult({ ...tool, name: 'agentscode.create_walkthrough' }), { id: '20261108-abcdef12', title: 'Rate limits', stepCount: 4 });
  const entries = [
    { id: 'r', agentId: 'a', ts: 1, kind: 'tool' as const, text: '', tool: { name: 'Read', summary: 'a.ts', status: 'ok' as const } },
    { id: 'w', agentId: 'a', ts: 2, kind: 'tool' as const, text: '', tool },
  ];
  assert.deepEqual(groupTurnItems(entries).map(item => item.type), ['activity', 'walkthrough']);
});
