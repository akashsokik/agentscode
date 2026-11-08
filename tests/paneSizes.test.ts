import assert from 'node:assert/strict';
import test from 'node:test';
import { closedWeights, evenPair, paneGrow, prunedWeights, resizePair, weightOf } from '../web/paneSizes.ts';
import { closePane, closeTab, getLayout, open, setPaneWeights, splitPane, toggleMaximize } from '../web/layout.ts';

test('a divider moves width between its two panes only, within the minimum', () => {
  assert.equal(weightOf(undefined, 'a'), 1);
  assert.equal(weightOf({ a: -2 }, 'a'), 1);
  // Two 500px panes, drag 200px right: 700 / 300, the pair's total weight unchanged.
  const w = resizePair({ c: 1.5 }, { id: 'a', px: 500 }, { id: 'b', px: 500 }, 200);
  assert.deepEqual(w, { c: 1.5, a: 1.4, b: 0.6 });
  // Can't squeeze a pane under the minimum.
  assert.deepEqual(resizePair(undefined, { id: 'a', px: 500 }, { id: 'b', px: 500 }, 900, 240), { a: 1.52, b: 0.48 });
  assert.deepEqual(resizePair(undefined, { id: 'a', px: 500 }, { id: 'b', px: 500 }, -900, 240), { a: 0.48, b: 1.52 });
  // A pair narrower than two minimums splits evenly at most.
  assert.deepEqual(resizePair(undefined, { id: 'a', px: 200 }, { id: 'b', px: 200 }, 150, 240), { a: 1, b: 1 });
  assert.deepEqual(evenPair({ a: 1.4, b: 0.6, c: 2 }, 'a', 'b'), { a: 1, b: 1, c: 2 });
  assert.deepEqual(prunedWeights({ a: 1, gone: 2 }, ['a']), { a: 1 });
  assert.equal(prunedWeights({ gone: 2 }, ['a']), undefined);
});

test('splitting halves a pane, closing hands its width to its neighbour, maximize toggles', () => {
  const first = getLayout().panes[0].id;
  setPaneWeights({ [first]: 2 });
  splitPane(first);
  let layout = getLayout();
  const second = layout.panes[1].id;
  assert.deepEqual(layout.paneWeights, { [first]: 1, [second]: 1 }, 'the new pane takes half of the one it split');

  toggleMaximize(second);
  assert.equal(getLayout().maximized, second);
  toggleMaximize(second);
  assert.equal(getLayout().maximized, null);

  toggleMaximize(second);
  setPaneWeights({ [first]: 0.5, [second]: 1.5 });
  closePane(second);
  layout = getLayout();
  assert.equal(layout.panes.length, 1);
  assert.equal(layout.maximized, null, 'closing the maximized pane restores the layout');
  assert.equal(layout.paneWeights, undefined, 'a lone pane needs no weights');
});

test('pane grows always add up to 1, so a lone pane left at 0.5 still fills the width', () => {
  assert.equal(paneGrow({ a: 0.5 }, ['a'], 'a'), 1);
  assert.equal(paneGrow(undefined, ['a', 'b'], 'a'), 0.5);
  assert.equal(paneGrow({ a: 0.25, b: 0.25, c: 0.5 }, ['a', 'b', 'c'], 'c'), 0.5);
  assert.equal(paneGrow({ a: 0.25, b: 0.25 }, ['a', 'b', 'c'], 'c'), 2 / 3);
});

test('closed panes hand their weight to the nearest kept pane', () => {
  assert.deepEqual(closedWeights({ a: 0.5, b: 0.25, c: 0.25 }, ['a', 'b', 'c'], ['a', 'c']), { a: 0.75, c: 0.25 });
  assert.deepEqual(closedWeights({ a: 0.5, b: 0.25, c: 0.25 }, ['a', 'b', 'c'], ['b', 'c']), { b: 0.75, c: 0.25 });
  assert.equal(closedWeights({ a: 0.5, b: 0.5 }, ['a', 'b'], ['a']), undefined, 'a lone pane needs no weight');
});

test('closing the tab of a split pane leaves the other pane filling the width', () => {
  open({ kind: 'agent', agentId: 'tab-a' });
  open({ kind: 'agent', agentId: 'tab-b' });
  const first = getLayout().panes[0].id;
  splitPane(first);
  let layout = getLayout();
  assert.equal(layout.panes.length, 2);
  const closing = layout.tabs.find(t => t.id === layout.panes[1].tabId)!;
  closeTab(closing.id);
  layout = getLayout();
  assert.equal(layout.panes.length, 1);
  assert.equal(layout.paneWeights, undefined, 'no half weight left behind');
});
