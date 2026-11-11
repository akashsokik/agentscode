import { useSyncExternalStore } from 'react';
import type { Root } from './api.ts';
import { closedWeights, prunedWeights, weightOf } from './paneSizes.ts';
import type { SplitTree } from './terminal/splits.ts';

/** What a tab shows. Tabs are keyed by content, so opening the same thing twice focuses it. */
export type TabContent =
  | { kind: 'agent'; agentId: string }
  | { kind: 'file'; root: Root; path: string }
  | { kind: 'diff'; root: Root; path: string }
  | { kind: 'comms'; conversationId?: string }
  /** The Work view as a pane (web/work/WorkView.tsx). */
  | { kind: 'work' }
  | { kind: 'channel'; channelId: string }
  /** `title` names the tab before the walkthrough has loaded. */
  | { kind: 'walkthrough'; agentId: string; id: string; title: string }
  /**
   * A browser tab (web/browser.ts). Keyed by its id, so navigating keeps it the same tab; `url`
   * and `title` follow the page so a restored layout reloads where it was. `agentId`: an agent
   * opened it and may drive it.
   */
  | { kind: 'browser'; id: string; url: string; title?: string; agentId?: string | null };

export interface Tab {
  id: string;
  content: TabContent;
}

export interface Pane {
  id: string;
  tabId: string | null;
}

/** The navigation column's lists, each of which folds. */
export type RailSectionKey = 'channels' | 'agents' | 'projects';

export interface Layout {
  tabs: Tab[];
  panes: Pane[];
  focused: string;
  sidebar: boolean;
  sidebarView: 'agents' | 'files' | 'changes';
  /** The project the workspace column shows; the first project when unset or gone. */
  projectId?: string | null;
  /**
   * The navigation column at full width (true) or folded to an icon rail (false). Unset until
   * the user picks, so the default follows the window: folded below 1280px.
   */
  rail?: boolean;
  /** Navigation sections the user folded away; one not listed is open. */
  folded?: Partial<Record<RailSectionKey, boolean>>;
  /** Column widths the user dragged to, in px; a column without one uses its default. */
  widths?: Partial<Record<ColumnKey, number>>;
  rightPanel: boolean;
  rightView: 'overview' | 'comms' | 'changes' | 'notes' | 'work';
  /** The right panel's tab while the SuperAgent has focus, the last one picked; Decisions until then. */
  superView?: SuperView;
  /** The right panel was shown for the SuperAgent once; after that, opening it leaves the panel as you left it. */
  superPanelShown?: boolean;
  /** How side-by-side panes share the width, by pane id (web/paneSizes.ts); a pane without one weighs 1. */
  paneWeights?: Record<string, number>;
  /** The pane filling the whole width while the others wait, if one is maximized. */
  maximized?: string | null;
  /** The terminal panel under the panes: shown or hidden, and the height the user dragged it to. */
  terminal?: boolean;
  terminalHeight?: number;
  /** Each project's terminal in focus, by project id; its tab is the one in front. */
  terminalTabs?: Record<string, string>;
  /** Each project's terminal tabs as split trees. Read against the live list; written only by the user's actions. */
  terminalSplits?: Record<string, SplitTree[]>;
  /** The terminal filling its tab in each project, if one is zoomed. */
  terminalZoom?: Record<string, string>;
}

export type ColumnKey = 'nav' | 'workspace' | 'panel';

/** The right panel's tabs for the SuperAgent: its Overview, its own Decisions, Goals and Routines, Comms, and project Notes. */
export const SUPER_VIEWS = ['overview', 'decisions', 'goals', 'routines', 'comms', 'notes', 'work'] as const;
export type SuperView = (typeof SUPER_VIEWS)[number];

const STORAGE_KEY = 'agentscode:layout';
const MAX_PANES = 3;

export function rootKey(root: Root): string {
  return 'agent' in root ? `a:${root.agent}` : `p:${root.project}`;
}

export function tabKey(content: TabContent): string {
  switch (content.kind) {
    case 'agent': return `agent:${content.agentId}`;
    case 'file': return `file:${rootKey(content.root)}:${content.path}`;
    case 'diff': return `diff:${rootKey(content.root)}:${content.path}`;
    case 'comms': return 'comms';
    case 'work': return 'work';
    case 'channel': return `channel:${content.channelId}`;
    case 'walkthrough': return `walkthrough:${content.agentId}:${content.id}`;
    case 'browser': return `browser:${content.id}`;
  }
}

