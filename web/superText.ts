/** The SuperAgent's words for the page. Pure, so it is tested directly. */
import type { Agent, GoalStatus, RoutineSchedule, SuperAction, SuperAsk, SuperGoal, SuperRoutine } from '../shared/types.ts';

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

/** The SuperAgent's own tabs in the right panel. */
export type SuperTab = 'decisions' | 'goals' | 'routines';
export const SUPER_TABS: readonly SuperTab[] = ['decisions', 'goals', 'routines'];

/** The right panel's tab for the SuperAgent: the last one picked, or Decisions the first time. */
export function superPanelView<V extends string>(saved: string | undefined, views: readonly V[]): V {
  return saved !== undefined && (views as readonly string[]).includes(saved) ? saved as V : 'decisions' as V;
}

interface SuperLists {
  log?: readonly SuperAction[];
  goals?: readonly SuperGoal[];
  routines?: readonly SuperRoutine[];
}

/**
 * The count on each tab: decisions made today that can still be undone, open goals, and routines the
 * SuperAgent proposed that wait for you. `now` decides what today is, in local time.
 */
export function superTabCounts(lists: SuperLists, now: number): Record<SuperTab, number> {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return {
    decisions: decisionRows(lists.log).filter(r => r.undoable && r.at >= day.getTime()).length,
    goals: goalSections(lists.goals).open.length,
    routines: (lists.routines ?? []).filter(r => r.proposed).length,
  };
}

/** When the newest item on each tab came: a decision made, a goal or a routine added. 0 for none. */
export function superTabLatest(lists: SuperLists): Record<SuperTab, number> {
  const newest = (times: number[]) => times.reduce((max, t) => Math.max(max, t), 0);
  return {
    decisions: newest((lists.log ?? []).map(a => a.at)),
    goals: newest((lists.goals ?? []).map(g => g.createdAt)),
    routines: newest((lists.routines ?? []).map(r => r.createdAt)),
  };
}

/** Which tabs show a dot: something newer than you last saw there, on a tab that is not open. */
export function superTabDots(latest: Record<SuperTab, number>, seen: Partial<Record<SuperTab, number>>, selected: string): Record<SuperTab, boolean> {
  const dot = (tab: SuperTab) => tab !== selected && latest[tab] > (seen[tab] ?? 0);
  return { decisions: dot('decisions'), goals: dot('goals'), routines: dot('routines') };
}
