/** The SuperAgent's words for the page. Pure, so it is tested directly. */
import type { Agent, IssueStatus, RoutineSchedule, SuperAction, SuperAsk, SuperIssue, SuperRoutine } from '../shared/types.ts';
import { ISSUE_STATUS_LABEL, isOpenIssue } from '../shared/issues.ts';

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

export { ISSUE_STATUS_LABEL };

/** The backlog as the Issues tab shows it: open issues in order, then done ones, newest first. */
export function issueSections(issues: readonly SuperIssue[] | undefined): { open: SuperIssue[]; done: SuperIssue[] } {
  const all = issues ?? [];
  return {
    open: all.filter(isOpenIssue).sort((a, b) => a.order - b.order),
    done: all.filter(g => !isOpenIssue(g)).sort((a, b) => (b.doneAt ?? b.canceledAt ?? 0) - (a.doneAt ?? a.canceledAt ?? 0)),
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
/** What was seen on each tab, saved before Goals became Issues (ACH-D38): "goals" counts as "issues". */
export function migrateSeen(saved: Record<string, unknown>): Record<string, unknown> {
  const { goals, ...rest } = saved;
  return rest.issues === undefined && goals !== undefined ? { ...rest, issues: goals } : rest;
}

export type SuperTab = 'decisions' | 'issues' | 'routines';
export const SUPER_TABS: readonly SuperTab[] = ['decisions', 'issues', 'routines'];

/** The right panel's tab for the SuperAgent: the last one picked, or Decisions the first time. */
export function superPanelView<V extends string>(saved: string | undefined, views: readonly V[]): V {
  return saved !== undefined && (views as readonly string[]).includes(saved) ? saved as V : 'decisions' as V;
}

interface SuperLists {
  log?: readonly SuperAction[];
  issues?: readonly SuperIssue[];
  routines?: readonly SuperRoutine[];
}

/**
 * The count on each tab: decisions made today that can still be undone, open issues, and routines the
 * SuperAgent proposed that wait for you. `now` decides what today is, in local time.
 */
/** An entry the user made themselves (removing an issue in the tab): it is in the log for Undo, but is nothing new to point them to. */
export const byYou = (action: Pick<SuperAction, 'tool'>) => action.tool === 'remove_issue';

export function superTabCounts(lists: SuperLists, now: number): Record<SuperTab, number> {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return {
    decisions: decisionRows((lists.log ?? []).filter(a => !byYou(a))).filter(r => r.undoable && r.at >= day.getTime()).length,
    issues: issueSections(lists.issues).open.length,
    routines: (lists.routines ?? []).filter(r => r.proposed).length,
  };
}

/** When the newest item on each tab came: a decision made, an issue or a routine added. 0 for none. */
export function superTabLatest(lists: SuperLists): Record<SuperTab, number> {
  const newest = (times: number[]) => times.reduce((max, t) => Math.max(max, t), 0);
  return {
    decisions: newest((lists.log ?? []).filter(a => !byYou(a)).map(a => a.at)),
    issues: newest((lists.issues ?? []).map(g => g.createdAt)),
    routines: newest((lists.routines ?? []).map(r => r.createdAt)),
  };
}

/** Which tabs show a dot: something newer than you last saw there, on a tab that is not open. */
export function superTabDots(latest: Record<SuperTab, number>, seen: Partial<Record<SuperTab, number>>, selected: string): Record<SuperTab, boolean> {
  const dot = (tab: SuperTab) => tab !== selected && latest[tab] > (seen[tab] ?? 0);
  return { decisions: dot('decisions'), issues: dot('issues'), routines: dot('routines') };
}
