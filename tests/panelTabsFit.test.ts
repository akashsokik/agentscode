import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPanelTabs, labelWidth, MORE_WIDTH, stripKeyTarget, TAB_GAP, TAB_ICON_WIDTH, type FitTab, type TabsFit } from '../web/right/panelTabsFit.ts';

const SUPER: FitTab<string>[] = ['Overview', 'Decisions', 'Goals', 'Routines', 'Comms', 'Notes', 'Work'].map(label => ({ view: label.toLowerCase(), label }));
const AGENT: FitTab<string>[] = ['Overview', 'Comms', 'Changes', 'Notes', 'Work'].map(label => ({ view: label.toLowerCase(), label }));

/** The width the strip takes for a fit, with the same gaps the panel uses. */
function used(tabs: FitTab<string>[], fit: TabsFit<string>, active: string): number {
  const shown = tabs.filter(t => fit.visible.includes(t.view));
  const items = shown.map(t => TAB_ICON_WIDTH + (fit.allLabelled || (t.view === active && fit.activeLabelled) ? labelWidth(t.label, t.count) : 0));
  if (fit.overflow.length) items.push(MORE_WIDTH);
  return items.reduce((a, b) => a + b, 0) + Math.max(0, items.length - 1) * TAB_GAP;
}

test('the strip folds in order: other names, the open tab\'s name, then a "…" menu', () => {
  const wide = fitPanelTabs(SUPER, 'overview', 2000);
  assert.deepEqual([wide.allLabelled, wide.activeLabelled, wide.overflow.length], [true, true, 0]);
  const middling = fitPanelTabs(SUPER, 'overview', 300);
  assert.deepEqual([middling.allLabelled, middling.activeLabelled, middling.overflow.length], [false, true, 0], 'only the open tab keeps its name');
  const tight = fitPanelTabs(SUPER, 'overview', 240);
  assert.deepEqual([tight.allLabelled, tight.activeLabelled, tight.overflow.length], [false, false, 0], 'icons only, all of them');
  const narrow = fitPanelTabs(SUPER, 'overview', 214);
  assert.equal(narrow.activeLabelled, false);
  assert.deepEqual(narrow.visible, ['overview', 'decisions', 'goals', 'routines', 'comms']);
  assert.deepEqual(narrow.overflow, ['notes', 'work'], 'the last tabs go into the menu');
});

test('the open tab always stays in the strip, even when it is one of the last', () => {
  const fit = fitPanelTabs(SUPER, 'work', 214);
  assert.ok(fit.visible.includes('work'));
  assert.ok(!fit.overflow.includes('work'));
  assert.equal(fit.visible.length + fit.overflow.length, SUPER.length, 'every tab is somewhere, once');
  assert.deepEqual(fit.visible, ['overview', 'decisions', 'goals', 'routines', 'work']);
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

test('a count badge makes the open tab\'s name wider, so it folds sooner', () => {
  assert.ok(labelWidth('Decisions', 3) > labelWidth('Decisions'));
  const withCount = SUPER.map(t => (t.view === 'decisions' ? { ...t, count: 12 } : t));
  // 7 icons and gaps take 234px; "Decisions" adds 69px, its count 22px more.
  const plainFit = fitPanelTabs(SUPER, 'decisions', 305);
  const countFit = fitPanelTabs(withCount, 'decisions', 305);
  assert.equal(plainFit.activeLabelled, true);
  assert.equal(countFit.activeLabelled, false);
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