function initial(): Layout {
  const fallback: Layout = { tabs: [], panes: [{ id: 'p1', tabId: null }], focused: 'p1', sidebar: true, sidebarView: 'agents', rightPanel: true, rightView: 'overview' };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Layout | null;
    if (!saved || !Array.isArray(saved.tabs) || !Array.isArray(saved.panes) || !saved.panes.length) return fallback;
    // The SuperAgent's old in-pane sidebar kept its own open state and width; the right panel has its own now.
    const { superLog: _log, ...kept } = saved as Layout & { superLog?: unknown };
    const { superLog: _width, ...widths } = (kept.widths ?? {}) as Record<string, number>;
    const restored: Layout = { ...fallback, ...kept, ...(kept.widths ? { widths } : {}) };
    const ids = restored.panes.map(p => p.id);
    return { ...restored, paneWeights: prunedWeights(restored.paneWeights, ids), maximized: restored.maximized && ids.includes(restored.maximized) && ids.length > 1 ? restored.maximized : null };
  } catch {
    return fallback;
  }
}

let layout: Layout = initial();
const listeners = new Set<() => void>();

function set(next: Layout): void {
  layout = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // private mode or full storage: the layout just is not remembered
  }
  for (const listener of listeners) listener();
}

export function useLayout(): Layout {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => layout);
}

export function getLayout(): Layout {
  return layout;
}

/** Calls `listener` after every layout change; returns the unsubscribe. */
export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let nextId = 0;
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

function ensureTab(tabs: Tab[], content: TabContent): { tabs: Tab[]; tab: Tab } {
  const key = tabKey(content);
  const existing = tabs.find(t => tabKey(t.content) === key);
  if (existing) {
    // Comms tabs carry the selected conversation; keep the newest selection.
    if (content.kind === 'comms') {
      const tab = { ...existing, content };
      return { tabs: tabs.map(t => (t.id === existing.id ? tab : t)), tab };
    }
    return { tabs, tab: existing };
  }
  const tab = { id: newId('t'), content };
  return { tabs: [...tabs, tab], tab };
}

/** Show content in the focused pane, or in the pane that already shows it. */
export function open(content: TabContent): void {
  const { tabs, tab } = ensureTab(layout.tabs, content);
  const showing = layout.panes.find(p => p.tabId === tab.id);
  if (showing) {
    set({ ...layout, tabs, focused: showing.id });
    return;
  }
  const focused = layout.panes.find(p => p.id === layout.focused) ?? layout.panes[0];
  set({ ...layout, tabs, panes: layout.panes.map(p => (p.id === focused.id ? { ...p, tabId: tab.id } : p)), focused: focused.id });
}

/** Add a tab without showing it, unless it is there already. */
export function addTab(content: TabContent): void {
  const { tabs } = ensureTab(layout.tabs, content);
  if (tabs !== layout.tabs) set({ ...layout, tabs });
}

/** Follow a browser tab's page: its URL and title, for the tab strip and a restored layout. */
export function updateBrowserTab(id: string, patch: { url?: string; title?: string }): void {
  const tab = layout.tabs.find(t => t.content.kind === 'browser' && t.content.id === id);
  if (!tab || tab.content.kind !== 'browser') return;
  const next = { ...tab.content, ...patch };
  if (next.url === tab.content.url && next.title === tab.content.title) return;
  set({ ...layout, tabs: layout.tabs.map(t => (t.id === tab.id ? { ...t, content: next } : t)) });
}

/** Show content in a new pane to the right (or the rightmost pane when full). */
export function openToSide(content: TabContent): void {
  const { tabs, tab } = ensureTab(layout.tabs, content);
  const showing = layout.panes.find(p => p.tabId === tab.id);
  if (showing) {
    set({ ...layout, tabs, focused: showing.id });
    return;
  }
  if (layout.panes.length >= MAX_PANES) {
    const last = layout.panes[layout.panes.length - 1];
    set({ ...layout, tabs, panes: layout.panes.map(p => (p.id === last.id ? { ...p, tabId: tab.id } : p)), focused: last.id });
    return;
  }
  const focusedIndex = Math.max(0, layout.panes.findIndex(p => p.id === layout.focused));
  const pane = { id: newId('p'), tabId: tab.id };
  const panes = [...layout.panes.slice(0, focusedIndex + 1), pane, ...layout.panes.slice(focusedIndex + 1)];
  set({ ...layout, tabs, panes, focused: pane.id });
}

