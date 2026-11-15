import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ACH-56 / ACH-D80: the project column (Agents / Files / Changes) collapses and comes back, as the
// sidebar and the right panel do: a header toggle, Mod+\ (Alt+Mod+\ too), and a remembered state.
// A stand-in localStorage first, so the saved layout can be read back.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const { closeSettings, getLayout, offersProjectColumn, openSettings, setSidebar, setSidebarView, setWorkspaceColumn } = await import('../web/layout.ts');
const { settingsShortcut, shortcutFor } = await import('../web/shortcutMap.ts');
const saved = () => JSON.parse(store.get('podcode:layout') ?? '{}') as { workspace?: boolean; sidebarView?: string };
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('collapse and reopen: one remembered flag; reopening keeps the view it had', () => {
  setSidebar(true);
  setSidebarView('files');
  assert.equal(getLayout().workspace, undefined, 'shown until collapsed');
  setWorkspaceColumn(false);
  assert.equal(getLayout().workspace, false);
  assert.equal(saved().workspace, false, 'saved with the layout, like rail');
  setWorkspaceColumn(true);
  assert.equal(getLayout().workspace, undefined);
  assert.equal(saved().workspace, undefined);
  assert.equal(getLayout().sidebarView, 'files', 'the same view comes back (its width and filter are kept apart from this flag)');
  // Reopening with the whole sidebar hidden brings the sidebar back with it.
  setWorkspaceColumn(false);
  setSidebar(false);
  setWorkspaceColumn(true);
  assert.equal(getLayout().sidebar, true);
  assert.equal(getLayout().workspace, undefined);
});

test('Settings cover the column without changing the flag (ACH-D77), and its shortcut waits until they close', () => {
  setSidebar(true);
  setWorkspaceColumn(false);
  openSettings();
  assert.equal(getLayout().workspace, false);
  assert.deepEqual(settingsShortcut({ kind: 'workspace' }), { kind: 'ignore' }, 'Mod+\\ does nothing on the Settings page');
  closeSettings();
  assert.equal(getLayout().workspace, false, 'still collapsed after Settings');
  setWorkspaceColumn(true);
});

test('Mod+\\ toggles it, Alt+Mod+\\ too; other chords stay as they were', () => {
  const press = (code: string, mods: { alt?: boolean; shift?: boolean } = {}, mac = true) =>
    shortcutFor({ code, metaKey: mac, ctrlKey: !mac, altKey: Boolean(mods.alt), shiftKey: Boolean(mods.shift) }, mac);
  assert.deepEqual(press('Backslash'), { kind: 'workspace' });
  assert.deepEqual(press('Backslash', { alt: true }), { kind: 'workspace' });
  assert.deepEqual(press('Backslash', {}, false), { kind: 'workspace' }, 'Ctrl+\\ off macOS');
  assert.equal(press('Backslash', { shift: true }), null);
  assert.deepEqual(press('KeyB'), { kind: 'sidebar' });
  assert.deepEqual(press('KeyB', { alt: true }), { kind: 'panel' });
  assert.deepEqual(press('BracketLeft'), { kind: 'back' });
});

test('Show project column: in the tab strip only while collapsed, the sidebar shown and the project has a column', () => {
  assert.equal(offersProjectColumn({ sidebar: true, workspace: false }, true), true);
  assert.equal(offersProjectColumn({ sidebar: true, workspace: undefined }, true), false, 'not while it is open');
  assert.equal(offersProjectColumn({ sidebar: false, workspace: false }, true), false, 'Show sidebar stands there instead');
  assert.equal(offersProjectColumn({ sidebar: true, workspace: false }, false), false, 'nothing to show for a project without a column');
  const app = read('web/App.tsx');
  const tabBar = app.slice(app.indexOf('function TabBar('));
  const show = tabBar.indexOf('Show project column'), back = tabBar.indexOf('label={`Back ('), sidebar = tabBar.indexOf('label="Show sidebar"');
  assert.ok(sidebar >= 0 && show > sidebar && back > show, 'after Show sidebar, before Back and Forward');
  assert.match(tabBar, /<HeaderButton icon=\{PanelLeft\} label=\{`Show project column \(\$\{SHORTCUTS\.workspace\}\)`\} onClick=\{\(\) => setWorkspaceColumn\(true\)\} \/>/);
  const sidebarSrc = read('web/sidebar/Sidebar.tsx');
  assert.match(sidebarSrc, /<HeaderButton icon=\{PanelLeft\} label=\{`Hide project column \(\$\{SHORTCUTS\.workspace\}\)`\} onClick=\{\(\) => setWorkspaceColumn\(false\)\} \/>\n {6}<\/div>/, 'Hide is the last button in the column header');
  assert.match(sidebarSrc, /part === 'nav' \|\| layout\.workspace === false \? null/, 'a collapsed column is not drawn');
});
