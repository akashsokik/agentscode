/** The SuperAgent's words for the page. Pure, so it is tested directly. */
import type { Agent, SuperAction, SuperAsk } from '../shared/types.ts';

/** Questions the SuperAgent asked that wait for the user, newest first. */
export function openAsks(asks: readonly SuperAsk[] | undefined): SuperAsk[] {
  return (asks ?? []).filter(a => a.answeredAt === undefined);
}

/** A line on what the SuperAgent is doing, for the status bar and the menu bar. */
export function superLabel(agent: Pick<Agent, 'status' | 'activity'> | undefined, waiting: number): string {
  if (!agent) return 'Set up the SuperAgent';
  const doing = agent.status === 'working' ? agent.activity || 'Working' : agent.status === 'error' ? 'Hit a problem' : 'Watching your agents';
  return waiting ? `${doing} · ${waiting} waiting for you` : doing;
}

/** Below this pane width the decision log no longer sits beside the conversation; it opens over it instead. */
export const SUPER_LOG_MIN_PANE = 760;

/**
 * How the decision log shows. In a wide pane, your remembered choice (`open`) decides: beside the
 * conversation or not at all. In a narrow pane it shows only over the conversation, only while you
 * asked for it there (`peek`), whatever the wide-pane choice is; peeking never changes that choice.
 */
export function superLogMode(open: boolean, paneWidth: number, peek: boolean): 'beside' | 'over' | 'hidden' {
  if (paneWidth >= SUPER_LOG_MIN_PANE) return open ? 'beside' : 'hidden';
  return peek ? 'over' : 'hidden';
}

/** The narrowest the conversation gets while the log sits beside it, in px. */
export const SUPER_LOG_CONVERSATION_MIN = 420;

/**
 * The log's width in a pane `paneWidth` wide, from the width you chose: beside the conversation it
 * leaves that SUPER_LOG_CONVERSATION_MIN (never going under `min`); over it, it never runs past the
 * pane's left edge.
 */
export function superLogWidth(chosen: number, min: number, paneWidth: number, mode: 'beside' | 'over'): number {
  if (paneWidth <= 0) return Math.round(chosen);
  const max = mode === 'beside' ? Math.max(min, paneWidth - SUPER_LOG_CONVERSATION_MIN) : paneWidth;
  return Math.round(Math.min(chosen, max));
}

/** Once the pane is wide, asking to see the log over a narrow pane is spent: narrowing again does not reopen it over the conversation. */
export function peekAfter(paneWidth: number, peek: boolean): boolean {
  return paneWidth >= SUPER_LOG_MIN_PANE ? false : peek;
}

/** What the header toggle does: in a wide pane it flips the remembered choice; in a narrow one only the peek. */
export function toggleSuperLog(open: boolean, paneWidth: number, peek: boolean): { open: boolean; peek: boolean } {
  return paneWidth >= SUPER_LOG_MIN_PANE ? { open: !open, peek: false } : { open, peek: !peek };
}

export interface DecisionRow {
  id: string;
  summary: string;
  why: string;
  at: number;
  /** It can still be put back. */
  undoable: boolean;
  undoneAt?: number;
}

/** The decisions as the log lists them, newest first: undoable while not yet undone. */
export function decisionRows(log: readonly SuperAction[] | undefined): DecisionRow[] {
  return [...(log ?? [])]
    .sort((a, b) => b.at - a.at)
    .map(a => ({ id: a.id, summary: a.summary, why: a.why, at: a.at, undoable: Boolean(a.undo) && !a.undoneAt, ...(a.undoneAt ? { undoneAt: a.undoneAt } : {}) }));
}
