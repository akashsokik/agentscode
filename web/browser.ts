/**
 * The page's side of the integrated browser. In the desktop app, main draws each browser tab as
 * a native view over its pane (electron/browser.ts); this module talks to it through the preload
 * (`window.agentscode.browser`), keeps each tab's live state for BrowserPane, and keeps main's
 * tabs and the layout's tabs in step. In a plain browser there is no native view: BrowserPane
 * falls back to an iframe for localhost pages.
 */
import { useSyncExternalStore } from 'react';
import { normalizeAddress, type BrowserEvent, type BrowserTabState } from '../shared/browserPolicy.ts';
import { addTab, closeTab, focusPane, getLayout, open, openToSide, subscribeLayout, updateBrowserTab } from './layout.ts';
import { runShortcut } from './shortcuts.ts';

interface NativeBrowser {
  call(op: string, args?: unknown): Promise<unknown>;
  onEvent(listener: (event: BrowserEvent) => void): () => void;
}

const native = (window as unknown as { agentscode?: { browser?: NativeBrowser } }).agentscode?.browser;

/** True in the desktop app, where browser tabs are real browser views. */
export const HAS_NATIVE_BROWSER = Boolean(native);

export async function browserCall<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T> {
  if (!native) throw new Error('The browser needs the AgentsCode desktop app.');
  const result = await native.call(op, args);
  if (result && typeof result === 'object' && 'error' in result && typeof (result as { error: unknown }).error === 'string') {
    throw new Error((result as { error: string }).error);
  }
  return result as T;
}

// ---- Live tab state ----

const states = new Map<string, BrowserTabState>();
const listeners = new Set<() => void>();
const addressFocus = new Set<(id: string) => void>();

function setState(tab: BrowserTabState): void {
  states.set(tab.id, tab);
  for (const listener of listeners) listener();
  // Restoring a layout reloads the tab where it was; a page with no title keeps its host.
  if (tab.url && !tab.url.startsWith('about:')) updateBrowserTab(tab.id, { url: tab.url, title: tab.title || undefined });
}

export function useBrowserTab(id: string): BrowserTabState | undefined {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => states.get(id));
}

export function primeBrowserTab(tab: BrowserTabState): void {
  setState(tab);
}

/** Cmd+L in a browser view, for the pane whose address bar should take the caret. */
export function onAddressFocus(listener: (id: string) => void): () => void {
  addressFocus.add(listener);
  return () => addressFocus.delete(listener);
}

let nextId = 0;
/** A new browser tab, in the focused pane or beside it, at a URL or blank with the caret in its address bar. */
export function openBrowser(url = '', side = false): void {
  const id = `b${Date.now().toString(36)}${(nextId++).toString(36)}`;
  const target = url ? normalizeAddress(url) ?? '' : '';
  (side ? openToSide : open)({ kind: 'browser', id, url: target });
}

function paneShowing(id: string): string | undefined {
  const layout = getLayout();
  const tab = layout.tabs.find(t => t.content.kind === 'browser' && t.content.id === id);
  return tab ? layout.panes.find(p => p.tabId === tab.id)?.id : undefined;
}

function browserIds(): Set<string> {
  const ids = new Set<string>();
  for (const tab of getLayout().tabs) if (tab.content.kind === 'browser') ids.add(tab.content.id);
  return ids;
}

function onEvent(event: BrowserEvent): void {
  switch (event.type) {
    case 'state':
      setState(event.tab);
      break;
    case 'opened':
      setState(event.tab);
      (event.side ? openToSide : open)({ kind: 'browser', id: event.tab.id, url: event.tab.url, agentId: event.tab.agentId });
      break;
    case 'closed': {
      states.delete(event.id);
      for (const listener of listeners) listener();
      const tab = getLayout().tabs.find(t => t.content.kind === 'browser' && t.content.id === event.id);
      if (tab) closeTab(tab.id);
      break;
    }
    case 'open-url':
      openBrowser(event.url, true);
      break;
    case 'focus': {
      const pane = paneShowing(event.id);
      if (pane) focusPane(pane);
      break;
    }
    case 'focus-address':
      for (const listener of addressFocus) listener(event.id);
      break;
    case 'shortcut':
      runShortcut(new KeyboardEvent('keydown', { key: event.key, code: event.code, metaKey: event.meta, ctrlKey: event.ctrl, altKey: event.alt, shiftKey: event.shift }));
      break;
  }
}

if (native) {
  native.onEvent(onEvent);
  // Main's tabs outlive the page: close the user's tabs the layout dropped, and add agents' tabs
  // that were opened while no window was open.
  void browserCall<BrowserTabState[]>('sync', { ids: [...browserIds()] }).then(missing => {
    for (const tab of missing) {
      setState(tab);
      addTab({ kind: 'browser', id: tab.id, url: tab.url, title: tab.title, agentId: tab.agentId });
    }
  }, () => {});
  // A browser tab closed in the layout closes its view.
  let known = browserIds();
  subscribeLayout(() => {
    const now = browserIds();
    for (const id of known) {
      if (now.has(id)) continue;
      states.delete(id);
      void browserCall('destroy', { id }).catch(() => {});
    }
    known = now;
  });
}

// ---- Overlays ----

/**
 * A native view paints above the whole page, so a dialog, menu or lightbox portalled to <body>
 * would open under it. True when something like that is on screen over `rect`; BrowserPane then
 * swaps the view for a still of it. Only what is visible and overlaps counts: a menu in the
 * sidebar leaves the browser alone, and an off-screen measuring box (Mermaid's) never covers it.
 */
export function coveredBy(rect: DOMRect): boolean {
  for (const el of Array.from(document.body.children)) {
    if (el.id === 'root' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'TEMPLATE' || el.tagName === 'LINK') continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) return true;
  }
  return false;
}
