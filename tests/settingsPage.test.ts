import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ACH-55 / ACH-D77: Settings as a full-window page. The navigation column turns into the sections
// with Back at its foot; the tabs, panes and panels are hidden, not closed. Behaviour on
// web/layout.ts and web/shortcuts.ts, plus source checks for the wiring that is markup.

// A stand-in localStorage before layout.ts loads, to see what it saves.
const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) },
});
const L = await import('../web/layout.ts');
const { settingsEscape, settingsShortcut, shortcutFor } = await import('../web/shortcutMap.ts');
const { APP_SECTION_IDS, isAppSection, sectionForKey } = await import('../web/settingsSections.ts');

const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// What web/shortcuts.ts does with a Cmd chord: the Settings meaning first, then the usual action.
const ran: string[] = [];
function press(code: string, opts: { shift?: boolean } = {}): void {
  const action = shortcutFor({ code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: Boolean(opts.shift) }, true);
  assert.ok(action, code);
  if (L.settingsShortcutStep(action)) return;
  if (action.kind === 'back') L.goBack();
  else if (action.kind === 'pickTab') { const tab = L.getLayout().tabs[action.n - 1]; if (tab) L.open(tab.content); }
  else ran.push(action.kind);
}

function setup() {
  L.closeSettings();
  for (const tab of [...L.getLayout().tabs]) { L.pinTab(tab.id, false); L.closeTab(tab.id); }
  L.open({ kind: 'comms' });
  L.open({ kind: 'agent', agentId: 'fen' });
  L.open({ kind: 'agent', agentId: 'cy' });
}
const focusedKey = () => {
  const l = L.getLayout();
  const tab = l.tabs.find(t => t.id === l.panes.find(p => p.id === l.focused)?.tabId);
  return tab ? L.tabKey(tab.content) : null;
};

test('opening: Settings open on Appearance, a deep link opens its section, and the last section is remembered', () => {
  setup();
  assert.equal(L.getLayout().settingsOpen, undefined);
  L.openSettings();
  assert.equal(L.getLayout().settingsOpen, true);
  assert.equal(L.getLayout().settingsSection, 'appearance');
  L.setSettingsSection('engines');
  L.closeSettings();
  assert.equal(L.getLayout().settingsOpen, false);
  L.openSettings();
  assert.equal(L.getLayout().settingsSection, 'engines', 'reopens on the section last shown');
  L.openSettings('super');
  assert.equal(L.getLayout().settingsSection, 'super', 'a deep link (the SuperAgent limits) picks its section');
  L.closeSettings();
});

test('hidden, not closed: tabs, panes, focus and panels come back exactly as they were', () => {
  setup();
  L.openToSide({ kind: 'issues' });
  L.setRightPanel(true);
  L.setTerminal(true);
  const before = L.getLayout();
  L.openSettings('comms');
  L.setSettingsSection('about');
  L.closeSettings();
  const after = L.getLayout();
  for (const key of ['tabs', 'panes', 'focused', 'rightPanel', 'rightView', 'terminal', 'sidebar', 'rail', 'paneWeights', 'maximized'] as const) {
    assert.deepEqual(after[key], before[key], `${key} unchanged`);
  }
});

test('opening a tab from anywhere (the palette, a link) leaves Settings for it', () => {
  setup();
  L.openSettings();
  L.open({ kind: 'pullRequests' });
  assert.equal(L.getLayout().settingsOpen, false);
  assert.equal(focusedKey(), 'pullRequests');
});

test('never saved open: a reload starts in the app, on the remembered section', () => {
  setup();
  L.openSettings('engines');
  const stored = JSON.parse(saved.get('podcode:layout') ?? '{}');
  assert.equal('settingsOpen' in stored, false);
  assert.equal(stored.settingsSection, 'engines');
  L.closeSettings();
});

