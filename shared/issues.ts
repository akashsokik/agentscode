import type { IssueEvent, IssuePriority, IssueStatus, SuperIssue } from './types.ts';

// Goals became Issues (ACH-D38). The old command names still run (server/comms/tools.ts maps them),
// and transcripts that used them read with the new names (web/toolPresentation.ts).
export const ISSUE_TOOL_ALIASES = { list_goals: 'list_issues', add_goal: 'add_issue', update_goal: 'update_issue', complete_goal: 'complete_issue' } as const;
export type LegacyIssueTool = keyof typeof ISSUE_TOOL_ALIASES;

/** A command's current name: an old goal command as its issue command, anything else as it is. */
export function currentToolName(name: string): string {
  return (ISSUE_TOOL_ALIASES as Record<string, string>)[name] ?? name;
}

// ---- the issue model (ACH-D41) ----------------------------------------------------------------

/** Every status, in the order the Issues views group them. */
export const ISSUE_STATUSES: readonly IssueStatus[] = ['needs_you', 'in_review', 'in_progress', 'waiting', 'todo', 'backlog', 'done', 'canceled'];
export const ISSUE_PRIORITIES: readonly IssuePriority[] = ['urgent', 'high', 'normal', 'low', 'none'];
export const CLOSED_STATUSES: readonly IssueStatus[] = ['done', 'canceled'];
export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  needs_you: 'Needs you', in_review: 'In review', in_progress: 'In progress', waiting: 'Waiting', todo: 'Todo', backlog: 'Backlog', done: 'Done', canceled: 'Canceled',
};
export const ISSUE_PRIORITY_LABEL: Record<IssuePriority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low', none: 'No priority' };

/** Open: not done or canceled. Open issues are the backlog; closed ones are kept for a while, newest first. */
export function isOpenIssue(issue: Pick<SuperIssue, 'status'>): boolean {
  return !CLOSED_STATUSES.includes(issue.status);
}

/** The statuses before ACH-D41, as stored by older builds and still accepted from the agent tools until they change. */
export type LegacyIssueStatus = 'queued' | 'in_progress' | 'blocked' | 'done';
const FROM_LEGACY: Record<LegacyIssueStatus, IssueStatus> = { queued: 'todo', in_progress: 'in_progress', blocked: 'needs_you', done: 'done' };
const TO_LEGACY: Record<IssueStatus, LegacyIssueStatus> = {
  needs_you: 'blocked', waiting: 'blocked', in_review: 'in_progress', in_progress: 'in_progress', todo: 'queued', backlog: 'queued', done: 'done', canceled: 'done',
};

/** A status from anyone: a current one as it is, an old one (queued, blocked) as its new name; null when neither. */
export function issueStatusFrom(value: unknown): IssueStatus | null {
  if ((ISSUE_STATUSES as readonly unknown[]).includes(value)) return value as IssueStatus;
  return Object.hasOwn(FROM_LEGACY, String(value)) ? FROM_LEGACY[value as LegacyIssueStatus] : null;
}

/** The old status for a current one, for builds from before ACH-D41 (super.json's "issues" and "goals"). */
export function legacyIssueStatus(status: IssueStatus): LegacyIssueStatus {
  return TO_LEGACY[status];
}

/** An issue's title: its first sentence or line, at most 120 characters. */
export function issueTitle(text: string): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  return first.length > 120 ? `${first.slice(0, 117).trimEnd()}…` : first;
}

/** A record as builds before ACH-D41 stored it. */
export interface LegacyIssue {
  id: string; text: string; projectId: string | null; status: LegacyIssueStatus; order: number; createdAt: number; updatedAt: number;
  by: 'user' | 'super'; agentId?: string; delegationId?: string; notes?: string; doneAt?: number;
}

export function isLegacyIssue(raw: unknown): raw is LegacyIssue {
  const g = raw as Partial<LegacyIssue> | null;
  return Boolean(g) && typeof g!.id === 'string' && typeof g!.text === 'string' && g!.text.trim() !== ''
    && (g!.projectId === null || typeof g!.projectId === 'string') && Object.hasOwn(FROM_LEGACY, String(g!.status))
    && typeof g!.order === 'number' && Number.isFinite(g!.order) && typeof g!.createdAt === 'number' && typeof g!.updatedAt === 'number'
    && (g!.by === 'user' || g!.by === 'super');
}

