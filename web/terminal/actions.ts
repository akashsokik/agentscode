/**
 * What the app can do with the terminal panel: show or hide it, start, split and close shells,
 * move between splits. The shells live on the server (server/terminals.ts) and their list arrives
 * on the event feed; how they are arranged into tabs and splits is this page's layout.
 */
import { useSyncExternalStore } from 'react';
import type { TerminalInfo } from '../../shared/types.ts';
import { api } from '../api.ts';
import { currentProjectId, getLayout, setProject, setTerminal, setTerminalSplits, setTerminalTab, setTerminalZoom, type Layout } from '../layout.ts';
import { attempt, getState, toast, updateTerminals } from '../store.ts';
import { arrange, cycle, equalize, leaves, neighbor, setRatio, splitAt, successor, treeIndexOf, type SplitTree } from './splits.ts';

/** The project the panel shows. */
export function panelProjectId(): string | undefined {
  return currentProjectId(getLayout(), getState().snapshot?.projects.map(p => p.id) ?? []);
}

// ---- small live state: focus requests, titles, splits being placed, a pending close ----------
// A focus request names a terminal. That terminal takes the keyboard once it is on screen and
// ready, so a page load steals nothing and a shell still starting is not skipped.

type FocusRequest = { id: string | null; n: number };
let focus: FocusRequest = { id: null, n: 0 };
/** Titles shells set (OSC 0 and 2), by terminal id. */
let titles: Record<string, string> = {};
/** While a split is being created: the terminals that existed before it. Newer ones wait to be placed. */
let placing: ReadonlySet<string> | null = null;
/**
 * Closing these would stop the programs running in them; the panel asks first. `programs` is
 * empty when the server could not say (an older server), which asks too. `refocus`: the panel
 * had the keyboard when the close was asked for, so the split left behind takes it.
 */
export type CloseRequest = { ids: string[]; programs: string[]; refocus: boolean };
let closeRequest: CloseRequest | null = null;

const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function requestTerminalFocus(id: string | undefined): void {
  if (!id) return;
  focus = { id, n: focus.n + 1 };
  notify();
}

export function useFocusRequest(): FocusRequest {
  return useSyncExternalStore(subscribe, () => focus);
}

export function setTerminalTitle(id: string, title: string): void {
  if (titles[id] === title) return;
  titles = { ...titles, [id]: title };
  notify();
}

export function useTerminalTitles(): Record<string, string> {
  return useSyncExternalStore(subscribe, () => titles);
}

export function usePlacing(): ReadonlySet<string> | null {
  return useSyncExternalStore(subscribe, () => placing);
}

export function useCloseRequest(): CloseRequest | null {
  return useSyncExternalStore(subscribe, () => closeRequest);
}

/** True while the close confirmation is up, so app shortcuts wait as they do for other dialogs. */
export function isConfirmingClose(): boolean {
  return closeRequest !== null;
}

/** The last size a terminal was fitted to, so a new shell starts at about the size it will get. */
let lastSize: { cols: number; rows: number } | undefined;
export function noteTerminalSize(cols: number, rows: number): void {
  if (cols >= 2 && rows >= 1) lastSize = { cols, rows };
}

/** Terminals in the order they last had focus, newest last: a tab reopens on its last one. */
const recent: string[] = [];

// ---- tabs and focus -------------------------------------------------------------

/** A project's tabs: its saved split trees, read against its live terminals (plus `extra`). */
export function projectTabs(projectId: string, terminals: TerminalInfo[] = getState().terminals, layout: Layout = getLayout(), held = placing, extra: string[] = []): SplitTree[] {
  const ids = [...terminals.filter(t => t.projectId === projectId).map(t => t.id), ...extra.filter(id => !terminals.some(t => t.id === id))];
  return arrange(layout.terminalSplits?.[projectId], ids, held ? id => !held.has(id) : undefined);
}

/** The terminal in focus in a project and the index of its tab: the one last focused, else the first. */
export function frontOf(projectId: string | undefined, tabs: SplitTree[], layout: Layout = getLayout()): { id: string | undefined; tab: number } {
  const saved = projectId ? layout.terminalTabs?.[projectId] : undefined;
  const tab = saved ? treeIndexOf(tabs, saved) : -1;
  if (tab !== -1) return { id: saved, tab };
  return tabs.length ? { id: leaves(tabs[0])[0], tab: 0 } : { id: undefined, tab: -1 };
}

