/**
 * Terminal splits, as in Ghostty: each tab of the terminal panel is a tree whose leaves are
 * terminals and whose inner nodes split their area in two, side by side ("row") or stacked
 * ("column"). Pure functions, so the panel and the tests share them.
 *
 * The trees are only a layout. The shells are the server's list; reading a saved tree against
 * that list drops terminals that ended and adds new ones as tabs of their own.
 */

export type SplitDir = 'row' | 'column';
export type SplitTree =
  | { type: 'leaf'; id: string }
  | { type: 'split'; dir: SplitDir; ratio: number; a: SplitTree; b: SplitTree };

/** Fractions of the panel's body, 0 to 1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A split's divider: the node it belongs to (a path of a/b steps from the root) and its area. */
export interface Divider {
  path: string;
  dir: SplitDir;
  ratio: number;
  area: Rect;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

const leaf = (id: string): SplitTree => ({ type: 'leaf', id });
const EPSILON = 1e-6;

export function leaves(tree: SplitTree): string[] {
  return tree.type === 'leaf' ? [tree.id] : [...leaves(tree.a), ...leaves(tree.b)];
}

/** The tree without the terminals that are not `alive`; a split left with one side becomes that side. */
export function prune(tree: SplitTree, alive: (id: string) => boolean): SplitTree | null {
  if (tree.type === 'leaf') return alive(tree.id) ? tree : null;
  const a = prune(tree.a, alive);
  const b = prune(tree.b, alive);
  if (a && b) return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
  return a ?? b;
}

/**
 * The tabs to show: the saved trees, minus terminals that ended (and any terminal saved twice),
 * then each terminal no tree places as a tab of its own, in the order given. `hidden` keeps a
 * terminal out until it is placed, such as one a split is still creating.
 */
export function arrange(saved: SplitTree[] | undefined, ids: string[], hidden?: (id: string) => boolean): SplitTree[] {
  const alive = new Set(ids);
  const placed = new Set<string>();
  const trees: SplitTree[] = [];
  for (const tree of saved ?? []) {
    const kept = prune(tree, id => alive.has(id) && !placed.has(id));
    if (!kept) continue;
    for (const id of leaves(kept)) placed.add(id);
    trees.push(kept);
  }
  for (const id of ids) {
    if (!placed.has(id) && !hidden?.(id)) trees.push(leaf(id));
  }
  return trees;
}

export function treeIndexOf(trees: SplitTree[], id: string): number {
  return trees.findIndex(tree => leaves(tree).includes(id));
}

function replaceLeaf(tree: SplitTree, id: string, make: (old: SplitTree) => SplitTree): SplitTree {
  if (tree.type === 'leaf') return tree.id === id ? make(tree) : tree;
  const a = replaceLeaf(tree.a, id, make);
  const b = replaceLeaf(tree.b, id, make);
  return a === tree.a && b === tree.b ? tree : { ...tree, a, b };
}

/** Split `target` in two: it keeps the left or top half, `id` takes the other. Unknown target: a new tab. */
export function splitAt(trees: SplitTree[], target: string, id: string, dir: SplitDir): SplitTree[] {
  const index = treeIndexOf(trees, target);
  if (index === -1) return [...trees, leaf(id)];
  return trees.map((tree, i) => (i === index ? replaceLeaf(tree, target, old => ({ type: 'split', dir, ratio: 0.5, a: old, b: leaf(id) })) : tree));
}

/** Where every terminal of a tree sits. */
export function rects(tree: SplitTree, area: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (tree.type === 'leaf') {
    out.set(tree.id, area);
    return out;
  }
  const [first, second] = halves(area, tree.dir, tree.ratio);
  rects(tree.a, first, out);
  rects(tree.b, second, out);
  return out;
}

function halves(area: Rect, dir: SplitDir, ratio: number): [Rect, Rect] {
  if (dir === 'row') {
    const w = area.w * ratio;
    return [{ ...area, w }, { ...area, x: area.x + w, w: area.w - w }];
  }
  const h = area.h * ratio;
  return [{ ...area, h }, { ...area, y: area.y + h, h: area.h - h }];
}

export function dividers(tree: SplitTree, area: Rect = { x: 0, y: 0, w: 1, h: 1 }, path = '', out: Divider[] = []): Divider[] {
  if (tree.type === 'leaf') return out;
  out.push({ path, dir: tree.dir, ratio: tree.ratio, area });
  const [first, second] = halves(area, tree.dir, tree.ratio);
  dividers(tree.a, first, `${path}a`, out);
  dividers(tree.b, second, `${path}b`, out);
  return out;
}

export function setRatio(tree: SplitTree, path: string, ratio: number): SplitTree {
  if (tree.type === 'leaf') return tree;
  if (!path) return { ...tree, ratio };
  return path[0] === 'a' ? { ...tree, a: setRatio(tree.a, path.slice(1), ratio) } : { ...tree, b: setRatio(tree.b, path.slice(1), ratio) };
}

/** How many panes a tree lines up along `dir`, for equal sizes. */
function span(tree: SplitTree, dir: SplitDir): number {
  if (tree.type === 'leaf') return 1;
  return tree.dir === dir ? span(tree.a, dir) + span(tree.b, dir) : Math.max(span(tree.a, dir), span(tree.b, dir));
}

/** Every pane the same size along each run of same-direction splits, as Ghostty's equalize does. */
export function equalize(tree: SplitTree): SplitTree {
  if (tree.type === 'leaf') return tree;
  const a = span(tree.a, tree.dir);
  const b = span(tree.b, tree.dir);
  return { ...tree, ratio: a / (a + b), a: equalize(tree.a), b: equalize(tree.b) };
}

/** The next or previous terminal of the tree, wrapping around. */
export function cycle(tree: SplitTree, from: string, step: 1 | -1): string {
  const ids = leaves(tree);
  const index = ids.indexOf(from);
  return ids[(Math.max(0, index) + step + ids.length) % ids.length];
}

/** The terminal next to `from` in a direction, preferring the one that overlaps it most. */
export function neighbor(tree: SplitTree, from: string, direction: Direction): string | undefined {
  const all = rects(tree);
  const here = all.get(from);
  if (!here) return undefined;
  let best: { id: string; gap: number; overlap: number } | undefined;
  for (const [id, r] of all) {
    if (id === from) continue;
    const horizontal = direction === 'left' || direction === 'right';
    const gap = direction === 'left' ? here.x - (r.x + r.w)
      : direction === 'right' ? r.x - (here.x + here.w)
      : direction === 'up' ? here.y - (r.y + r.h)
      : r.y - (here.y + here.h);
    if (gap < -EPSILON) continue;
    const overlap = horizontal
      ? Math.min(here.y + here.h, r.y + r.h) - Math.max(here.y, r.y)
      : Math.min(here.x + here.w, r.x + r.w) - Math.max(here.x, r.x);
    if (overlap <= EPSILON) continue;
    if (!best || gap < best.gap - EPSILON || (Math.abs(gap - best.gap) <= EPSILON && overlap > best.overlap)) best = { id, gap, overlap };
  }
  return best?.id;
}

/** Which terminal takes over when `id` closes: the nearest one on the other side of its split. */
export function successor(tree: SplitTree, id: string): string | undefined {
  if (tree.type === 'leaf') return undefined;
  const inA = leaves(tree.a).includes(id);
  const inB = !inA && leaves(tree.b).includes(id);
  if (!inA && !inB) return undefined;
  const side = inA ? tree.a : tree.b;
  if (side.type === 'leaf') {
    const other = leaves(inA ? tree.b : tree.a);
    return inA ? other[0] : other[other.length - 1];
  }
  return successor(side, id);
}
