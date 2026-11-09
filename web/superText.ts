/** The SuperAgent's words for the page. Pure, so it is tested directly. */
import type { Agent, GoalStatus, RoutineSchedule, SuperAction, SuperAsk, SuperGoal } from '../shared/types.ts';

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

/**
 * What the header toggle (or Hide, Escape and a click outside, which close it) leaves: shown, it
 * closes; hidden, it opens. In a wide pane that is your remembered choice; in a narrow one only the
 * peek, so a narrow pane never changes the wide-pane choice.
 */
export function nextLogState(mode: 'beside' | 'over' | 'hidden', paneWidth: number, open: boolean, peek: boolean): { open: boolean; peek: boolean } {
  if (mode === 'over') return { open, peek: false };
  if (mode === 'beside') return { open: false, peek: false };
  return paneWidth >= SUPER_LOG_MIN_PANE ? { open: true, peek: false } : { open, peek: true };
}

/** The most the log may be dragged to in a pane: beside, leaving the conversation its room; over, the pane. */
export function superLogMax(min: number, paneWidth: number, mode: 'beside' | 'over'): number {
  return mode === 'beside' ? Math.max(min, paneWidth - SUPER_LOG_CONVERSATION_MIN) : Math.max(min, paneWidth);
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

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { queued: 'Queued', in_progress: 'In progress', blocked: 'Needs you', done: 'Done' };

/** The backlog as the Goals tab shows it: open goals in order, then done ones, newest first. */
export function goalSections(goals: readonly SuperGoal[] | undefined): { open: SuperGoal[]; done: SuperGoal[] } {
  const all = goals ?? [];
  return {
    open: all.filter(g => g.status !== 'done').sort((a, b) => a.order - b.order),
    done: all.filter(g => g.status === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
  };
}

/** "2 messages to the SuperAgent waiting: quiet hours. ..." The same words in its pane and the quick window. */
export function heldText(held: { count: number; reason: string }): string {
  const what = `${held.count} ${held.count === 1 ? 'message' : 'messages'} to the SuperAgent waiting: ${held.reason}.`;
  const then = held.reason === 'the daily budget is used' ? 'Raise the budget in Settings, or they go tomorrow.' : 'They go when it may take a turn again.';
  return `${what} ${then} Only work it started on its own waits; your messages and the work you asked for always go.`;
}

/** "Daily at 09:00", "Every 6 hours". */
export function scheduleLabel(schedule: RoutineSchedule): string {
  return schedule.kind === 'daily' ? `Daily at ${schedule.at}` : `Every ${schedule.hours} ${schedule.hours === 1 ? 'hour' : 'hours'}`;
}
