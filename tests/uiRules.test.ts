import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { formatClick, formatKeys } from '../web/keys.ts';
import { shortcutFor, type KeyPress } from '../web/shortcutMap.ts';
import { moveTab, orderTabs, othersToClose, rightToClose, setPinned } from '../web/tabs.ts';
import { focusFirstOnOpen, focusToRestore, menuKeyTarget } from '../web/ui/menuFocus.ts';
import { closeOtherTabs, closeTabsToRight, getLayout, open, pinTab, reorderTab, type Tab } from '../web/layout.ts';

test('shortcuts read as key symbols in Apple order on a Mac, short words elsewhere (ACH-D26)', () => {
  assert.equal(formatKeys('Mod+Enter', true), '⌘⏎');
  assert.equal(formatKeys('Shift+Enter', true), '⇧⏎');
  assert.equal(formatKeys('Shift+Mod+Enter', true), '⇧⌘⏎');
  assert.equal(formatKeys('Mod+Shift+Alt+Ctrl+X', true), '⌃⌥⇧⌘X', 'Control, Option, Shift, Command, whatever order it is written in');
  assert.equal(formatKeys('Alt+Mod+W', true), '⌥⌘W');
  assert.equal(formatKeys('Mod+,', true), '⌘,');
  assert.equal(formatKeys('Shift+Mod+Space', true), '⇧⌘Space');
  assert.equal(formatKeys('Escape', true), '⎋');
  assert.equal(formatKeys('Mod+k', true), '⌘K', 'letters are capitals');
  assert.equal(formatKeys('Up', true), '↑');

  assert.equal(formatKeys('Enter', false), 'Enter');
  assert.equal(formatKeys('Shift+Enter', false), 'Shift+Enter');
  assert.equal(formatKeys('Shift+Mod+Enter', false), 'Ctrl+Shift+Enter');
  assert.equal(formatKeys('Alt+Mod+W', false), 'Ctrl+Alt+W');
  assert.equal(formatKeys('Ctrl+Mod+=', false), 'Ctrl+=', 'Mod is Ctrl elsewhere: said once');
  assert.equal(formatKeys('Escape', false), 'Esc');

  assert.equal(formatClick(true), '⌘-click');
  assert.equal(formatClick(false), 'Ctrl+click');
});

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('⌥⌘W (Ctrl+Alt+W elsewhere) is Close others; the other chords keep their actions', () => {
  assert.deepEqual(shortcutFor(press('KeyW', { metaKey: true, altKey: true }), true), { kind: 'closeOthers' });
  assert.deepEqual(shortcutFor(press('KeyW', { ctrlKey: true, altKey: true }), false), { kind: 'closeOthers' });
  assert.deepEqual(shortcutFor(press('KeyW', { metaKey: true }), true), { kind: 'closeTab' });
  assert.equal(shortcutFor(press('KeyW', { ctrlKey: true, altKey: true }), true), null, 'Ctrl is not Mod on a Mac');
  assert.equal(shortcutFor(press('KeyW', { metaKey: true, altKey: true, shiftKey: true }), true), null);
  assert.deepEqual(shortcutFor(press('KeyB', { metaKey: true, altKey: true }), true), { kind: 'panel' });
  assert.deepEqual(shortcutFor(press('Enter', { metaKey: true, shiftKey: true }), true), { kind: 'maximize' });
  assert.deepEqual(shortcutFor(press('Digit9', { metaKey: true }), true), { kind: 'pickTab', n: 9 });
  assert.equal(shortcutFor(press('KeyW'), true), null, 'no modifier, no shortcut');
});

const t = (id: string, pinned = false) => ({ id, ...(pinned ? { pinned: true } : {}) });
const ids = (tabs: { id: string; pinned?: boolean }[]) => tabs.map(x => (x.pinned ? `*${x.id}` : x.id)).join(' ');

test('pin and unpin: a pinned tab joins the end of the pinned group, an unpinned one heads the rest', () => {
  const tabs = [t('a', true), t('b'), t('c'), t('d')];
  assert.equal(ids(setPinned(tabs, 'c', true)), '*a *c b d');
  assert.equal(ids(setPinned(setPinned(tabs, 'c', true), 'a', false)), '*c a b d');
  assert.equal(setPinned(tabs, 'a', true), tabs, 'already pinned: unchanged');
  assert.equal(setPinned(tabs, 'zz', true), tabs);
  assert.equal(ids(orderTabs([t('x'), t('p', true), t('y')])), '*p x y', 'pinned first');
  const plain = [t('x'), t('y')];
  assert.equal(orderTabs(plain), plain, 'no pins: the same list');
});

