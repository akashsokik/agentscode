/**
 * Back and Forward through the tabs you focused (ACH-31, ACH-D69): a browser-style visit stack,
 * ported from MonoCode's features/workspace/model/tabVisitHistory.ts. Pure, so it is tested
 * directly; web/layout.ts keeps one for the window and feeds it the focused main-pane tab.
 */

/** At most this many steps back (and forward). */
export const MAX_VISITS = 50;

export interface TabVisits {
  back: string[];
  forward: string[];
  /** The tab in focus, or null when no pane shows one. */
  current: string | null;
}

export function emptyTabVisits(current: string | null): TabVisits {
  return { back: [], forward: [], current };
}

export const canVisitBack = (h: TabVisits) => h.back.length > 0;
export const canVisitForward = (h: TabVisits) => h.forward.length > 0;

/** A new visit: the tab in focus goes onto Back, and Forward is cleared. The same tab again is no visit. */
export function recordVisit(h: TabVisits, id: string | null): TabVisits {
  if (h.current === id) return h;
  if (id === null) return { ...h, current: null };
  return { back: h.current === null ? h.back : push(h.back, h.current), forward: [], current: id };
}

/** One step back, or null at the start. */
export function visitBack(h: TabVisits): TabVisits | null {
  if (!h.back.length) return null;
  const id = h.back[h.back.length - 1];
  return { back: h.back.slice(0, -1), forward: h.current === null ? h.forward : [h.current, ...h.forward].slice(0, MAX_VISITS), current: id };
}

/** One step forward, or null at the end. */
export function visitForward(h: TabVisits): TabVisits | null {
  if (!h.forward.length) return null;
  const [id, ...forward] = h.forward;
  return { back: h.current === null ? h.back : push(h.back, h.current), forward, current: id };
}

/**
 * Closed tabs leave the history; `current` moves onto the tab now in focus when its own is gone.
 * Neighbouring repeats left by a removal collapse, so one step never lands on the same tab.
 */
export function pruneVisits(h: TabVisits, open: ReadonlySet<string>, focused: string | null): TabVisits {
  const back = h.back.filter(id => open.has(id));
  const forward = h.forward.filter(id => open.has(id));
  const current = h.current !== null && open.has(h.current) ? h.current : focused !== null && open.has(focused) ? focused : null;
  const deduped = (list: string[]) => list.filter((id, i) => id !== list[i - 1]);
  const b = deduped(back);
  while (b.length && b[b.length - 1] === current) b.pop();
  const f = deduped(forward);
  while (f.length && f[0] === current) f.shift();
  return sameVisits(h, { back: b, forward: f, current }) ? h : { back: b, forward: f, current };
}

function push(stack: string[], id: string): string[] {
  if (stack[stack.length - 1] === id) return stack;
  const next = [...stack, id];
  return next.length > MAX_VISITS ? next.slice(-MAX_VISITS) : next;
}

function sameVisits(a: TabVisits, b: TabVisits): boolean {
  return a.current === b.current && a.back.length === b.back.length && a.forward.length === b.forward.length
    && a.back.every((id, i) => id === b.back[i]) && a.forward.every((id, i) => id === b.forward[i]);
}
