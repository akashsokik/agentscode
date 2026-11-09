import assert from 'node:assert/strict';
import test from 'node:test';
import type { SuperAction } from '../shared/types.ts';
import { decisionRows, SUPER_LOG_MIN_PANE, superLogMode } from '../web/superText.ts';
import { harness, settle } from './helpers.ts';

test('the decision log sits beside the conversation in a wide pane, over it in a narrow one only when asked, and not when closed', () => {
  assert.equal(superLogMode(true, SUPER_LOG_MIN_PANE, false), 'beside');
  assert.equal(superLogMode(true, 1400, true), 'beside');
  assert.equal(superLogMode(true, SUPER_LOG_MIN_PANE - 1, false), 'hidden', 'it gives way to the conversation on its own');
  assert.equal(superLogMode(true, 500, true), 'over');
  assert.equal(superLogMode(false, 1400, true), 'hidden');
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
