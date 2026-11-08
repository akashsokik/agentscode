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

const round = (n: number) => Math.round(n * 1000) / 1000;
