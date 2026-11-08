import assert from 'node:assert/strict';
import test from 'node:test';
import { evenPair, prunedWeights, resizePair, weightOf } from '../web/paneSizes.ts';
import { closePane, getLayout, setPaneWeights, splitPane, toggleMaximize } from '../web/layout.ts';

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
