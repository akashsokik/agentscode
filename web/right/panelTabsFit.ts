// How the right panel's tabs fit their strip (ACH-D30: header controls never touch or overlap).
// The strip keeps one gap between tabs and before the collapse button. When it runs out of room it
// gives up, in order (ACH-D36): the other tabs' names, then the other tabs themselves, last first,
// which move into a "…" menu, and only when even the open tab with its name and the "…" button do
// not fit, the open tab's name. So a tab you open always shows its icon and name (ACH-D35: every
// tab alike), down to the panel's narrowest width. Pure, so it is tested directly.

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
  if (!open) return { allLabelled: false, activeLabelled: false, visible: [], overflow: [] };
  const openLabel = labelWidth(open.label, open.count);
  const everyLabel = tabs.reduce((sum, t) => sum + labelWidth(t.label, t.count), 0);
  // 1. Every name. 2. Only the open tab's name, every tab in the strip.
  if (width(tabs.length) + everyLabel <= available) return { allLabelled: true, activeLabelled: true, visible: views, overflow: [] };
  if (width(tabs.length) + openLabel <= available) return { allLabelled: false, activeLabelled: true, visible: views, overflow: [] };
  // 3. The open tab keeps its name; the last other tabs move into the "…" menu. k tabs take k
  //    icons, k gaps (the last one before "…"), the open tab's name and the "…" button.
  const keepNamed = Math.min(tabs.length - 1, Math.floor((available - openLabel - MORE_WIDTH) / (TAB_ICON_WIDTH + TAB_GAP)));
  if (keepNamed >= 1) return { allLabelled: false, activeLabelled: true, ...split(views, open.view, keepNamed) };
  // 4. Not even that: icons only, as many as fit with the "…" button, the open tab among them.
  if (width(tabs.length) <= available) return { allLabelled: false, activeLabelled: false, visible: views, overflow: [] };
  const keep = Math.min(tabs.length - 1, Math.max(1, Math.floor((available - MORE_WIDTH) / (TAB_ICON_WIDTH + TAB_GAP))));
  return { allLabelled: false, activeLabelled: false, ...split(views, open.view, keep) };
}

/** `keep` tabs in the strip, in their order, the open one always among them; the rest for the "…" menu. */
function split<V extends string>(views: V[], open: V, keep: number): { visible: V[]; overflow: V[] } {
  const others = views.filter(v => v !== open).slice(0, Math.max(0, keep - 1));
  const visible = views.filter(v => v === open || others.includes(v));
  return { visible, overflow: views.filter(v => !visible.includes(v)) };
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
