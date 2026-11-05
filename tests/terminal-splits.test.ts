import assert from 'node:assert/strict';
import test from 'node:test';
import { arrange, cycle, dividers, equalize, leaves, neighbor, rects, setRatio, splitAt, successor, treeIndexOf, type SplitTree } from '../web/terminal/splits.ts';

const leaf = (id: string): SplitTree => ({ type: 'leaf', id });

test('saved splits are read against the live terminals: ended ones fold away, new ones become tabs', () => {
  const saved: SplitTree[] = [
    { type: 'split', dir: 'row', ratio: 0.5, a: leaf('a'), b: { type: 'split', dir: 'column', ratio: 0.3, a: leaf('b'), b: leaf('c') } },
    leaf('d'),
  ];
  // b ended: its split gives the whole right side to c. e is new. d is gone.
  const tabs = arrange(saved, ['a', 'c', 'e']);
  assert.deepEqual(tabs, [{ type: 'split', dir: 'row', ratio: 0.5, a: leaf('a'), b: leaf('c') }, leaf('e')]);
  // Before the list arrives nothing shows, and nothing saved is lost: reading never writes.
  assert.deepEqual(arrange(saved, []), []);
  // A terminal saved in two trees shows once; one a split is still placing stays out.
  assert.deepEqual(arrange([leaf('a'), leaf('a')], ['a', 'z'], id => id === 'z'), [leaf('a')]);
});

test('splitting puts the new terminal right of or below its source, at half the space', () => {
  let tabs = splitAt([leaf('a'), leaf('x')], 'a', 'b', 'row');
  tabs = splitAt(tabs, 'b', 'c', 'column');
  assert.deepEqual(leaves(tabs[0]), ['a', 'b', 'c']);
  assert.equal(treeIndexOf(tabs, 'c'), 0);
  assert.equal(treeIndexOf(tabs, 'x'), 1);
  const at = rects(tabs[0]);
  assert.deepEqual(at.get('a'), { x: 0, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(at.get('b'), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.deepEqual(at.get('c'), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.deepEqual(dividers(tabs[0]).map(d => [d.path, d.dir]), [['', 'row'], ['b', 'column']]);
  // An unknown source: the new terminal gets a tab of its own.
  assert.equal(splitAt([leaf('a')], 'nope', 'b', 'row').length, 2);
});

test('moving between splits goes by direction, or in order with wrap-around', () => {
  // a | (b over c), and d under all of it.
  const tree: SplitTree = {
    type: 'split', dir: 'column', ratio: 0.6,
    a: { type: 'split', dir: 'row', ratio: 0.5, a: leaf('a'), b: { type: 'split', dir: 'column', ratio: 0.5, a: leaf('b'), b: leaf('c') } },
    b: leaf('d'),
  };
  assert.equal(neighbor(tree, 'a', 'right'), 'b'); // b and c touch a equally; the first found wins
  assert.equal(neighbor(tree, 'c', 'left'), 'a');
  assert.equal(neighbor(tree, 'b', 'down'), 'c');
  assert.equal(neighbor(tree, 'c', 'down'), 'd');
  assert.equal(neighbor(tree, 'd', 'up'), 'a'); // a overlaps d most
  assert.equal(neighbor(tree, 'a', 'left'), undefined);
  assert.equal(cycle(tree, 'd', 1), 'a');
  assert.equal(cycle(tree, 'a', -1), 'd');
});

test('closing a split hands focus to its other side; equalize and drag change ratios', () => {
  const tree: SplitTree = { type: 'split', dir: 'row', ratio: 0.5, a: leaf('a'), b: { type: 'split', dir: 'row', ratio: 0.5, a: leaf('b'), b: leaf('c') } };
  assert.equal(successor(tree, 'a'), 'b');
  assert.equal(successor(tree, 'c'), 'b');
  assert.equal(successor(tree, 'b'), 'c');
  assert.equal(successor(leaf('a'), 'a'), undefined);
  // Three side by side: the outer split gives one third to a.
  const even = equalize(setRatio(tree, 'b', 0.9));
  const at = rects(even);
  for (const id of ['a', 'b', 'c']) assert.ok(Math.abs(at.get(id)!.w - 1 / 3) < 1e-9, id);
  const dragged = setRatio(tree, 'b', 0.25);
  assert.equal(dragged.type === 'split' && dragged.b.type === 'split' ? dragged.b.ratio : null, 0.25);
});
