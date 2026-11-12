import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPanelTabs, labelWidth, MORE_WIDTH, stripKeyTarget, TAB_GAP, TAB_ICON_WIDTH, type FitTab, type TabsFit } from '../web/right/panelTabsFit.ts';

const SUPER: FitTab<string>[] = ['Overview', 'Decisions', 'Goals', 'Routines', 'Comms', 'Notes', 'Work'].map(label => ({ view: label.toLowerCase(), label }));
const AGENT: FitTab<string>[] = ['Overview', 'Comms', 'Changes', 'Notes', 'Work'].map(label => ({ view: label.toLowerCase(), label }));

/** n icons and the gaps between them. */
const width = (n: number) => n * TAB_ICON_WIDTH + Math.max(0, n - 1) * TAB_GAP;

/** The width the strip takes for a fit, with the same gaps the panel uses. */
function used(tabs: FitTab<string>[], fit: TabsFit<string>, active: string): number {
  const shown = tabs.filter(t => fit.visible.includes(t.view));
  const items = shown.map(t => TAB_ICON_WIDTH + (fit.allLabelled || (t.view === active && fit.activeLabelled) ? labelWidth(t.label, t.count) : 0));
  if (fit.overflow.length) items.push(MORE_WIDTH);
  return items.reduce((a, b) => a + b, 0) + Math.max(0, items.length - 1) * TAB_GAP;
}

test('the strip folds in order (ACH-D36): other names, then other tabs into "…", the open name last', () => {
  const wide = fitPanelTabs(SUPER, 'overview', 2000);
  assert.deepEqual([wide.allLabelled, wide.activeLabelled, wide.overflow.length], [true, true, 0]);
  // 7 icons and gaps take 234px; "Overview" adds 62px.
  const middling = fitPanelTabs(SUPER, 'overview', 305);
  assert.deepEqual([middling.allLabelled, middling.activeLabelled, middling.overflow.length], [false, true, 0], 'only the open tab keeps its name');
  const tight = fitPanelTabs(SUPER, 'overview', 240);
  assert.deepEqual([tight.allLabelled, tight.activeLabelled], [false, true], 'the open tab keeps its name');
  assert.deepEqual(tight.visible, ['overview', 'decisions', 'goals', 'routines']);
  assert.deepEqual(tight.overflow, ['comms', 'notes', 'work'], 'the last other tabs go into the menu first');
  const narrow = fitPanelTabs(SUPER, 'overview', 214);
  assert.equal(narrow.activeLabelled, true, 'still named at the panel\'s narrowest');
  assert.deepEqual(narrow.visible, ['overview', 'decisions', 'goals']);
  assert.deepEqual(narrow.overflow, ['routines', 'comms', 'notes', 'work']);
  const tiny = fitPanelTabs(SUPER, 'overview', 120);
  assert.equal(tiny.activeLabelled, false, 'only when the open tab, its name and "…" do not fit does the name go');
  assert.deepEqual(tiny.visible, ['overview', 'decisions']);
});

test('the open tab always stays in the strip, even when it is one of the last', () => {
  const fit = fitPanelTabs(SUPER, 'work', 214);
  assert.ok(fit.visible.includes('work'));
  assert.ok(!fit.overflow.includes('work'));
  assert.equal(fit.visible.length + fit.overflow.length, SUPER.length, 'every tab is somewhere, once');
  // Work keeps its name (34px), so one more tab than with icons alone goes into "…" (ACH-D36).
  assert.equal(fit.activeLabelled, true);
  assert.deepEqual(fit.visible, ['overview', 'decisions', 'goals', 'work']);
});

test('at every width, for the SuperAgent and an agent, the tabs never take more room than the strip has', () => {
  for (const tabs of [SUPER, AGENT]) {
    for (const active of tabs.map(t => t.view)) {
      // From the smallest strip that can show anything (one tab and the "…" button); the panel's
      // narrowest (260px) leaves the strip about 214px.
      for (let available = TAB_ICON_WIDTH + TAB_GAP + MORE_WIDTH; available <= 700; available += 2) {
        const fit = fitPanelTabs(tabs, active, available);
        assert.ok(used(tabs, fit, active) <= available, `${tabs.length} tabs, ${active} open, ${available}px: ${used(tabs, fit, active)}px used`);
        assert.ok(fit.visible.includes(active), `${active} stays visible at ${available}px`);
      }
    }
  }
});

test('a count makes the open name wider, so other tabs move into "…" sooner; the name stays', () => {
  assert.ok(labelWidth('Decisions', 3) > labelWidth('Decisions'));
  const withCount = SUPER.map(t => (t.view === 'decisions' ? { ...t, count: 12 } : t));
  // "Decisions" adds 69px to the 234px of icons, its count 22px more.
  const plain = fitPanelTabs(SUPER, 'decisions', 305);
  const counted = fitPanelTabs(withCount, 'decisions', 305);
  assert.deepEqual([plain.activeLabelled, plain.overflow.length], [true, 0]);
  assert.equal(counted.activeLabelled, true);
  assert.ok(counted.overflow.length > 0 && counted.visible.includes('decisions'));
});

test('a tab you open shows its name from the panel\'s narrowest (260px, a 214px strip) up, for every tab (ACH-D35, ACH-D36)', () => {
  // The bug: at a usual width, opening a tab often left it an icon, because its name folded before
  // any other tab moved into the "…" menu.
  const superWithCounts = SUPER.map(t => (t.view === 'decisions' ? { ...t, count: 99 } : t.view === 'goals' ? { ...t, count: 12 } : t.view === 'routines' ? { ...t, count: 3 } : t.view === 'comms' ? { ...t, count: 4 } : t));
  const agentWithCount = AGENT.map(t => (t.view === 'comms' ? { ...t, count: 7 } : t));
  for (const tabs of [SUPER, superWithCounts, AGENT, agentWithCount]) {
    for (const open of tabs.map(t => t.view)) {
      for (let available = 214; available <= 900; available += 1) {
        const fit = fitPanelTabs(tabs, open, available);
        assert.ok(fit.activeLabelled, `${open} open at ${available}px (${tabs.length} tabs) shows its name`);
        assert.ok(fit.visible.includes(open));
      }
    }
  }
});

test('arrow keys, Home and End never lose focus: the tab they reach is always in the strip', () => {
  assert.equal(stripKeyTarget(['a', 'b', 'c'], 'c', 'ArrowRight'), 'a', 'wraps');
  assert.equal(stripKeyTarget(['a', 'b', 'c'], 'a', 'ArrowLeft'), 'c');
  assert.equal(stripKeyTarget(['a', 'b', 'c'], 'b', 'Home'), 'a');
  assert.equal(stripKeyTarget(['a', 'b', 'c'], 'b', 'End'), 'c');
  assert.equal(stripKeyTarget(['a', 'b', 'c'], 'b', 'Enter'), null);
  // The key opens the tab it reaches; at every width the open tab is shown, so focus can go there.
  for (const tabs of [SUPER, AGENT]) {
    const views = tabs.map(t => t.view);
    for (let available = TAB_ICON_WIDTH + TAB_GAP + MORE_WIDTH; available <= 700; available += 6) {
      for (const from of views) {
        for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
          const to = stripKeyTarget(views, from, key)!;
          assert.ok(fitPanelTabs(tabs, to, available).visible.includes(to), `${key} from ${from} at ${available}px reaches ${to}, which is shown`);
        }
      }
    }
  }
});