function infoOf(id: string): TerminalInfo | undefined {
  return getState().terminals.find(t => t.id === id);
}

/** Move the keyboard to a terminal, bringing its tab to the front. */
export function focusTerminal(projectId: string, id: string): void {
  setTerminalTab(projectId, id);
  requestTerminalFocus(id);
}

/** A terminal took focus (a click, or a request): remember it as its project's front one. */
export function noteTerminalFocus(info: TerminalInfo): void {
  const at = recent.indexOf(info.id);
  if (at !== -1) recent.splice(at, 1);
  recent.push(info.id);
  if (recent.length > 200) recent.shift();
  setTerminalTab(info.projectId, info.id);
}

/** Open a tab on the split that last had focus in it. */
export function pickTab(projectId: string, tree: SplitTree): void {
  const ids = leaves(tree);
  const last = [...recent].reverse().find(id => ids.includes(id));
  focusTerminal(projectId, last ?? ids[0]);
}

function panelHasFocus(): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && Boolean(focused.closest('[data-terminal-panel]'));
}

// ---- actions ------------------------------------------------------------------------

let starting = false;

/** Start a shell in the project's folder (the panel's project by default), in a tab of its own. */
export async function newTerminal(projectId = panelProjectId()): Promise<TerminalInfo | undefined> {
  if (!projectId) {
    toast('Add a project first. A terminal opens in its folder.');
    return undefined;
  }
  if (starting) return undefined;
  starting = true;
  try {
    setProject(projectId);
    setTerminal(true);
    const info = await attempt(() => api.createTerminal(projectId, lastSize));
    if (!info) return undefined;
    updateTerminals(list => (list.some(t => t.id === info.id) ? list : [...list, info]));
    setTerminalZoom(projectId, null);
    focusTerminal(projectId, info.id);
    return info;
  } finally {
    starting = false;
  }
}

/**
 * Split a terminal, as Ghostty's Cmd+D and Cmd+Shift+D do: a new shell to its right or below
 * it, started in the folder the shell is in now.
 */
export async function splitTerminal(from: TerminalInfo, dir: 'right' | 'down'): Promise<void> {
  if (starting) return;
  starting = true;
  placing = new Set(getState().terminals.map(t => t.id));
  notify();
  try {
    const size = lastSize && (dir === 'right'
      ? { cols: Math.max(2, Math.floor(lastSize.cols / 2)), rows: lastSize.rows }
      : { cols: lastSize.cols, rows: Math.max(1, Math.floor(lastSize.rows / 2)) });
    const info = await attempt(() => api.createTerminal(from.projectId, size, from.id));
    if (!info) return;
    // The list and the tree change together, whichever of the reply and the list event came
    // first, so the new shell never shows as a tab of its own.
    updateTerminals(list => (list.some(t => t.id === info.id) ? list : [...list, info]));
    const tabs = projectTabs(from.projectId);
    setTerminalSplits(from.projectId, splitAt(tabs, from.id, info.id, dir === 'right' ? 'row' : 'column'));
    setTerminalZoom(from.projectId, null);
    focusTerminal(from.projectId, info.id);
  } finally {
    placing = null;
    starting = false;
    notify();
  }
}

/** Split the terminal in focus in the panel's project, or start the first one. */
export function splitFront(dir: 'right' | 'down'): void {
  const projectId = panelProjectId();
  if (!projectId) return;
  const { id } = frontOf(projectId, projectTabs(projectId));
  const info = id ? infoOf(id) : undefined;
  if (info) void splitTerminal(info, dir);
  else void newTerminal(projectId);
}

/** Move to the split before or after this one, or the one beside it in a direction. */
export function focusSplit(from: TerminalInfo, to: 'previous' | 'next' | 'left' | 'right' | 'up' | 'down'): void {
  const tabs = projectTabs(from.projectId);
  const tree = tabs[treeIndexOf(tabs, from.id)];
  if (!tree || tree.type === 'leaf') return;
  const target = to === 'previous' ? cycle(tree, from.id, -1) : to === 'next' ? cycle(tree, from.id, 1) : neighbor(tree, from.id, to);
  if (!target) return;
  setTerminalZoom(from.projectId, null);
  focusTerminal(from.projectId, target);
}

/** Let one split fill its tab, or put it back (Cmd+Shift+Enter). */
export function toggleZoom(info: TerminalInfo): void {
  const tabs = projectTabs(info.projectId);
  const tree = tabs[treeIndexOf(tabs, info.id)];
  if (!tree || tree.type === 'leaf') return;
  const zoomed = getLayout().terminalZoom?.[info.projectId] === info.id;
  setTerminalZoom(info.projectId, zoomed ? null : info.id);
  focusTerminal(info.projectId, info.id);
}