test('Close others and Close to the right never close a pinned tab', () => {
  const tabs = [t('s', true), t('c', true), t('fen'), t('cy'), t('web')];
  assert.equal(ids(othersToClose(tabs, 'cy')), 'fen web');
  assert.equal(ids(othersToClose(tabs, 's')), 'fen cy web', 'from a pinned tab: the pins stay');
  assert.equal(ids(rightToClose(tabs, 'fen')), 'cy web');
  assert.equal(ids(rightToClose(tabs, 'c')), 'fen cy web');
  assert.equal(ids(rightToClose(tabs, 'web')), '');
  assert.equal(ids(othersToClose([t('only')], 'only')), '', 'nothing to close: the menu greys the item');
});

test('dragging reorders within a group only', () => {
  const tabs = [t('s', true), t('c', true), t('fen'), t('cy'), t('web')];
  assert.equal(ids(moveTab(tabs, 'c', 's')), '*c *s fen cy web');
  assert.equal(ids(moveTab(tabs, 'web', 'fen')), '*s *c web fen cy');
  assert.equal(moveTab(tabs, 'fen', 's'), tabs, 'a normal tab cannot go among the pinned');
  assert.equal(moveTab(tabs, 's', 'cy'), tabs, 'a pinned tab cannot go among the normal');
});

test('layout: pin, Close others and Close to the right keep pinned tabs; reorder stays in its group', () => {
  open({ kind: 'comms' });
  open({ kind: 'channel', channelId: 'ch1' });
  open({ kind: 'agent', agentId: 'fen' });
  open({ kind: 'agent', agentId: 'cy' });
  open({ kind: 'work' });
  const byKey = (pred: (tab: Tab) => boolean) => getLayout().tabs.find(pred)!;
  const comms = byKey(x => x.content.kind === 'comms');
  const channel = byKey(x => x.content.kind === 'channel');
  const fen = byKey(x => x.content.kind === 'agent' && x.content.agentId === 'fen');
  pinTab(comms.id, true);
  pinTab(channel.id, true);
  assert.deepEqual(getLayout().tabs.slice(0, 2).map(x => [x.id, x.pinned]), [[comms.id, true], [channel.id, true]]);

  closeTabsToRight(fen.id);
  assert.deepEqual(getLayout().tabs.map(x => x.id), [comms.id, channel.id, fen.id], 'cy and work closed, the pins stay');

  open({ kind: 'agent', agentId: 'cy' });
  closeOtherTabs(fen.id);
  assert.deepEqual(getLayout().tabs.map(x => x.id), [comms.id, channel.id, fen.id], 'cy closed, the pins stay');
  assert.equal(getLayout().panes.find(p => p.id === getLayout().focused)?.tabId, fen.id, 'the kept tab is shown');

  reorderTab(fen.id, comms.id);
  assert.deepEqual(getLayout().tabs.map(x => x.id), [comms.id, channel.id, fen.id], 'a normal tab cannot be dragged among the pins');
  reorderTab(channel.id, comms.id);
  assert.deepEqual(getLayout().tabs.map(x => x.id), [channel.id, comms.id, fen.id]);

  pinTab(comms.id, false);
  assert.deepEqual(getLayout().tabs.map(x => [x.id, Boolean(x.pinned)]), [[channel.id, true], [comms.id, false], [fen.id, false]]);
});

