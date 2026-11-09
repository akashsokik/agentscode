import assert from 'node:assert/strict';
import test from 'node:test';
import type { SuperAction } from '../shared/types.ts';
import { decisionRows, peekAfter, SUPER_LOG_CONVERSATION_MIN, SUPER_LOG_MIN_PANE, superLogMode, superLogWidth, toggleSuperLog } from '../web/superText.ts';
import { harness, settle } from './helpers.ts';

test('the decision log sits beside the conversation in a wide pane, over it in a narrow one only when asked, and not when closed', () => {
  assert.equal(superLogMode(true, SUPER_LOG_MIN_PANE, false), 'beside');
  assert.equal(superLogMode(true, 1400, true), 'beside');
  assert.equal(superLogMode(true, SUPER_LOG_MIN_PANE - 1, false), 'hidden', 'it gives way to the conversation on its own');
  assert.equal(superLogMode(true, 500, true), 'over');
  assert.equal(superLogMode(false, 1400, true), 'hidden');
  assert.equal(superLogMode(false, 500, true), 'over', 'a narrow peek shows it whatever the wide-pane choice');
  assert.equal(superLogMode(true, 0, false), 'hidden', 'before the pane is measured');
});

test('the log lists decisions newest first; only those with an undo, not yet undone, can be undone', () => {
  const log: SuperAction[] = [
    { id: 'a', at: 1, tool: 'delegate_task', summary: 'Delegated review to Ada', why: 'You want reviews' },
    { id: 'b', at: 3, tool: 'create_agent', summary: 'Created Tess', why: 'Tests first', undo: { kind: 'removeAgent', agentId: 't' } },
    { id: 'c', at: 2, tool: 'create_channel', summary: 'Created #release', why: '', undo: { kind: 'removeChannel', channelId: 'c' }, undoneAt: 4 },
  ];
  assert.deepEqual(decisionRows(log).map(r => [r.id, r.undoable, r.undoneAt ?? null]), [['b', true, null], ['c', false, 4], ['a', false, null]]);
  assert.deepEqual(decisionRows(undefined), []);
});

test('undo from the log: the row turns undone and its action is put back', async () => {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Set up a channel.');
  await settle();
  const token = h.runner(sup.id).ctx.commsToken!;
  await h.manager.commsTool(token, 'create_channel', { name: 'release', member_ids: [], why: 'Release coordination.' });
  const [row] = decisionRows(h.manager.superView().log);
  assert.equal(row.summary, 'Created #release with no members');
  assert.equal(row.why, 'Release coordination.');
  assert.equal(row.undoable, true);
  const after = await h.manager.undoSuper(row.id);
  const [undone] = decisionRows(after.log);
  assert.equal(undone.undoable, false);
  assert.ok(undone.undoneAt);
  assert.equal(h.manager.snapshot().channels.length, 0);
});

test('the log width follows the pane: the conversation keeps its minimum beside it, and over it the log stays inside the pane', () => {
  // Beside: a wide choice in a 760px pane leaves the conversation 420px.
  assert.equal(superLogWidth(700, 240, 760, 'beside'), 760 - SUPER_LOG_CONVERSATION_MIN);
  assert.equal(superLogWidth(300, 240, 1600, 'beside'), 300, 'room enough: as chosen');
  assert.equal(superLogWidth(300, 240, 600, 'beside'), 240, 'never under its minimum');
  // Over: never past the pane's left edge.
  assert.equal(superLogWidth(700, 240, 500, 'over'), 500);
  assert.equal(superLogWidth(300, 240, 500, 'over'), 300);
  assert.equal(superLogWidth(300, 240, 0, 'over'), 300, 'before the pane is measured');
});

test('once the pane is wide, a narrow pane does not reopen the log over the conversation', () => {
  assert.equal(peekAfter(1200, true), false);
  assert.equal(peekAfter(600, true), true);
  assert.equal(peekAfter(600, false), false);
  // Wide, then narrow again: peek was reset, so the log hides instead of floating unasked.
  const peek = peekAfter(1200, true);
  assert.equal(superLogMode(true, 600, peek), 'hidden');
});

test('the toggle in a narrow pane only peeks; it never changes the remembered wide-pane choice', () => {
  // Wide: it flips your choice.
  assert.deepEqual(toggleSuperLog(true, 1200, false), { open: false, peek: false });
  assert.deepEqual(toggleSuperLog(false, 1200, false), { open: true, peek: false });
  // Narrow: open over the conversation and close it again, with the choice left as it was either way.
  for (const open of [true, false]) {
    const opened = toggleSuperLog(open, 600, false);
    assert.deepEqual(opened, { open, peek: true });
    assert.equal(superLogMode(opened.open, 600, opened.peek), 'over');
    assert.deepEqual(toggleSuperLog(opened.open, 600, opened.peek), { open, peek: false });
  }
});