test('Cmd+[ closes Settings while they are open, and moves back through tabs otherwise (ACH-D69)', () => {
  setup();
  assert.equal(focusedKey(), 'agent:cy');
  L.openSettings();
  press('BracketLeft');
  assert.equal(L.getLayout().settingsOpen, false, 'closed');
  assert.equal(focusedKey(), 'agent:cy', 'and the tab did not move');
  press('BracketLeft');
  assert.equal(focusedKey(), 'agent:fen', 'with Settings closed it is Back again');
});

test('ACH-D81: Settings have no shortcuts of their own; Cmd+1 to Cmd+5 do nothing while open, and pick a tab otherwise', () => {
  setup();
  L.openSettings('appearance');
  for (const n of [1, 2, 3, 4, 5, 6, 9]) press(`Digit${n}`);
  assert.equal(L.getLayout().settingsSection, 'appearance', 'no section was picked by a digit');
  assert.equal(L.getLayout().settingsOpen, true);
  assert.equal(focusedKey(), 'agent:cy', 'and no tab was picked behind Settings');
  L.closeSettings();
  press('Digit1');
  assert.equal(focusedKey(), 'comms', 'closed, Cmd+1 picks the first tab as before');
});

test('shortcuts on the hidden tabs and panels do nothing while Settings are open', () => {
  setup();
  L.openSettings();
  const before = L.getLayout();
  ran.length = 0;
  for (const code of ['KeyW', 'BracketRight', 'KeyB', 'KeyJ']) press(code);
  assert.deepEqual(ran, [], 'Cmd+W, Cmd+], Cmd+B and Cmd+J wait');
  press('BracketLeft', { shift: true });
  const after = L.getLayout();
  assert.deepEqual(after.tabs, before.tabs, 'Cmd+W closed no hidden tab');
  assert.equal(after.focused, before.focused);
  assert.equal(after.sidebar, before.sidebar, 'Cmd+B left the sidebar alone');
  assert.equal(after.settingsOpen, true);
  press('KeyK');
  press('Comma');
  assert.deepEqual(ran, ['palette', 'settings'], 'the palette and Settings still run');
  L.closeSettings();
});

test('settingsShortcut: Back closes, openers run, the rest wait (digits included)', () => {
  const kind = (code: string, shift = false) => settingsShortcut(shortcutFor({ code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: shift }, true)!).kind;
  assert.equal(kind('BracketLeft'), 'close');
  assert.deepEqual(settingsShortcut({ kind: 'pickTab', n: 3 }), { kind: 'ignore' });
  for (const code of ['KeyK', 'Comma', 'KeyN']) assert.equal(kind(code), 'run', code);
  assert.equal(kind('Space', true), 'run', 'the SuperAgent quick bar');
  for (const code of ['KeyW', 'BracketRight', 'KeyB', 'KeyJ']) assert.equal(kind(code), 'ignore', code);
});