/** Make every split in the terminal's tab the same size. */
export function equalizeSplits(info: TerminalInfo): void {
  const tabs = projectTabs(info.projectId);
  const index = treeIndexOf(tabs, info.id);
  if (index === -1 || tabs[index].type === 'leaf') return;
  setTerminalSplits(info.projectId, tabs.map((tree, i) => (i === index ? equalize(tree) : tree)));
}

/** A divider was dragged: `path` names the split within tab `tab`. */
export function setSplitRatio(projectId: string, tab: number, path: string, ratio: number): void {
  const tabs = projectTabs(projectId);
  if (!tabs[tab]) return;
  setTerminalSplits(projectId, tabs.map((tree, i) => (i === tab ? setRatio(tree, path, ratio) : tree)));
}

/**
 * Before terminals go: if the one in focus is among them, focus passes to the split beside it,
 * else to the neighbouring tab, as in Ghostty.
 */
function handOff(projectId: string, ids: string[], refocus: boolean): void {
  const layout = getLayout();
  const front = layout.terminalTabs?.[projectId];
  if (layout.terminalZoom?.[projectId] && ids.includes(layout.terminalZoom[projectId])) setTerminalZoom(projectId, null);
  if (!front || !ids.includes(front)) return;
  const tabs = projectTabs(projectId, getState().terminals, layout, placing, ids);
  const index = treeIndexOf(tabs, front);
  const tree = tabs[index];
  const gone = (id: string | undefined) => !id || ids.includes(id);
  let next = tree ? successor(tree, front) : undefined;
  if (gone(next)) next = tree ? leaves(tree).find(id => !gone(id)) : undefined;
  if (gone(next)) {
    const beside = [...tabs.slice(index + 1), ...tabs.slice(0, Math.max(0, index)).reverse()];
    next = beside.flatMap(leaves).find(id => !gone(id));
  }
  if (!next) return;
  setTerminalTab(projectId, next);
  if (refocus) requestTerminalFocus(next);
}

function closeNow(ids: string[], refocus: boolean): void {
  const infos = getState().terminals.filter(t => ids.includes(t.id));
  const projectId = infos[0]?.projectId;
  if (projectId) handOff(projectId, ids, refocus);
  updateTerminals(list => list.filter(t => !ids.includes(t.id)));
  // A shell that already exited has left the server's list: nothing more to do.
  for (const id of ids) void api.closeTerminal(id).catch(() => undefined);
}

/** Close terminals (a split, or every split of a tab), asking first if a program runs in one. */
export async function closeTerminals(ids: string[]): Promise<void> {
  if (!ids.length || closeRequest) return;
  // Read now: by the time the dialog answers, the keyboard is on its button.
  const refocus = panelHasFocus();
  let programs: string[];
  try {
    programs = [...new Set(Object.values(await api.terminalsBusy(ids)))];
    if (!programs.length) {
      closeNow(ids, refocus);
      return;
    }
  } catch {
    // The server cannot say (say it predates the check): ask, since a lost dev server costs more.
    programs = [];
  }
  closeRequest = { ids, programs, refocus };
  notify();
}

export function answerClose(confirmed: boolean): void {
  const request = closeRequest;
  closeRequest = null;
  notify();
  if (confirmed && request) closeNow(request.ids, request.refocus);
}

/** A shell ended by itself (`exit`): its split's neighbour takes focus if it had it. */
export function shellExited(info: TerminalInfo, hadFocus: boolean): void {
  handOff(info.projectId, [info.id], hadFocus);
}

/** Show the panel on a project's terminals, starting the first one if it has none. */
export function showTerminal(projectId = panelProjectId()): void {
  const { id } = projectId ? frontOf(projectId, projectTabs(projectId)) : { id: undefined };
  if (projectId && id) {
    setProject(projectId);
    setTerminal(true);
    requestTerminalFocus(id);
    return;
  }
  void newTerminal(projectId);
}

export function hideTerminal(): void {
  // Hidden content keeps focus in some browsers, and keys would go on reaching the shell.
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest('[data-terminal-panel]')) focused.blur();
  setTerminal(false);
}

export function toggleTerminal(): void {
  if (getLayout().terminal) hideTerminal();
  else showTerminal();
}