/** Split the focused pane: the new pane starts with the next tab not already on screen. */
export function splitPane(paneId: string): void {
  if (layout.panes.length >= MAX_PANES) return;
  const shown = new Set(layout.panes.map(p => p.tabId));
  const candidate = layout.tabs.find(t => !shown.has(t.id)) ?? null;
  const index = layout.panes.findIndex(p => p.id === paneId);
  const pane = { id: newId('p'), tabId: candidate?.id ?? null };
  // The new pane takes half of the one it split from, so the other panes keep their widths.
  const half = weightOf(layout.paneWeights, paneId) / 2;
  set({
    ...layout,
    panes: [...layout.panes.slice(0, index + 1), pane, ...layout.panes.slice(index + 1)],
    focused: pane.id,
    paneWeights: { ...layout.paneWeights, [paneId]: half, [pane.id]: half },
    maximized: null,
  });
}

/** After dragging a divider: the panes' new weights (web/paneSizes.ts). */
export function setPaneWeights(paneWeights: Record<string, number>): void {
  set({ ...layout, paneWeights: prunedWeights(paneWeights, layout.panes.map(p => p.id)) });
}

/** One pane fills the width, or (again) they share it. */
export function toggleMaximize(paneId: string): void {
  if (layout.panes.length < 2) return;
  set({ ...layout, maximized: layout.maximized === paneId ? null : paneId, focused: paneId });
}

export function focusPane(paneId: string): void {
  if (layout.focused !== paneId) set({ ...layout, focused: paneId });
}

export function closePane(paneId: string): void {
  if (layout.panes.length === 1) {
    set({ ...layout, panes: [{ ...layout.panes[0], tabId: null }] });
    return;
  }
  const index = layout.panes.findIndex(p => p.id === paneId);
  const panes = layout.panes.filter(p => p.id !== paneId);
  const focused = layout.focused === paneId ? panes[Math.max(0, index - 1)].id : layout.focused;
  // Its width goes to the neighbour that takes its place, so the rest stay put.
  const heir = panes[Math.max(0, index - 1)].id;
  const weights = { ...layout.paneWeights, [heir]: weightOf(layout.paneWeights, heir) + weightOf(layout.paneWeights, paneId) };
  set({
    ...layout,
    panes,
    focused,
    paneWeights: panes.length > 1 ? prunedWeights(weights, panes.map(p => p.id)) : undefined,
    maximized: layout.maximized === paneId || panes.length < 2 ? null : layout.maximized,
  });
}

export function closeTab(tabId: string): void {
  const index = layout.tabs.findIndex(t => t.id === tabId);
  if (index === -1) return;
  const tabs = layout.tabs.filter(t => t.id !== tabId);
  const emptied = new Set(layout.panes.filter(p => p.tabId === tabId).map(p => p.id));
  // Extra panes that showed the tab close; a lone pane shows the neighbouring tab instead.
  let panes = layout.panes.filter(p => !emptied.has(p.id));
  if (!panes.length) {
    const shown = new Set(layout.panes.map(p => p.tabId));
    const neighbours = [...layout.tabs.slice(index + 1), ...layout.tabs.slice(0, index).reverse()];
    const next = neighbours.find(t => !shown.has(t.id));
    panes = [{ ...layout.panes[0], tabId: next?.id ?? null }];
  }
  const focused = panes.some(p => p.id === layout.focused) ? layout.focused : panes[0].id;
  // Closed panes hand their width on, as closePane does, so the rest still fill the row.
  const ids = panes.map(p => p.id);
  const paneWeights = closedWeights(layout.paneWeights, layout.panes.map(p => p.id), ids);
  const maximized = layout.maximized && ids.includes(layout.maximized) && ids.length > 1 ? layout.maximized : null;
  set({ ...layout, tabs, panes, focused, paneWeights, maximized });
}

