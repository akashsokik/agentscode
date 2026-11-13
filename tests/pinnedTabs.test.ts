import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { canCloseTab, closeOtherTabs, closeTab, closeTabsToRight, dropBrowserTab, getLayout, open, pinTab, pruneTabs, type Tab } from '../web/layout.ts';
import { shortcutFor } from '../web/shortcutMap.ts';

// ACH-35 / ACH-D59: a pinned tab stays open by every close route until it is unpinned. Behaviour on
// web/layout.ts (every route ends in closeTab), plus source checks for the routes that are markup.
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const find = (pred: (tab: Tab) => boolean) => getLayout().tabs.find(pred);
const ids = () => getLayout().tabs.map(t => t.id);

function setup() {
  for (const tab of [...getLayout().tabs]) { pinTab(tab.id, false); closeTab(tab.id); }
  open({ kind: 'comms' });
  open({ kind: 'agent', agentId: 'fen' });
  open({ kind: 'agent', agentId: 'cy' });
  const comms = find(t => t.content.kind === 'comms')!;
  const fen = find(t => t.content.kind === 'agent' && t.content.agentId === 'fen')!;
  const cy = find(t => t.content.kind === 'agent' && t.content.agentId === 'cy')!;
  pinTab(fen.id, true);
  return { comms, fen, cy };
}

test('Close (the menu row, Cmd+W, the palette, the sidebar all call closeTab): a pinned tab stays', () => {
  const { fen } = setup();
  assert.equal(canCloseTab(fen.id), false);
  assert.equal(closeTab(fen.id), false);
  assert.ok(ids().includes(fen.id), 'still open');
  // Cmd+W is the closeTab shortcut, and it goes through closeTab.
  assert.deepEqual(shortcutFor({ code: 'KeyW', key: 'w', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false } as never, true), { kind: 'closeTab' });
  assert.match(read('web/shortcuts.ts'), /case 'closeTab': if \(pane\?\.tabId\) closeTab\(pane\.tabId\)/);
});

test('once unpinned, it closes normally', () => {
  const { fen } = setup();
  pinTab(fen.id, false);
  assert.equal(canCloseTab(fen.id), true);
  assert.equal(closeTab(fen.id), true);
  assert.ok(!ids().includes(fen.id));
});

test('Close others and Close to the right leave a pinned tab open (there is no Close all)', () => {
  const { comms, fen, cy } = setup();
  closeOtherTabs(comms.id);
  assert.deepEqual(ids().sort(), [comms.id, fen.id].sort(), 'cy closed, the pinned fen stays');
  open({ kind: 'agent', agentId: 'cy' });
  closeTabsToRight(fen.id);
  assert.ok(ids().includes(fen.id));
  void cy;
  assert.doesNotMatch(read('web/layout.ts'), /export function closeAllTabs/, 'no Close all route exists to guard');
});

test('the markup: no X and no middle-click on a pinned tab; menus grey Close; the palette leaves it out', () => {
  const app = read('web/App.tsx');
  const pinnedShell = app.slice(app.indexOf('const shell = pinned ? ('), app.indexOf(') : (', app.indexOf('const shell = pinned ? (')));
  assert.doesNotMatch(pinnedShell, /data-tab-close|onAuxClick|closeTab\(/, 'the pinned tab has no close button and no middle-click');
  assert.match(app, /title="Close" hint=\{tab\.pinned \? 'Unpin it first' : undefined\} shortcut="Mod\+W" disabled=\{Boolean\(tab\.pinned\)\}/, 'the tab menu greys Close, with Unpin above it');
  assert.match(app, /title=\{tab\.pinned \? 'Unpin tab' : 'Pin tab'\}/);
  const sidebar = read('web/sidebar/Sidebar.tsx');
  assert.equal(sidebar.match(/title="Close tab" hint=\{tab\.pinned \? 'Pinned: unpin it first\.' : [^}]+\} disabled=\{Boolean\(tab\.pinned\)\}/g)?.length, 2, 'agent and channel menus');
  assert.match(read('web/ui/CommandPalette.tsx'), /if \(pane\?\.tabId && canCloseTab\(pane\.tabId\)\) action\(\{ id: 'close-tab'/);
});

test('content that is gone still goes, pinned or not: a removed agent, a browser tab its page closed', () => {
  const { fen } = setup();
  pruneTabs(new Set(['cy']), new Set());
  assert.ok(!ids().includes(fen.id), 'the removed agent\'s pinned tab is dropped');
  open({ kind: 'browser', id: 'b1', url: 'https://example.com' });
  const browser = find(t => t.content.kind === 'browser')!;
  pinTab(browser.id, true);
  assert.equal(closeTab(browser.id), false);
  dropBrowserTab(browser.id);
  assert.ok(!ids().includes(browser.id));
});
