import { useSyncExternalStore } from 'react';
import { api } from '../api.ts';
import { findRefIds, type RefSummary, type RefsIndex } from '../../shared/refs.ts';
import type { ServerEvent } from '../../shared/types.ts';

// The project notes and decisions the app knows about (GET /api/refs), for the Notes tab and for
// the id chips in text, and what the Notes tab shows: its project, filter, search and open entry.
// Loaded the first time something asks, and again when a note or decision is added or a message
// cites one (so "mentioned N times" keeps up).

export type NotesFilter = 'all' | 'D' | 'N';

export interface NotesState {
  index: RefsIndex | null;
  /** Summaries by id, for chips. */
  byId: Map<string, RefSummary>;
  /** The known ids, joined: changes only when one is added or removed, so text re-parses only then. */
  idsKey: string;
  error: string | null;
  /** The project the list shows when the user picked one (all-projects agents and the SuperAgent). */
  code: string | null;
  filter: NotesFilter;
  query: string;
  /** Search every project instead of the one shown. */
  everywhere: boolean;
  /** The entry open in the Notes tab. */
  openId: string | null;
}

let state: NotesState = { index: null, byId: new Map(), idsKey: '', error: null, code: null, filter: 'all', query: '', everywhere: false, openId: null };
const listeners = new Set<() => void>();

function set(next: Partial<NotesState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!state.index && !loading) void loadRefs();
  return () => listeners.delete(listener);
}

export function useNotes<T>(selector: (s: NotesState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function getNotes(): NotesState {
  return state;
}

let loading: Promise<void> | null = null;
let again = false;

/** Fetch the index; a call while one is in flight fetches once more after it. */
export function loadRefs(): Promise<void> {
  if (loading) { again = true; return loading; }
  loading = api.refs()
    .then(index => set({ index, byId: new Map(index.entries.map(e => [e.id, e])), idsKey: index.entries.map(e => e.id).join(' '), error: null }))
    .catch((error: Error) => set({ error: error.message }))
    .finally(() => {
      loading = null;
      if (again) { again = false; void loadRefs(); }
    });
  return loading;
}

let soon: ReturnType<typeof setTimeout> | null = null;

/** Fetch the index again shortly, once for a burst of changes (a streaming reply). */
export function refreshRefsSoon(delay = 1500): void {
  if (!state.index && !listeners.size) return;
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => { soon = null; void loadRefs(); }, delay);
}

/** Text arrived (a reply, a post, a message): if it cites a known id, its count changed. */
export function textArrived(text: string | undefined): void {
  if (!text || !state.index) return;
  if (findRefIds(text, id => state.byId.has(id)).length) refreshRefsSoon();
}

export function isKnownRef(id: string): boolean {
  return state.byId.has(id);
}

export function setNotesCode(code: string | null): void { set({ code, openId: null }); }
export function setNotesFilter(filter: NotesFilter): void { set({ filter }); }
export function setNotesQuery(query: string): void { set({ query, ...(query ? {} : { everywhere: false }) }); }
export function setNotesEverywhere(everywhere: boolean): void { set({ everywhere }); }
export function openNote(id: string | null): void { set({ openId: id }); }

/** What a server event means for the notes: added ones, and new text that may cite one. */
export function refsHeard(event: ServerEvent): void {
  if (event.type === 'refs' || event.type === 'snapshot') refreshRefsSoon(event.type === 'refs' ? 0 : 500);
  else if (event.type === 'entry' && (event.entry.kind === 'agent' || event.entry.kind === 'user')) textArrived(event.entry.text);
  else if (event.type === 'post') textArrived(event.post.text);
  else if (event.type === 'message') textArrived([event.message.text, event.message.delegation?.task, event.message.report?.summary].filter(Boolean).join('\n'));
}
