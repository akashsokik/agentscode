// The eval's only contact with the dreaming code in server/ (server/dream.ts, through AgentManager).
// It reuses that code and reimplements none of it; if a name changes there, this is the file to update.
import fs from 'node:fs';
import path from 'node:path';
import type { DreamRecord, MemoryEntry } from '../../shared/types.ts';
import type { AgentManager, ManagerOptions } from '../../server/manager.ts';
import { fakeDreamReply } from './fake.ts';
import type { Scenario } from './scenario.ts';

export type { DreamRecord };

/** Who wrote a memory entry: the agent's own remember tool, or a dream. */
export type Writer = 'agent' | 'dream';

export interface Attributed {
  entry: MemoryEntry;
  by: Writer;
  /** The agent wrote it and the dream then updated or merged into it (it now carries the dream's id). */
  rewritten: boolean;
}

/**
 * Who wrote each entry. dreamId names the last writer, not the first: a dream that updates the agent's
 * entry keeps its id and stamps its own dreamId on it. So entries that already existed before the dream
 * (ids in beforeDream) stay the agent's, marked rewritten if a dream touched them; only entries that are
 * new since then and carry a dreamId are the dream's. Each eval agent dreams once, so this is exact.
 */
export function attribute(memory: MemoryEntry[], beforeDream: Set<string>): Attributed[] {
  return memory.map(entry => beforeDream.has(entry.id)
    ? { entry, by: 'agent' as const, rewritten: Boolean(entry.dreamId) }
    : { entry, by: entry.dreamId ? 'dream' as const : 'agent' as const, rewritten: false });
}

/** Turn dreaming on or off for an agent (Agent.dreaming; on by default). */
export async function setDreaming(manager: AgentManager, agentId: string, on: boolean): Promise<void> {
  await manager.update(agentId, { dreaming: on });
}

/** Remove memory entries through the app's own path (what a user's delete does). Returns how many. */
export function forgetWhere(manager: AgentManager, agentId: string, which: (entry: MemoryEntry) => boolean): number {
  const doomed = manager.memory(agentId).filter(which);
  for (const entry of doomed) manager.forgetMemory(agentId, entry.id);
  return doomed.length;
}

/**
 * Manager options that swap the dream pass's model call for the scripted one (dry runs only). Each dry
 * dream costs nothing, unless DREAM_EVAL_DRY_DREAM_USD says otherwise: that exists to test --max-cost.
 */
export function fakeDreamOptions(scenario: Scenario): Pick<ManagerOptions, 'dreamEngine'> {
  const costUsd = Number(process.env.DREAM_EVAL_DRY_DREAM_USD ?? 0) || 0;
  return {
    dreamEngine: async ({ prompt }) => ({ text: fakeDreamReply(prompt, scenario), tokens: 0, costUsd }),
  };
}

/** Every dream an agent had, oldest first, from home/dreams.jsonl (a later line with the same id wins). */
export function readDreams(home: string): DreamRecord[] {
  const file = path.join(home, 'dreams.jsonl');
  if (!fs.existsSync(file)) return [];
  const byId = new Map<string, DreamRecord>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as DreamRecord;
      byId.set(record.id, record);
    } catch {
      // a torn line; skip it
    }
  }
  return [...byId.values()];
}

/** Wait for a dream a session end started to finish (home/.dream.lock is gone). */
export async function settleDreams(home: string, timeoutMs: number): Promise<void> {
  const lock = path.join(home, '.dream.lock');
  const until = Date.now() + timeoutMs;
  while (fs.existsSync(lock)) {
    if (Date.now() > until) throw new Error(`A dream was still running after ${Math.round(timeoutMs / 1000)}s.`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
