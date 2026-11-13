import { useEffect, useSyncExternalStore } from 'react';
import { isOpen, type PrPageData } from '../../shared/prs.ts';
import { api } from '../api.ts';

// The Pull requests page's data (GET /api/github/prs, read only, ACH-D43). Loaded while the page or
// the sidebar's count is on screen: again every 5 minutes, and when the window comes back into view.
// The server keeps a minute-long cache, so the sidebar and the page together cost one gh read.

export interface PrsState {
  data: PrPageData | null;
  error: string | null;
  loading: boolean;
}

let state: PrsState = { data: null, error: null, loading: false };
const listeners = new Set<() => void>();
function set(next: Partial<PrsState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function usePrs<T>(select: (s: PrsState) => T): T {
  return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => select(state));
}

let inFlight: Promise<void> | null = null;
export function loadPrs(fresh = false): Promise<void> {
  if (inFlight) return inFlight;
  set({ loading: true });
  inFlight = api.prs(fresh)
    .then(data => set({ data, error: null }))
    .catch((e: Error) => set({ error: e.message }))
    .finally(() => { inFlight = null; set({ loading: false }); });
  return inFlight;
}

const POLL_MS = 5 * 60_000;
let watchers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = () => { if (document.visibilityState === 'visible') void loadPrs(); };

/** Keep the data fresh while something that shows it is mounted. */
export function usePrsData(): void {
  useEffect(() => {
    watchers++;
    if (!state.data && !inFlight) void loadPrs();
    if (watchers === 1) {
      timer = setInterval(() => { if (document.visibilityState === 'visible') void loadPrs(); }, POLL_MS);
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

/** Open PRs (drafts included) across the projects, or null before the first load. */
export function openCount(data: PrPageData | null): number | null {
  return data ? data.pullRequests.filter(isOpen).length : null;
}

/** The same, read now (outside React), for a tab's title. */
export function prsOpenCount(): number | null {
  return openCount(state.data);
}
