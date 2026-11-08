// How side-by-side panes share the width: each has a weight (1 unless the user dragged), and a
// divider moves width between its two neighbours only. Pure, so it is tested directly.

/** The narrowest a pane gets while dragging, in px. */
export const PANE_MIN_PX = 240;

export function weightOf(weights: Record<string, number> | undefined, paneId: string): number {
  const w = weights?.[paneId];
  return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * New weights after dragging the divider between `left` and `right` by `delta` px. Only those two
 * change, and their sum stays the same, so every other pane keeps its width. Each stays at least
 * `min` px wide (or half the pair, if the pair is narrower than two minimums).
 */
export function resizePair(
  weights: Record<string, number> | undefined,
  left: { id: string; px: number },
  right: { id: string; px: number },
  delta: number,
  min = PANE_MIN_PX,
): Record<string, number> {
  const total = left.px + right.px;
  if (total <= 0) return { ...weights };
  const floor = Math.min(min, total / 2);
  const leftPx = Math.min(total - floor, Math.max(floor, left.px + delta));
  const sum = weightOf(weights, left.id) + weightOf(weights, right.id);
  const leftWeight = (sum * leftPx) / total;
  return { ...weights, [left.id]: round(leftWeight), [right.id]: round(sum - leftWeight) };
}

/** Both sides of a divider back to an even split of what they have together. */
export function evenPair(weights: Record<string, number> | undefined, leftId: string, rightId: string): Record<string, number> {
  const half = (weightOf(weights, leftId) + weightOf(weights, rightId)) / 2;
  return { ...weights, [leftId]: round(half), [rightId]: round(half) };
}

/** Weights kept only for panes that exist. */
export function prunedWeights(weights: Record<string, number> | undefined, paneIds: string[]): Record<string, number> | undefined {
  if (!weights) return undefined;
  const kept = Object.fromEntries(Object.entries(weights).filter(([id]) => paneIds.includes(id)));
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * A pane's flex-grow: its weight as a share of all the panes' weights. Flexbox leaves free space
 * empty when the grows add up to less than 1 (one pane left at 0.5 fills half the width), so the
 * shares always add up to exactly 1.
 */
export function paneGrow(weights: Record<string, number> | undefined, paneIds: string[], paneId: string): number {
  const total = paneIds.reduce((sum, id) => sum + weightOf(weights, id), 0);
  return total > 0 ? weightOf(weights, paneId) / total : 1;
}

/** Weights after panes close: each closed pane's weight goes to the nearest kept pane before it (or after, at the start). */
export function closedWeights(weights: Record<string, number> | undefined, before: string[], kept: string[]): Record<string, number> | undefined {
  if (kept.length < 2) return undefined;
  const next = { ...weights };
  for (const id of before) {
    if (kept.includes(id)) continue;
    const index = before.indexOf(id);
    const heir = [...before.slice(0, index)].reverse().find(p => kept.includes(p)) ?? before.slice(index + 1).find(p => kept.includes(p));
    if (heir) next[heir] = weightOf(next, heir) + weightOf(weights, id);
  }
  return prunedWeights(next, kept);
}

const round = (n: number) => Math.round(n * 1000) / 1000;
