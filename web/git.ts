import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { GitStatus } from '../shared/types.ts';
import { api, type Root } from './api.ts';
import { rootKey } from './layout.ts';

interface Entry {
  root: Root;
  status: GitStatus | null;
  error: string | null;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
}

const POLL_MS = 5000;
const cache = new Map<string, Entry>();

async function refresh(key: string): Promise<void> {
  const entry = cache.get(key);
  if (!entry || entry.inflight) return;
  entry.inflight = true;
  try {
    entry.status = await api.gitStatus(entry.root);
    entry.error = null;
  } catch (error) {
    entry.error = (error as Error).message;
  } finally {
    entry.inflight = false;
  }
  for (const listener of entry.listeners) listener();
}

export function refreshGit(root: Root): void {
  void refresh(rootKey(root));
}

function subscribe(key: string, root: Root, listener: () => void): () => void {
  let entry = cache.get(key);
  if (!entry) {
    entry = { root, status: null, error: null, listeners: new Set(), timer: null, inflight: false };
    cache.set(key, entry);
  }
  entry.listeners.add(listener);
  if (!entry.timer) {
    void refresh(key);
    entry.timer = setInterval(() => { if (!document.hidden) void refresh(key); }, POLL_MS);
  }
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size && entry.timer) {
      clearInterval(entry.timer);
      entry.timer = null;
    }
  };
}

const none = { status: null, error: null };

/** Working-tree changes for a root, polled while anything on screen shows them. */
export function useGitStatus(root: Root | null, refreshOn?: unknown): { status: GitStatus | null; error: string | null } {
  const key = root ? rootKey(root) : '';
  const rootRef = useRef(root);
  rootRef.current = root;
  // Subscribe once per root; a new function each render would restart polling every render.
  const subscribeToKey = useCallback(
    (listener: () => void) => (rootRef.current && key ? subscribe(key, rootRef.current, listener) : () => {}),
    [key],
  );
  const snapshot = useSyncExternalStore(
    subscribeToKey,
    () => {
      const entry = cache.get(key);
      return entry ? (entry.status ?? entry.error) : null;
    },
  );
  // Refresh right away when the caller's signal changes (e.g. an agent finished a turn).
  useEffect(() => {
    if (root) void refresh(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshOn]);
  if (!root || snapshot === null) return none;
  const entry = cache.get(key)!;
  return { status: entry.status, error: entry.error };
}
