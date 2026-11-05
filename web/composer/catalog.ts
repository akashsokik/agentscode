import { useEffect, useState } from 'react';
import type { ComposerCommand, ProjectFileList } from '../../shared/composer.ts';
import { api } from '../api.ts';

/*
 * What the pickers list, fetched when one opens and kept for a short while, per agent: its skills
 * and commands, and the files in its workspace. Like MonoCode's file index and skill catalog, a
 * picker shows what it has at once and refreshes behind it.
 */

interface Cached<T> {
  at: number;
  value?: T;
  pending?: Promise<T>;
}

const FRESH_MS = 15_000;
const commandCache = new Map<string, Cached<ComposerCommand[]>>();
const fileCache = new Map<string, Cached<ProjectFileList>>();

function useCached<T>(cache: Map<string, Cached<T>>, key: string, enabled: boolean, load: () => Promise<T>): { value?: T; loading: boolean } {
  const [, setVersion] = useState(0);
  const entry = cache.get(key);
  useEffect(() => {
    if (!enabled) return;
    const current = cache.get(key);
    if (current?.pending || (current?.value !== undefined && Date.now() - current.at < FRESH_MS)) {
      if (current?.pending) void current.pending.then(() => setVersion(v => v + 1), () => setVersion(v => v + 1));
      return;
    }
    let live = true;
    const pending = load();
    cache.set(key, { at: current?.at ?? 0, value: current?.value, pending });
    pending.then(
      value => cache.set(key, { at: Date.now(), value }),
      () => cache.set(key, { at: Date.now(), value: current?.value }),
    ).finally(() => { if (live) setVersion(v => v + 1); });
    return () => { live = false; };
  }, [cache, key, enabled, load]);
  return { value: entry?.value, loading: entry?.value === undefined && enabled };
}

const loadCommands = new Map<string, () => Promise<ComposerCommand[]>>();
const loadFiles = new Map<string, () => Promise<ProjectFileList>>();

/** The agent's skills and commands (not AgentsCode's own), while `enabled`. */
export function useAgentCommands(agentId: string, enabled: boolean) {
  let load = loadCommands.get(agentId);
  if (!load) loadCommands.set(agentId, (load = () => api.commands(agentId).catch(() => [])));
  return useCached(commandCache, agentId, enabled, load);
}

/** The files in the agent's workspace, while `enabled`. */
export function useAgentFiles(agentId: string, enabled: boolean) {
  let load = loadFiles.get(agentId);
  if (!load) loadFiles.set(agentId, (load = () => api.projectFiles({ agent: agentId }).catch(() => ({ files: [], truncated: false }))));
  return useCached(fileCache, agentId, enabled, load);
}
