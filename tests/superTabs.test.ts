import assert from 'node:assert/strict';
import test from 'node:test';
import type { SuperAction, SuperGoal, SuperRoutine } from '../shared/types.ts';
import { decisionRows, superPanelView, superTabCounts, superTabDots, superTabLatest } from '../web/superText.ts';
import { getLayout, setRightPanel, showPanelForSuperOnce, SUPER_VIEWS } from '../web/layout.ts';
import { harness, settle } from './helpers.ts';

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

test('the right panel opens the SuperAgent on Decisions the first time, then on the tab you picked last', () => {
  const views = ['overview', 'decisions', 'goals', 'routines', 'comms'] as const;
  assert.equal(superPanelView(undefined, views), 'decisions');
  assert.equal(superPanelView('goals', views), 'goals');
  assert.equal(superPanelView('overview', views), 'overview');
  assert.equal(superPanelView('changes', views), 'decisions', 'a tab the SuperAgent does not have');
});

test('tab counts: decisions made today that can still be undone, open goals, routines waiting for you', () => {
  const now = new Date(2026, 10, 9, 15, 0).getTime();
  const today = new Date(2026, 10, 9, 9, 0).getTime();
  const yesterday = new Date(2026, 10, 8, 23, 0).getTime();
  const undo = { kind: 'removeChannel' as const, channelId: 'c' };
  const counts = superTabCounts({
    log: [
      { id: 'a', at: today, tool: 'create_channel', summary: '', why: '', undo },
      { id: 'b', at: today, tool: 'create_channel', summary: '', why: '', undo, undoneAt: today + 1 },
      { id: 'c', at: today, tool: 'delegate_task', summary: '', why: '' },
      { id: 'd', at: yesterday, tool: 'create_channel', summary: '', why: '', undo },
    ],
    goals: [goal('g1', 'queued', 1), goal('g2', 'blocked', 2), goal('g3', 'done', 3)],
    routines: [routine('r1', 1, true), routine('r2', 2, false)],
  }, now);
  assert.deepEqual(counts, { decisions: 1, goals: 2, routines: 1 });
  assert.deepEqual(superTabCounts({}, now), { decisions: 0, goals: 0, routines: 0 });
});

test('a dot shows on a tab with something newer than you last saw there, never on the open tab', () => {
  const latest = superTabLatest({
    log: [{ id: 'a', at: 50, tool: 'create_channel', summary: '', why: '' }, { id: 'b', at: 70, tool: 'nudge', summary: '', why: '' }],
    goals: [goal('g1', 'queued', 30)],
    routines: [],
  });
  assert.deepEqual(latest, { decisions: 70, goals: 30, routines: 0 });
  assert.deepEqual(superTabDots(latest, {}, 'decisions'), { decisions: false, goals: true, routines: false }, 'never seen: new, except on the open tab and on an empty one');
  assert.deepEqual(superTabDots(latest, { decisions: 50, goals: 30 }, 'goals'), { decisions: true, goals: false, routines: false });
  assert.deepEqual(superTabDots(latest, { decisions: 70, goals: 30 }, 'overview'), { decisions: false, goals: false, routines: false }, 'all seen');
});

test('opening the SuperAgent shows the right panel the first time only, on Decisions; after that the panel stays as you left it', () => {
  setRightPanel(false);
  assert.equal(getLayout().superPanelShown, undefined);
  showPanelForSuperOnce();
  assert.equal(getLayout().rightPanel, true, 'first open: the panel opens');
  assert.equal(getLayout().superPanelShown, true);
  assert.equal(superPanelView(getLayout().superView, SUPER_VIEWS), 'decisions');
  setRightPanel(false);
  showPanelForSuperOnce();
  assert.equal(getLayout().rightPanel, false, 'closed by you: it stays closed');
  setRightPanel(true);
  showPanelForSuperOnce();
  assert.equal(getLayout().rightPanel, true, 'open: it stays open');
});

function goal(id: string, status: SuperGoal['status'], createdAt: number): SuperGoal {
  return { id, text: id, projectId: null, status, order: createdAt, createdAt, updatedAt: createdAt, by: 'user' };
}

function routine(id: string, createdAt: number, proposed: boolean): SuperRoutine {
  return { id, name: id, projectId: null, instruction: 'x', schedule: { kind: 'every', hours: 6 }, enabled: !proposed, ...(proposed ? { proposed } : {}), by: proposed ? 'super' : 'user', createdAt };
}