/** A fresh copy of web/layout.ts reading `saved` from storage, as the app does when it starts. */
async function restore(saved: unknown, tag: string) {
  const store = new Map<string, string>([['podcode:layout', JSON.stringify(saved)], ['agentscode:layout', JSON.stringify(saved)]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  try {
    const fresh = await import(`../web/layout.ts?restore=${tag}`) as typeof import('../web/layout.ts');
    return fresh.getLayout();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test('restarts keep pinned tabs first; a layout saved before pins existed loads as it was', async () => {
  const pane = [{ id: 'p1', tabId: 't2' }];
  const pinnedLater = await restore({ tabs: [{ id: 't1', content: { kind: 'comms' } }, { id: 't2', content: { kind: 'agent', agentId: 'a' }, pinned: true }], panes: pane, focused: 'p1' }, 'pins');
  assert.deepEqual(pinnedLater.tabs.map(x => [x.id, Boolean(x.pinned)]), [['t2', true], ['t1', false]]);
  const old = await restore({ tabs: [{ id: 't1', content: { kind: 'comms' } }, { id: 't2', content: { kind: 'agent', agentId: 'a' } }], panes: pane, focused: 'p1' }, 'old');
  assert.deepEqual(old.tabs.map(x => x.id), ['t1', 't2']);
  assert.ok(old.tabs.every(x => !x.pinned));
});

test('AltGr chords are characters, not shortcuts: Ctrl+Alt+W and Ctrl+Alt+B are ignored with AltGraph held', () => {
  assert.equal(shortcutFor(press('KeyW', { ctrlKey: true, altKey: true, altGraph: true }), false), null);
  assert.equal(shortcutFor(press('KeyB', { ctrlKey: true, altKey: true, altGraph: true }), false), null);
  assert.equal(shortcutFor(press('KeyW', { metaKey: true, altKey: true, altGraph: true }), true), null);
  assert.deepEqual(shortcutFor(press('KeyW', { ctrlKey: true, altKey: true, altGraph: false }), false), { kind: 'closeOthers' }, 'without AltGr it is still Close others');
  assert.deepEqual(shortcutFor(press('KeyB', { ctrlKey: true, altKey: true }), false), { kind: 'panel' });
});

test('a context menu takes focus however it opened, and the keys move within it', () => {
  assert.equal(focusFirstOnOpen({ x: 10, y: 20 }), true, 'opened by a right-click');
  assert.equal(focusFirstOnOpen({} as HTMLElement), true, 'opened from the keyboard or a button');
  assert.equal(menuKeyTarget(4, -1, 'ArrowDown'), 0, 'nothing focused yet: Down goes to the first row');
  assert.equal(menuKeyTarget(4, -1, 'ArrowUp'), 3);
  assert.equal(menuKeyTarget(4, 3, 'ArrowDown'), 0, 'wraps');
  assert.equal(menuKeyTarget(4, 0, 'ArrowUp'), 3);
  assert.equal(menuKeyTarget(4, 2, 'Home'), 0);
  assert.equal(menuKeyTarget(4, 0, 'End'), 3);
  assert.equal(menuKeyTarget(4, 1, 'a'), null, 'other keys are not the menu\'s');
  assert.equal(menuKeyTarget(0, -1, 'ArrowDown'), null);
});

/** Every .ts and .tsx file under web/, with comments taken out so only code and UI text are left. */
function webSources(): { file: string; code: string }[] {
  const root = path.join(import.meta.dirname, '..', 'web');
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const code = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        out.push({ file: path.relative(root, full), code });
      }
    }
  };
  walk(root);
  return out;
}

test('no spelled-out keys in UI text (ACH-D26): no "Cmd+", "(Esc)" or a written-out Enter', () => {
  const found: string[] = [];
  for (const { file, code } of webSources()) {
    // web/keys.ts is where the words for other platforms live.
    if (file === 'keys.ts') continue;
    code.split('\n').forEach((line, i) => {
      if (/Cmd\+|\(Esc\)|\(Escape\)|Shift Enter|Press Enter|\(Enter\)|>\s*Enter\s*</.test(line)) found.push(`web/${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, [], `Spelled-out keys; use keys()/formatKeys() or <Kbd>:\n${found.join('\n')}`);
});

test('closing a menu gives focus back to what had it, unless the action moved it on purpose', () => {
  const body = 'body', terminal = 'terminal', menuRow = 'menu-row', newSplit = 'new-split', gone = 'gone';
  const inMenu = (el: string) => el === menuRow;
  const connected = (el: string) => el !== gone;
  // Escape, or an action that only acts (Copy, Clear): focus is still in the menu.
  assert.equal(focusToRestore(terminal, menuRow, body, inMenu, connected), terminal);
  // The menu was removed first and focus fell to the page.
  assert.equal(focusToRestore(terminal, body, body, inMenu, connected), terminal);
  assert.equal(focusToRestore(terminal, null, body, inMenu, connected), terminal);
  // The action focused something else (a new split, a dialog): it keeps focus.
  assert.equal(focusToRestore(terminal, newSplit, body, inMenu, connected), null);
  // Nothing to go back to: the opener left the page, or it was the page itself.
  assert.equal(focusToRestore(gone, menuRow, body, inMenu, connected), null);
  assert.equal(focusToRestore(body, menuRow, body, inMenu, connected), null);
  assert.equal(focusToRestore(null, menuRow, body, inMenu, connected), null);
});
