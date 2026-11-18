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
const { APP_SECTION_IDS, APP_SECTIONS, appSection, isAppSection, sectionForKey, sectionGroups } = await import('../web/settingsSections.ts');
const { SETTINGS_INDEX, searchSettings, sectionRows } = await import('../web/settingsIndex.ts');

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
  L.openSettings('limits');
  assert.equal(L.getLayout().settingsSection, 'limits', 'a deep link (the SuperAgent limits) picks its section');
  L.closeSettings();
});

test('hidden, not closed: tabs, panes, focus and panels come back exactly as they were', () => {
  setup();
  L.openToSide({ kind: 'issues' });
  L.setRightPanel(true);
  L.setTerminal(true);
  const before = L.getLayout();
  L.openSettings('messaging');
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
  assert.equal(sectionForKey('appearance', { key: 'ArrowDown' }, true, APP_SECTION_IDS), 'messaging');
  assert.equal(sectionForKey('appearance', { key: 'ArrowUp' }, true, APP_SECTION_IDS), 'about');
  assert.equal(sectionForKey('limits', { key: 'End' }, true, APP_SECTION_IDS), 'about');
  assert.equal(sectionForKey('general', { key: 'ArrowDown' }, true), 'soul', 'the agent dialog keeps its own list');
  assert.equal(isAppSection('engines'), true);
  assert.equal(isAppSection('general'), false);
});

