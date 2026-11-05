/**
 * Which conversations you have read, remembered across reloads and shared by every Comms pane.
 * The rules live in comms.ts; this only stores them.
 */
import { useSyncExternalStore } from 'react';
import { markSeen, parseSeen, type CommsThread, type SeenStore } from './comms.ts';

const KEY = 'agentscode.commsSeen';

function load(): SeenStore {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage unavailable: nothing remembered.
  }
  const store = parseSeen(raw, Date.now());
  // Pin the starting point the first time, so a reload does not mark everything since as read.
  if (!raw) save(store);
  return store;
}

function save(next: SeenStore): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not remembered in private mode.
  }
}

let store = load();
const listeners = new Set<() => void>();

export function markThreadsSeen(threads: readonly Pick<CommsThread, 'id' | 'lastTs'>[]): void {
  const next = markSeen(store, threads);
  if (next === store) return;
  store = next;
  save(store);
  for (const listener of listeners) listener();
}

export function useCommsSeen(): SeenStore {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => store,
  );
}
