import { useEffect, useSyncExternalStore } from 'react';
import { isDue, isOpen, pollInterval, type PrPageData } from '../../shared/prs.ts';
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

/** Only read GitHub while someone can see it: the window is visible and has focus. */
const watching = () => document.visibilityState === 'visible' && document.hasFocus();

let pages = 0;
let counts = 0;
let timer: ReturnType<typeof setInterval> | null = null;
function check(): void {
  if (watching() && isDue(state.data?.fetchedAt, pollInterval(pages, counts))) void loadPrs();
}
function attach(): void {
  if (timer) return;
  // A minute's tick only checks whether a read is due; it reads at the interval above.
  timer = setInterval(check, 60_000);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
}
function detach(): void {
  if (pages + counts > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
  window.removeEventListener('focus', check);
  document.removeEventListener('visibilitychange', check);
}

/** Keep the data fresh while it is shown: `page` for the Pull requests page, otherwise the sidebar's count. */
export function usePrsData(page = false): void {
  useEffect(() => {
    if (page) pages++; else counts++;
    attach();
    // Opening the page reads now if the data is older than the page's interval.
    if (!state.data && !inFlight) void loadPrs();
    else check();
    return () => {
      if (page) pages--; else counts--;
      detach();
    };
  }, [page]);
}

/** Open PRs (drafts included) across the projects, or null before the first load. */
export function openCount(data: PrPageData | null): number | null {
  return data ? data.pullRequests.filter(isOpen).length : null;
}

/** The same, read now (outside React), for a tab's title. */
export function prsOpenCount(): number | null {
  return openCount(state.data);
}
