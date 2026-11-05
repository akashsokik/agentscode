import type { Entry } from '../shared/types.ts';

/** Grouping a transcript into turns, for the transcript view. Pure, so it is tested directly. */

export interface Turn {
  id: string;
  /** The user message or teammate message this turn answers. */
  prompt?: Entry;
  items: Entry[];
  startedAt: number;
}

export type Section = { type: 'turn'; turn: Turn } | { type: 'note'; entry: Entry };

export interface Grouped {
  sections: Section[];
  /** Prompts sent while the agent was busy, not started yet. */
  queued: Entry[];
}

function markerPrompt(entry: Entry): string | undefined {
  if (entry.turn?.entryId) return entry.turn.entryId;
  if (entry.turn?.messageId) return `peer:${entry.turn.messageId}`;
  return undefined;
}

/**
 * Prompts are written when sent, so one queued behind a running turn lands inside it. Turn
 * markers say when each turn really started and which prompt it runs; the prompt moves there.
 * History written before markers existed falls back to splitting at user messages.
 */
export function groupTurns(entries: Entry[], selfId: string): Grouped {
  const byId = new Map(entries.map(e => [e.id, e]));
  const referenced = new Set(entries.filter(e => e.kind === 'turn').map(markerPrompt).filter((id): id is string => Boolean(id)));
  const firstMarker = entries.findIndex(e => e.kind === 'turn');
  const sections: Section[] = [];
  const queued: Entry[] = [];
  let current: Turn | null = null;

  entries.forEach((entry, index) => {
    const legacy = firstMarker === -1 || index < firstMarker;
    if (entry.kind === 'turn') {
      const ref = markerPrompt(entry);
      current = { id: entry.id, prompt: ref ? byId.get(ref) : undefined, items: [], startedAt: entry.ts };
      sections.push({ type: 'turn', turn: current });
      return;
    }
    if (referenced.has(entry.id)) return;
    if (entry.sessionStart) {
      current = null;
      sections.push({ type: 'note', entry });
      return;
    }
    if (legacy && entry.kind === 'user') {
      current = { id: entry.id, prompt: entry, items: [], startedAt: entry.ts };
      sections.push({ type: 'turn', turn: current });
      return;
    }
    if (!legacy && entry.kind === 'user') {
      queued.push(entry);
      return;
    }
    if (entry.kind === 'peer' && entry.peer?.toAgentId === selfId && entry.peer.status === 'queued') {
      queued.push(entry);
      return;
    }
    if (current) (current as Turn).items.push(entry);
    else sections.push({ type: 'note', entry });
  });
  return { sections, queued };
}

