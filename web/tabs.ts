// Pinned tabs (ACH-D27, variant B in ACH-D28): they sit first, keep their place across restarts,
// and Close others and Close to the right leave them alone. Pure over the tab list, so it is
// tested directly; web/layout.ts applies the results.

export interface PinnableTab {
  id: string;
  pinned?: boolean;
}

/** Pinned tabs first, each group in its own order. An older saved layout has no pins and stays as it was. */
export function orderTabs<T extends PinnableTab>(tabs: T[]): T[] {
  const pinned = tabs.filter(t => t.pinned);
  return pinned.length ? [...pinned, ...tabs.filter(t => !t.pinned)] : tabs;
}

/**
 * Pin or unpin a tab. A pinned tab goes to the end of the pinned group; an unpinned one to the
 * start of the rest, next to where it was.
 */
export function setPinned<T extends PinnableTab>(tabs: T[], tabId: string, pinned: boolean): T[] {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || Boolean(tab.pinned) === pinned) return tabs;
  const rest = tabs.filter(t => t.id !== tabId);
  const moved = { ...tab, pinned: pinned || undefined } as T;
  // Either way it lands on the border between the groups: last of the pinned, or first of the rest.
  return [...rest.filter(t => t.pinned), moved, ...rest.filter(t => !t.pinned)];
}

/** The tabs Close others would close: every unpinned tab but this one. */
export function othersToClose<T extends PinnableTab>(tabs: T[], tabId: string): T[] {
  return tabs.filter(t => t.id !== tabId && !t.pinned);
}

/** The tabs Close to the right would close: unpinned tabs after this one. */
export function rightToClose<T extends PinnableTab>(tabs: T[], tabId: string): T[] {
  const index = tabs.findIndex(t => t.id === tabId);
  return index === -1 ? [] : tabs.slice(index + 1).filter(t => !t.pinned);
}

/**
 * Move a tab to another tab's place, within its own group only: a pinned tab among the pinned,
 * a normal one among the normal. A move across the groups changes nothing.
 */
export function moveTab<T extends PinnableTab>(tabs: T[], tabId: string, targetId: string): T[] {
  const from = tabs.findIndex(t => t.id === tabId);
  const to = tabs.findIndex(t => t.id === targetId);
  if (from === -1 || to === -1 || from === to) return tabs;
  if (Boolean(tabs[from].pinned) !== Boolean(tabs[to].pinned)) return tabs;
  const next = [...tabs];
  const [tab] = next.splice(from, 1);
  next.splice(to, 0, tab);
  return next;
}