/** Drop tabs whose agent or channel was removed. */
export function pruneTabs(agentIds: Set<string>, channelIds: Set<string>): void {
  const stale = layout.tabs.filter(t => {
    const c = t.content;
    if (c.kind === 'agent' || c.kind === 'walkthrough') return !agentIds.has(c.agentId);
    if (c.kind === 'channel') return !channelIds.has(c.channelId);
    if (c.kind === 'browser') return Boolean(c.agentId) && !agentIds.has(c.agentId!);
    if ((c.kind === 'file' || c.kind === 'diff') && 'agent' in c.root) return !agentIds.has(c.root.agent);
    return false;
  });
  for (const tab of stale) closeTab(tab.id);
}

export function setSidebar(sidebar: boolean): void { set({ ...layout, sidebar }); }
export function setSidebarView(sidebarView: Layout['sidebarView']): void { set({ ...layout, sidebar: true, sidebarView }); }
export function setRail(rail: boolean): void { set({ ...layout, sidebar: true, rail }); }
export function setColumnWidth(key: ColumnKey, width: number | undefined): void {
  const widths = { ...layout.widths };
  if (width === undefined) delete widths[key];
  else widths[key] = width;
  set({ ...layout, widths });
}
export function setSectionFolded(key: RailSectionKey, folded: boolean): void {
  const next = { ...layout.folded };
  if (folded) next[key] = true;
  else delete next[key];
  set({ ...layout, folded: next });
}
export function setProject(projectId: string): void { if (layout.projectId !== projectId) set({ ...layout, projectId }); }
export function setRightPanel(rightPanel: boolean): void { set({ ...layout, rightPanel }); }
export function setSuperView(superView: SuperView): void { set({ ...layout, rightPanel: true, superView, superPanelShown: true }); }
/** The first time the SuperAgent opens, show the right panel (where its Decisions, Goals and Routines are); never again after. */
export function showPanelForSuperOnce(): void { if (!layout.superPanelShown) set({ ...layout, rightPanel: true, superPanelShown: true }); }
export function setRightView(rightView: Layout['rightView']): void {
  // Work is a tab for the SuperAgent too, so asking for it shows it there as well.
  set({ ...layout, rightPanel: true, rightView, ...(rightView === 'work' ? { superView: 'work' as const, superPanelShown: true } : {}) });
}
/** Show the Notes tab, for the SuperAgent and for every other agent. */
export function showNotesPanel(): void { set({ ...layout, rightPanel: true, rightView: 'notes', superView: 'notes', superPanelShown: true }); }
export function setTerminal(terminal: boolean): void { if (Boolean(layout.terminal) !== terminal) set({ ...layout, terminal }); }
export function setTerminalHeight(terminalHeight: number | undefined): void { set({ ...layout, terminalHeight }); }
export function setTerminalSplits(projectId: string, trees: SplitTree[]): void {
  set({ ...layout, terminalSplits: { ...layout.terminalSplits, [projectId]: trees } });
}
export function setTerminalZoom(projectId: string, terminalId: string | null): void {
  if ((layout.terminalZoom?.[projectId] ?? null) === terminalId) return;
  const terminalZoom = { ...layout.terminalZoom };
  if (terminalId) terminalZoom[projectId] = terminalId;
  else delete terminalZoom[projectId];
  set({ ...layout, terminalZoom });
}
export function setTerminalTab(projectId: string, terminalId: string): void {
  if (layout.terminalTabs?.[projectId] !== terminalId) set({ ...layout, terminalTabs: { ...layout.terminalTabs, [projectId]: terminalId } });
}

/** The project the sidebar and the terminal panel show: the chosen one, else the first. */
export function currentProjectId(l: Layout, projectIds: string[]): string | undefined {
  return l.projectId && projectIds.includes(l.projectId) ? l.projectId : projectIds[0];
}

/** The channel behind the focused pane, if any. */
export function focusedChannelId(l: Layout): string | null {
  const pane = l.panes.find(p => p.id === l.focused);
  const c = l.tabs.find(t => t.id === pane?.tabId)?.content;
  return c?.kind === 'channel' ? c.channelId : null;
}

/** The agent behind the focused pane, if any: drives the Changes panel and the Files tab. */
export function focusedAgentId(l: Layout): string | null {
  const pane = l.panes.find(p => p.id === l.focused);
  const tab = l.tabs.find(t => t.id === pane?.tabId);
  if (!tab) return null;
  const c = tab.content;
  if (c.kind === 'agent') return c.agentId;
  if (c.kind === 'browser' && c.agentId) return c.agentId;
  if ((c.kind === 'file' || c.kind === 'diff') && 'agent' in c.root) return c.root.agent;
  return null;
}
