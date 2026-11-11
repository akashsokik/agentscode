import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutRetired, type Layout } from '../web/layout.ts';

// The Work view was removed (ACH-D20). A layout saved while it existed must still open cleanly.

test('a saved layout with the Work tab open falls back: the tab is dropped and its pane left empty', () => {
  const saved = {
    tabs: [{ id: 't1', content: { kind: 'work' } }, { id: 't2', content: { kind: 'comms' } }],
    panes: [{ id: 'p1', tabId: 't1' }, { id: 'p2', tabId: 't2' }],
    focused: 'p1', sidebar: true, sidebarView: 'agents', rightPanel: true,
    rightView: 'work', superView: 'work', superPanelShown: true,
  } as unknown as Layout;
  const next = withoutRetired(saved);
  assert.deepEqual(next.tabs.map(t => t.id), ['t2']);
  assert.deepEqual(next.panes, [{ id: 'p1', tabId: null }, { id: 'p2', tabId: 't2' }]);
  assert.equal(next.rightView, 'overview', 'agents fall back to Overview');
  assert.equal(next.superView, undefined, 'the SuperAgent falls back to its default tab');
  assert.equal(next.superPanelShown, true, 'everything else is kept');
});

test('a layout without the Work view is unchanged', () => {
  const saved = {
    tabs: [{ id: 't2', content: { kind: 'comms' } }], panes: [{ id: 'p1', tabId: 't2' }], focused: 'p1',
    sidebar: true, sidebarView: 'agents', rightPanel: true, rightView: 'notes', superView: 'goals',
  } as unknown as Layout;
  assert.deepEqual(withoutRetired(saved), saved);
});