test('wiring: every way in opens the page; the modal path is gone', () => {
  const app = read('web/App.tsx');
  assert.match(app, /settings: \(\) => openSettings\(\)/, 'the gear, Cmd+, the palette and Home all call actions.settings');
  assert.match(app, /openSettings\(appSection\(group\)\)/, 'deep links open their section, old ids included');
  assert.match(app, /onShowAbout\?\.\(\(\) => openSettings\('about'\)\)/, 'the app menu About opens About');
  assert.doesNotMatch(app, /\bSettingsDialog\b|kind: 'settings'/);
  assert.equal(fs.existsSync(new URL('../web/dialogs/SettingsDialog.tsx', import.meta.url)), false);
  const page = read('web/panes/SettingsPage.tsx');
  assert.doesNotMatch(page, /Modal/, 'the page body, without Modal');
  assert.match(page, /Group|Row|Segmented|Toggle/);
  const sidebar = read('web/sidebar/Sidebar.tsx');
  assert.match(sidebar, /<HeaderButton data-settings-gear icon=\{Settings\}/, 'the gear in the foot row');
  assert.match(sidebar, /<RailAction settings icon=\{ArrowLeft\} label="Back" onClick=\{closeSettings\} \/>/, 'Back where the gear was, as a rail row, with no Esc hint (ACH-D81)');
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

// ACH-D82: the layout after the user's reference (option A).

test('sections: grouped as in the demo, with Agent communication renamed Messaging and SuperAgent split', () => {
  assert.deepEqual(sectionGroups().map(g => [g.group, g.sections.map(s => s.label)]), [
    ['', ['Appearance']],
    ['Agents', ['Messaging', 'Engines']],
    ['SuperAgent', ['Autonomy', 'Limits']],
    ['PodCode', ['Storage', 'About']],
  ]);
  assert.ok(!APP_SECTIONS.some(s => s.label === 'Agent communication'));
});

test('deep links and saved layouts: the old section ids are aliases', () => {
  assert.equal(appSection('comms'), 'messaging');
  assert.equal(appSection('super'), 'limits', "the agent dialog's link to the SuperAgent limits");
  assert.equal(appSection('about'), 'about');
  assert.equal(appSection('general'), undefined, "the agent dialog's own sections are not the app's");
  assert.equal(isAppSection('comms'), false, 'aliases resolve; they are not sections');
  assert.match(read('web/layout.ts'), /const section = appSection\(restored\.settingsSection\);/, 'a layout saved on "super" reopens on Limits');
  assert.match(read('web/dialogs/AgentSettingsDialog.tsx'), /openSettingsAt\('super'\)/);
});

test('every setting has one row in the index, in a known section, with one line of description', () => {
  const ids = SETTINGS_INDEX.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const e of SETTINGS_INDEX) {
    assert.ok(isAppSection(e.section), e.id);
    assert.ok(e.title && e.description && !e.description.includes('\n'), e.id);
  }
  for (const id of APP_SECTION_IDS) assert.ok(sectionRows(id).length, `${id} has rows`);
  // Every control the old page had is still somewhere.
  const page = read('web/panes/SettingsPage.tsx');
  for (const field of ['awareness', 'messageLimit', 'shareActivity', 'autoTeamContext', 'browserEval', 'superAutonomy', 'superAskFirst', 'superPaused', 'superWake', 'superMaxWakesPerHour', 'superNotify', 'superDailyBudgetUsd', 'superMaxCreatesPerDay', 'superQuietFrom', 'superQuietTo', 'refreshModels', 'setTheme', 'setAvatarStyle']) {
    assert.match(page, new RegExp(`\\b${field}\\b`), field);
  }
  const storage = read('web/panes/StorageSettings.tsx');
  for (const id of ids) assert.ok(page.includes(`'${id}'`) || storage.includes(`"${id}"`) || /^(theme|avatars|awareness|autonomy|pause|version|updates|engine-|ask-)/.test(id), `${id} has a control`);
});

test('Search settings: rows then whole sections, as MonoCode lists them; every word must match', () => {
  const ids = (q: string) => searchSettings(q, 50).filter(r => r.settingId).map(r => r.settingId);
  assert.deepEqual(ids('budget'), ['message-budget', 'daily-budget']);
  assert.deepEqual(searchSettings('budget').map(r => r.sectionLabel), ['Messaging', 'Limits'], 'each says its section');
  assert.deepEqual(ids('DARK'), ['theme'], 'any case, keywords included');
  assert.deepEqual(ids('quiet hours'), ['quiet-hours']);
  assert.ok(ids('superagent').includes('autonomy') && ids('superagent').includes('super-wake'), 'the group name finds its rows');
  const pages = searchSettings('messaging').filter(r => r.settingId === null);
  assert.deepEqual(pages.map(r => r.section), ['messaging'], 'a section matches by name, as a Page result after the rows');
  assert.ok(searchSettings('a').length <= 8, 'at most eight, as MonoCode');
  assert.deepEqual(searchSettings('zzz'), []);
  assert.deepEqual(searchSettings('   '), [], 'blank is no search');
});

test('ACH-D83: Settings in MonoCode\'s own UI', () => {
  const page = read('web/panes/SettingsPage.tsx');
  // The shell (SettingsView.tsx): the 40px header bar with the breadcrumb and the search at its end.
  assert.match(page, /className="flex h-10 shrink-0 select-none items-center border-b border-stroke"/);
  assert.match(page, /<span className="shrink-0 text-content\/45">Settings<\/span>/);
  assert.match(page, /<SettingsSearch onReveal=\{onReveal\} \/>/);
  assert.match(page, /className="flex h-7 w-48 items-center gap-2 rounded-md border border-content\/10 px-2 text-content\/45 focus-within:border-content\/20"/);
  assert.match(page, /className="mx-auto w-full max-w-5xl px-5 py-6 pb-16 @min-\[560px\]\/settings:px-8 @min-\[560px\]\/settings:py-8"/);
  // PageHeader.
  assert.match(page, /<h1 className="text-\[20px\] font-semibold leading-tight text-content">/);
  assert.match(page, /className="mt-1\.5 max-w-xl text-\[13px\] leading-relaxed text-content\/45"/);
  // Segmented for small option sets, never a Select swap.
  assert.doesNotMatch(page, /<Select\b|Choice/);
  for (const label of ['Theme', 'Avatars', 'Autonomy']) assert.match(page, new RegExp(`<Segmented<\\w+> label="${label}"`), label);
  // Group and Row: MonoCode's classes, with its reveal flash.
  const mono = read('web/mono/settings.tsx');
  assert.match(mono, /className=\{`settings-row flex items-start gap-6 border-b border-content\/5 px-4 py-3\.5 transition-colors last:border-b-0 \$\{\n\s*flash \? "bg-accent\/10" : ""/);
  assert.match(mono, /className=\{`overflow-hidden rounded-xl border bg-content\/3 transition-colors \$\{\n\s*flash \? "border-accent\/60" : "border-content\/10"/);
  assert.match(mono, /const flash = id != null && revealed === id;/);
  assert.doesNotMatch(mono, /oneLine/);
  // The nav: MonoCode's SettingsNav and NavRow.
  const sidebar = read('web/sidebar/Sidebar.tsx');
  const nav = sidebar.slice(sidebar.indexOf('function SettingsNav'), sidebar.indexOf('\n}\n', sidebar.indexOf('function SettingsNav')));
  assert.match(nav, /flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-none px-2 py-3/);
  assert.match(nav, /px-2 pb-1 text-xs font-semibold text-content\/35/);
  assert.match(nav, /<RailAction settings icon=\{ArrowLeft\} label="Back" onClick=\{closeSettings\} \/>/, 'Back as a NavRow at the foot');
  assert.match(sidebar, /settings \? 'py-1\.5'/);
  assert.match(sidebar, /'text-content\/50 hover:bg-content\/5 hover:text-content'/);
  assert.doesNotMatch(nav, /Search settings/, 'search lives in the header bar, as in MonoCode');
  assert.doesNotMatch(nav + page, /hint=|<Kbd|SHORTCUT|shadow/, 'no shortcut hints, no shadows (ACH-D81)');
});
