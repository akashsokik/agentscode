import { useMemo, useRef } from 'react';
import { alignHints, type MentionHint } from '../../shared/mentions.ts';
import type { MentionPick } from './tokens.ts';

/** The hint a pick from the @ picker leaves: which agent or project it was, at the @ it replaced. */
export function hintFor(pick: MentionPick, start: number): MentionHint | null {
  if (pick.kind === 'agent') return { kind: 'agent', id: pick.agent.id, name: pick.agent.name, start };
  if (pick.kind === 'project') return { kind: 'project', id: pick.project.id, name: pick.project.name, start };
  return null;
}

/**
 * What a composer picked from its @ picker, so an agent and a project with the same name stay apart
 * in the chips and the note (shared/mentions.ts findMentions). `for(text)` gives the picks still in
 * the text, at their @; `clear` after sending.
 */
export function useMentionHints() {
  const hints = useRef<MentionHint[]>([]);
  return useMemo(() => ({
    add(pick: MentionPick, start: number) {
      const hint = hintFor(pick, start);
      if (hint) hints.current = [...hints.current, hint].slice(-100);
    },
    for: (text: string) => alignHints(text, hints.current),
    clear() { hints.current = []; },
  }), []);
}

/** The names a mention can be, for the @ token: a picker stays open while typing one with spaces. */
export function mentionNames(agents: readonly { name: string }[] | undefined, projects: readonly { name: string }[] | undefined): string[] {
  return [...(agents ?? []), ...(projects ?? [])].map(n => n.name);
}