test('Esc closes Settings unless something took it: a dialog, a popover, a modifier, an IME', () => {
  const key = { key: 'Escape', defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  assert.equal(settingsEscape(key, false), true);
  assert.equal(settingsEscape(key, true), false, 'a dialog or popover open takes it first');
  assert.equal(settingsEscape({ ...key, defaultPrevented: true }, false), false);
  assert.equal(settingsEscape({ ...key, shiftKey: true }, false), false);
  assert.equal(settingsEscape({ ...key, isComposing: true }, false), false);
  assert.equal(settingsEscape({ ...key, key: 'Enter' }, false), false);
  const app = read('web/App.tsx');
  assert.match(app, /addEventListener\('keydown', onKey, true\)/, 'capture phase, so a hidden pane (an approval, a thread) never takes it');
  assert.match(app, /if \(!settingsOpen \|\| dialog\) return;/, 'not while an app dialog is open');
});

test('the section list: arrows, Home and End move through the app sections', () => {
  assert.equal(sectionForKey('appearance', { key: 'ArrowDown' }, true, APP_SECTION_IDS), 'comms');
  assert.equal(sectionForKey('appearance', { key: 'ArrowUp' }, true, APP_SECTION_IDS), 'about');
  assert.equal(sectionForKey('super', { key: 'End' }, true, APP_SECTION_IDS), 'about');
  assert.equal(sectionForKey('general', { key: 'ArrowDown' }, true), 'soul', 'the agent dialog keeps its own list');
  assert.equal(isAppSection('engines'), true);
  assert.equal(isAppSection('general'), false);
});

test('wiring: every way in opens the page; the modal path is gone', () => {
  const app = read('web/App.tsx');
  assert.match(app, /settings: \(\) => openSettings\(\)/, 'the gear, Cmd+, the palette and Home all call actions.settings');
  assert.match(app, /openSettings\(isAppSection\(group\) \? group : undefined\)/, 'deep links open their section');
  assert.match(app, /onShowAbout\?\.\(\(\) => openSettings\('about'\)\)/, 'the app menu About opens About');
  assert.doesNotMatch(app, /\bSettingsDialog\b|kind: 'settings'/);
  assert.equal(fs.existsSync(new URL('../web/dialogs/SettingsDialog.tsx', import.meta.url)), false);
  const page = read('web/panes/SettingsPage.tsx');
  assert.doesNotMatch(page, /Modal/, 'the page body, without Modal');
  assert.match(page, /Group|Row|Segmented|Toggle/);
  const sidebar = read('web/sidebar/Sidebar.tsx');
  assert.match(sidebar, /<HeaderButton data-settings-gear icon=\{Settings\}/, 'the gear in the foot row');
  assert.match(sidebar, /<RailAction icon=\{ArrowLeft\} label="Back" onClick=\{closeSettings\} \/>/, 'Back where the gear was, as a rail row, with no Esc hint (ACH-D81)');
  const nav = sidebar.slice(sidebar.indexOf('function SettingsNav'), sidebar.indexOf('\n}\n', sidebar.indexOf('function SettingsNav')));
  assert.doesNotMatch(nav, /hint=|Kbd|Mod\+/, 'no shortcut hints anywhere in the Settings navigation');
  assert.doesNotMatch(read('web/panes/SettingsPage.tsx'), /<Kbd|SHORTCUT/, 'nor on the page');
  assert.match(sidebar, /if \(settingsOpen\) return true;/, 'the full column shows the sections even when folded');
  assert.match(read('web/ui/CommandPalette.tsx'), /run: actions\.settings/);
  const shortcuts = read('web/shortcuts.ts');
  assert.match(shortcuts, /if \(settingsShortcutStep\(action\)\) return true;/, 'runShortcut asks Settings first');
  assert.match(shortcuts, /case 'back': goBack\(\); break;/, 'and Cmd+[ is Back otherwise');
  assert.match(shortcuts, /if \(!settingsOpen\) cycleTab/, 'Ctrl+Tab waits too');
});

test('motion: 180ms, opacity and transform only, instant under reduced motion; hidden layers stay mounted', () => {
  const css = read('web/styles.css');
  const block = css.slice(css.indexOf('.settings-stack'));
  assert.match(block, /opacity 90ms[^;]*transform 90ms[^;]*visibility 0s linear 90ms/, 'the layer leaving: the first 90ms');
  assert.match(block, /opacity 100ms [^;]*80ms, transform 100ms [^;]*80ms/, 'the layer arriving: 80ms to 180ms');
  assert.doesNotMatch(block.slice(0, block.indexOf('@media')), /transition:[^;]*(width|height|left|top|margin)/, 'nothing that reflows');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/);
  assert.doesNotMatch(block, /box-shadow/);
  const app = read('web/App.tsx');
  assert.match(app, /data-swap="main" data-shown=\{!settingsOpen\} inert=\{settingsOpen\}/, 'the app is hidden and inert, not unmounted');
  assert.match(app, /data-swap="page" data-shown=\{settingsOpen\} inert=\{!settingsOpen\}/);
});
