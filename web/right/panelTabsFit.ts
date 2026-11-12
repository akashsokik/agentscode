// How the right panel's tabs fit their strip (ACH-D30: header controls never touch or overlap).
// The strip keeps one gap between tabs and before the collapse button; when it runs out of room it
// gives up, in order: the other tabs' names, the open tab's name, then the last tabs, which move
// into a "…" menu. The open tab always stays in the strip. Pure, so it is tested directly.
//
// Every tab behaves the same (ACH-D35): whether the open tab shows its name is decided for the
// strip, not for the tab. Room is kept for the widest name (with its count), so at a given width
// either every tab shows its name when open or none does. Judged per tab, a short name (Overview,
// Notes) kept its label where a long one with a count (Decisions, Routines) lost it, so opening
// different tabs looked different.

/** An icon tab without its name (IconTab: 14px icon, 8px each side). */
export const TAB_ICON_WIDTH = 30;
/** The one gap between tabs, and before the "…" button (Tailwind gap-1). */
export const TAB_GAP = 4;
/** The "…" button that holds the tabs that do not fit. */
export const MORE_WIDTH = 30;

export interface FitTab<V extends string> {
  view: V;
  label: string;
  /** A count badge shows beside the name while the name shows. */
  count?: number;
}

export interface TabsFit<V extends string> {
  /** Every visible tab shows its name. */
  allLabelled: boolean;
  /** The open tab shows its name (always true when allLabelled). */
  activeLabelled: boolean;
  /** The tabs in the strip, in their order. */
  visible: V[];
  /** The tabs in the "…" menu, in their order. */
  overflow: V[];
}

/** A name's width at the strip's 12px, generous on purpose: wrongly too wide only folds earlier. */
export function labelWidth(label: string, count?: number): number {
  return 6 + Math.ceil(label.length * 7) + (count ? 22 : 0);
}

function width(n: number): number {
  return n <= 0 ? 0 : n * TAB_ICON_WIDTH + (n - 1) * TAB_GAP;
}

export function fitPanelTabs<V extends string>(tabs: FitTab<V>[], active: V, available: number): TabsFit<V> {
  const views = tabs.map(t => t.view);
  const open = tabs.find(t => t.view === active) ?? tabs[0];
  // The same for every tab: the widest name any tab would show when open (ACH-D35).
  const openLabel = tabs.reduce((widest, t) => Math.max(widest, labelWidth(t.label, t.count)), 0);
  const everyLabel = tabs.reduce((sum, t) => sum + labelWidth(t.label, t.count), 0);
  if (width(tabs.length) + everyLabel <= available) return { allLabelled: true, activeLabelled: true, visible: views, overflow: [] };
  if (width(tabs.length) + openLabel <= available) return { allLabelled: false, activeLabelled: true, visible: views, overflow: [] };
  if (width(tabs.length) <= available) return { allLabelled: false, activeLabelled: false, visible: views, overflow: [] };
  // Not even every icon fits: keep as many as fit with the "…" button, the open tab among them.
  // n icons, the gaps between them, one more gap and the "…" button.
  let keep = Math.max(1, Math.floor((available - MORE_WIDTH) / (TAB_ICON_WIDTH + TAB_GAP)));
  keep = Math.min(keep, tabs.length - 1);
  const first = views.slice(0, keep);
  const visible = open && !first.includes(open.view) ? [...first.slice(0, keep - 1), open.view] : first;
  return { allLabelled: false, activeLabelled: false, visible, overflow: views.filter(v => !visible.includes(v)) };
}

/**
 * The tab an arrow key, Home or End moves to among all the panel's tabs (wrapping), or null when
 * the key is not the strip's. It may be one in the "…" menu: picking it makes it the open tab,
 * which fitPanelTabs always keeps in the strip, so focus can follow it there after the re-render.
 */
export function stripKeyTarget<V extends string>(views: V[], current: V, key: string): V | null {
  const at = views.indexOf(current);
  if (at < 0 || !views.length) return null;
  if (key === 'ArrowRight') return views[(at + 1) % views.length];
  if (key === 'ArrowLeft') return views[(at - 1 + views.length) % views.length];
  if (key === 'Home') return views[0];
  if (key === 'End') return views[views.length - 1];
  return null;
}