/**
 * An old record as a current issue, nothing lost: its status by the new names (queued is Todo,
 * blocked is Needs you), its first sentence as the title and all of it as the text, its notes as the
 * first comment, its agent as the assignee, priority none, and its key from `key`.
 */
export function migrateIssue(old: LegacyIssue, key: string, now: number): SuperIssue {
  const status = FROM_LEGACY[old.status];
  const creator = old.by === 'user' ? { kind: 'user' as const } : { kind: 'super' as const };
  const activity: IssueEvent[] = [{ at: old.createdAt, by: creator, kind: 'created' }];
  if (old.notes) activity.push({ at: old.updatedAt, by: creator, kind: 'comment', text: old.notes });
  if (status === 'done' && old.doneAt) activity.push({ at: old.doneAt, by: creator, kind: 'status', to: 'done' });
  activity.push({ at: now, by: { kind: 'podcode' }, kind: 'migrated', text: `Status ${old.status} became ${status}; key ${key}.` });
  return {
    id: old.id, key, title: issueTitle(old.text), text: old.text, projectId: old.projectId, status, priority: 'none', labels: [], relations: [],
    order: old.order, createdAt: old.createdAt, updatedAt: old.updatedAt, by: old.by,
    ...(old.agentId ? { agentId: old.agentId } : {}), ...(old.delegationId ? { delegationId: old.delegationId } : {}),
    ...(old.notes ? { notes: old.notes } : {}), ...(old.doneAt !== undefined ? { doneAt: old.doneAt } : {}),
    activity,
  };
}

/** A current issue as an older build can read it: the old fields only, the status by its old name. */
export function legacyIssue(issue: SuperIssue): LegacyIssue {
  return {
    id: issue.id, text: issue.text, projectId: issue.projectId, status: legacyIssueStatus(issue.status), order: issue.order,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, by: issue.by,
    ...(issue.agentId ? { agentId: issue.agentId } : {}), ...(issue.delegationId ? { delegationId: issue.delegationId } : {}),
    ...(issue.notes ? { notes: issue.notes } : {}),
    ...(issue.doneAt !== undefined ? { doneAt: issue.doneAt } : issue.canceledAt !== undefined ? { doneAt: issue.canceledAt } : {}),
  };
}

/**
 * The issues to use, from issues.json's current list and super.json's old-format copy ("issues").
 * PodCode always writes both together, so where they differ an older build changed the old copy
 * after a downgrade, and that change wins:
 * - in both, the old copy newer: its text, project, links, notes and dates; its status by the new
 *   name unless it is still what the current status reads as (in_review stays in_review);
 * - only in the old copy: added, migrated;
 * - only in the current list: removed by the older build.
 * With no current list yet (the first start of this build), every old record is migrated; with no
 * old-format copy (null), the current list is used as it is.
 */
export function reconcileIssues(current: SuperIssue[] | null, legacy: LegacyIssue[] | null, keyFor: (old: LegacyIssue) => string, now: number): SuperIssue[] {
  if (!current) return (legacy ?? []).map(old => migrateIssue(old, keyFor(old), now));
  // No old-format copy at all (not written by PodCode): nothing to reconcile with.
  if (!legacy) return current;
  const byId = new Map(current.map(i => [i.id, i]));
  const out: SuperIssue[] = [];
  for (const old of legacy) {
    const mine = byId.get(old.id);
    if (!mine) { out.push(migrateIssue(old, keyFor(old), now)); continue; }
    if (old.updatedAt <= mine.updatedAt) { out.push(mine); continue; }
    const status = legacyIssueStatus(mine.status) === old.status ? mine.status : FROM_LEGACY[old.status];
    const next: SuperIssue = {
      ...mine, text: old.text, projectId: old.projectId, status, order: old.order, updatedAt: old.updatedAt,
      // The title follows a changed text only while it was the text's own start, as updateIssue does:
      // an older build never sees a title, so one set by hand stays.
      title: old.text !== mine.text && mine.title === issueTitle(mine.text) ? issueTitle(old.text) : mine.title,
    };
    for (const k of ['agentId', 'delegationId', 'notes', 'doneAt'] as const) {
      if (old[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = old[k]; else delete next[k];
    }
    if (status !== mine.status) next.activity = [...mine.activity, { at: old.updatedAt, by: { kind: 'podcode' }, kind: 'status', from: mine.status, to: status, text: 'Changed by an older PodCode build.' }];
    out.push(next);
  }
  // In the current list but not the old copy: an older build removed it, so it stays removed.
  return out;
}
