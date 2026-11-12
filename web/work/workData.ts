import { useEffect, useSyncExternalStore } from 'react';
import type { WorkTab, WorkTarget, WorkView } from '../../shared/work.ts';
import { api } from '../api.ts';

// The Work view's data (GET /api/work): loaded while a Work tab or pane is on screen, again every
// 20 seconds and when the window comes back into view, and right after a cleanup. The server keeps
// its own short cache, so several views at once cost one look at git.

export interface WorkState {
  view: WorkView | null;
  error: string | null;
  loading: boolean;
  /** Selection survives opening the full pane, independently for each project. */
  ui: Record<string, WorkUi>;
}

export interface WorkUi { tab: WorkTab; selected: WorkTarget | null; otherOpen: boolean; pushedOpen: boolean; unknownOpen: boolean }
export const DEFAULT_WORK_UI: WorkUi = { tab: 'graph', selected: null, otherOpen: false, pushedOpen: false, unknownOpen: false };
let state: WorkState = { view: null, error: null, loading: false, ui: {} };
const listeners = new Set<() => void>();
function set(next: Partial<WorkState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function useWork<T>(select: (s: WorkState) => T): T {
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => select(state));
}

let inFlight: Promise<void> | null = null;
export function loadWork(fresh = false): Promise<void> {
  if (inFlight) return inFlight;
  set({ loading: true });
  inFlight = api.work(fresh)
    .then(view => set({ view, error: null }))
    .catch((e: Error) => set({ error: e.message }))
    .finally(() => { inFlight = null; set({ loading: false }); });
  return inFlight;
}

let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => { if (document.visibilityState === 'visible') void loadWork(); };

/** Keep the data fresh while a Work view is mounted. */
export function useWorkData(): void {
  useEffect(() => {
    watchers++;
    void loadWork();
    if (watchers === 1) {
      timer = setInterval(() => { if (document.visibilityState === 'visible') void loadWork(); }, 20_000);
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      watchers--;
      if (watchers === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  }, []);
}

export function setWorkUi(projectId: string, update: Partial<WorkUi>): void {
  set({ ui: { ...state.ui, [projectId]: { ...(state.ui[projectId] ?? DEFAULT_WORK_UI), ...update } } });
}

/** "9 Nov", or the time for today. */
export function day(at: number, now = new Date()): string {
  const d = new Date(at);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}
