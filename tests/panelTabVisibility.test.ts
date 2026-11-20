import assert from 'node:assert/strict';
import test from 'node:test';
import { enabledPanelTabs, visiblePanelTabs, togglePanelTab, PANEL_VIEWS } from '../web/right/panelTabVisibility.ts';
import { fitPanelTabs, stripKeyTarget } from '../web/right/panelTabsFit.ts';

test('saved tab choices are canonical, robust to stale/invalid values and never empty', () => {
  for (const input of [undefined, null, {}, [], ['unknown'], 'notes']) assert.deepEqual(enabledPanelTabs('agent', input), PANEL_VIEWS.agent);
  assert.deepEqual(enabledPanelTabs('super', ['notes', 'issues', 'issues', 'changes']), ['issues', 'notes']);
});
test('the open tab and last configured tab cannot be hidden', () => {
  assert.deepEqual(togglePanelTab('agent', ['overview', 'notes'], 'overview', 'overview'), ['overview', 'notes']);
  assert.deepEqual(togglePanelTab('agent', ['notes'], 'overview', 'notes'), ['notes']);
  assert.deepEqual(togglePanelTab('agent', ['overview', 'notes'], 'overview', 'notes'), ['overview']);
  assert.deepEqual(togglePanelTab('agent', ['overview'], 'overview', 'issues'), ['overview']);
});
test('opening a hidden view reveals it transiently and leaving restores the saved configuration', () => {
  const saved = ['overview'];
  assert.deepEqual(visiblePanelTabs('agent', saved, 'notes'), ['overview', 'notes']);
  assert.deepEqual(visiblePanelTabs('agent', saved, 'overview'), ['overview']);
  assert.deepEqual(saved, ['overview']);
});
test('customisation is separate for agents and the SuperAgent, including reset', async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string,v: string) => storage.set(k,v) } });
  const L = await import('../web/layout.ts');
  L.setPanelTabs('agent', ['overview']);
  L.setPanelTabs('super', ['issues', 'notes']);
  const saved = JSON.parse(storage.get('podcode:layout')!);
  assert.deepEqual(saved.panelTabs, { agent: ['overview'], super: ['issues', 'notes'] });
  L.setRightView('notes');
  assert.deepEqual(L.getLayout().panelTabs?.agent, ['overview'], 'opening from palette does not unhide permanently');
  L.setPanelTabs('agent');
  assert.deepEqual(enabledPanelTabs('agent', L.getLayout().panelTabs?.agent), PANEL_VIEWS.agent);
  assert.deepEqual(L.getLayout().panelTabs?.super, ['issues', 'notes']);
});
test('overflow and arrow navigation only contain configured views plus the active transient view', () => {
  const views = visiblePanelTabs('super', ['overview', 'issues', 'notes', 'work'], 'issues');
  const tabs = views.map(view => ({view, label:view}));
  for (const width of [180, 214, 260, 340]) {
    const fit = fitPanelTabs(tabs, 'issues', width);
    assert.ok(fit.visible.includes('issues'));
    assert.equal([...fit.visible,...fit.overflow].includes('decisions' as never), false);
  }
  assert.equal(stripKeyTarget(views, 'overview', 'ArrowRight'), 'issues');
  assert.equal(stripKeyTarget(views, 'work', 'ArrowRight'), 'overview');
});
