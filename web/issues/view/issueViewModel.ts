// What the full-pane issue view shows (ACH-D41, ACH-D43 phase 4), kept pure so it is tested
// without a DOM: sub-issues and their quiet "3/5" count (ACH-D46 progress A), relations both ways,
// activity lines, the due date's tone, and the property menus' options.
import { CLOSED_STATUSES, ISSUE_PRIORITIES, ISSUE_TEXT_MAX, ISSUE_TITLE_MAX, issueDescription, ISSUE_PRIORITY_LABEL, ISSUE_STATUS_LABEL, ISSUE_STATUSES } from '../../../shared/issues.ts';
import type { IssueActor, IssueEvent, IssuePriority, IssueRelationType, IssueStatus, SuperIssue } from '../../../shared/types.ts';

type Issue = Pick<SuperIssue, 'id' | 'key' | 'title' | 'status' | 'priority' | 'parentId' | 'relations' | 'order' | 'dueDate' | 'agentId' | 'createdAt'>;

/** An issue's sub-issues in backlog order, and the quiet count of those done: "3/5". Canceled ones are left out of the count. */
export function subIssues<T extends Issue>(issues: readonly T[], id: string): { items: T[]; done: number; total: number; label: string } {
  const items = issues.filter(i => i.parentId === id).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const counted = items.filter(i => i.status !== 'canceled');
  const done = counted.filter(i => i.status === 'done').length;
  return { items, done, total: counted.length, label: counted.length ? `${done}/${counted.length}` : '' };
}

export type RelationLabel = 'Blocks' | 'Blocked by' | 'Related to' | 'Duplicate of' | 'Duplicated by';

/**
 * An issue's relations, both ways: what it says itself (blocks, related, duplicate of) and what
 * others say about it (blocked by, related to, duplicated by), grouped in that order. Missing
 * issues are dropped (removed since).
 */
export function relationsOf<T extends Issue>(issues: readonly T[], issue: Issue): { label: RelationLabel; issue: T }[] {
  const byId = new Map(issues.map(i => [i.id, i]));
  const out: { label: RelationLabel; issue: T }[] = [];
  const add = (label: RelationLabel, id: string) => {
    const other = byId.get(id);
    if (other && other.id !== issue.id && !out.some(r => r.label === label && r.issue.id === id)) out.push({ label, issue: other });
  };
  const OWN: Record<IssueRelationType, RelationLabel> = { blocks: 'Blocks', related: 'Related to', duplicate_of: 'Duplicate of' };
  const THEIRS: Record<IssueRelationType, RelationLabel> = { blocks: 'Blocked by', related: 'Related to', duplicate_of: 'Duplicated by' };
  for (const r of issue.relations) add(OWN[r.type], r.issueId);
  for (const other of issues) for (const r of other.relations) if (r.issueId === issue.id) add(THEIRS[r.type], other.id);
  const order: RelationLabel[] = ['Blocked by', 'Blocks', 'Related to', 'Duplicate of', 'Duplicated by'];
  return out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
}

/** The parent, for the breadcrumb and the Parent field. */
export function parentOf<T extends Issue>(issues: readonly T[], issue: Issue): T | undefined {
  return issue.parentId ? issues.find(i => i.id === issue.parentId) : undefined;
}

/** A due date's tone: overdue (danger), today (warning), or quiet; with its words ("Today, 13 Nov"). */
export function dueTone(dueDate: string | undefined, status: IssueStatus, now: Date): { tone: 'danger' | 'warning' | 'quiet'; text: string } | null {
  if (!dueDate) return null;
  const [y, m, d] = dueDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  const due = new Date(y, m - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const day = `${d} ${due.toLocaleString('en', { month: 'short' })}${y !== now.getFullYear() ? ` ${y}` : ''}`;
  const closed = CLOSED_STATUSES.includes(status);
  if (days === 0) return { tone: closed ? 'quiet' : 'warning', text: `Today, ${day}` };
  if (days < 0) return { tone: closed ? 'quiet' : 'danger', text: days === -1 ? `Yesterday, ${day}` : day };
  return { tone: 'quiet', text: days === 1 ? `Tomorrow, ${day}` : day };
}

/** Who did something, in words: You, the SuperAgent, an agent by name (or "An agent" once removed), PodCode, git (a merge that closed it). */
export function actorName(actor: IssueActor, agentName: (id: string) => string | undefined): string {
  if (actor.kind === 'user') return 'You';
  if (actor.kind === 'super') return 'SuperAgent';
  if (actor.kind === 'podcode') return 'PodCode';
  if (actor.kind === 'git') return 'git';
  return agentName(actor.id) ?? 'An agent';
}

/** One activity entry as a line: what changed, in plain words. Comments carry their text apart. */
export function activityLine(event: IssueEvent, agentName: (id: string) => string | undefined): string {
  const statusWord = (s?: string) => (s && s in ISSUE_STATUS_LABEL ? ISSUE_STATUS_LABEL[s as IssueStatus] : s ?? '');
  switch (event.kind) {
    case 'created': return 'created the issue';
    case 'comment': return 'commented';
    case 'status': return `moved it ${event.from ? `from ${statusWord(event.from)} ` : ''}to ${statusWord(event.to)}${event.text ? ` (${event.text})` : ''}`;
    case 'priority': return `set priority ${event.to && event.to in ISSUE_PRIORITY_LABEL ? ISSUE_PRIORITY_LABEL[event.to as IssuePriority] : event.to}`;
    case 'assignee': return event.to ? `assigned it to ${agentName(event.to) ?? 'an agent'}` : 'unassigned it';
    case 'migrated': return event.text ? `updated it to the new issue model: ${event.text}` : 'updated it to the new issue model';
    default: return 'changed it';
  }
}

/** Activity, oldest first (as stored), with comments kept apart for their own block. */
export function activityOf(issue: Pick<SuperIssue, 'activity'>): IssueEvent[] {
  return [...(issue.activity ?? [])].sort((a, b) => a.at - b.at);
}

/** The status menu's options: open statuses first in their group order, then Done and Canceled. */
export const STATUS_OPTIONS: readonly IssueStatus[] = [...ISSUE_STATUSES.filter(s => !CLOSED_STATUSES.includes(s)), ...CLOSED_STATUSES];
export const PRIORITY_OPTIONS: readonly IssuePriority[] = ['none', ...ISSUE_PRIORITIES.filter(p => p !== 'none')];

/** Labels: one per line or comma, trimmed, deduplicated, case kept; at most 12 of up to 32 characters. */
export function parseLabels(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const label = raw.trim().slice(0, 32);
    if (label && !out.some(l => l.toLowerCase() === label.toLowerCase())) out.push(label);
  }
  return out.slice(0, 12);
}

/** What a filter typed in a property menu keeps: every word, in the label (MonoCode's filterOptions rule). */
export function matchesQuery(label: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = label.toLowerCase();
  return words.every(w => text.includes(w));
}

const KEYS: Record<string, 'status' | 'priority' | 'due' | 'labels'> = { s: 'status', p: 'priority', d: 'due', l: 'labels' };

/** A key typed in the view that is not meant for a field: S, P, D, L with no modifier. */
export function propertyKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, target: EventTarget | null): 'status' | 'priority' | 'due' | 'labels' | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const el = target as { isContentEditable?: boolean; tagName?: string } | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? ''))) return null;
  return KEYS[e.key.toLowerCase()] ?? null;
}


/** The editors' limits: the issue model's own (shared/issues.ts), so the view never offers more than it saves. */
export const TITLE_MAX = ISSUE_TITLE_MAX;
export const TEXT_MAX = ISSUE_TEXT_MAX;

/** A title edit to save: one line, spaces collapsed, within the limit; null when empty or unchanged (it reverts). */
export function titleToSave(draft: string, title: string): string | null {
  const next = draft.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return next && next !== title ? next : null;
}

/** A description edit to save, as the model stores it (line breaks kept); null when empty or unchanged. */
export function descriptionToSave(draft: string, text: string): string | null {
  const next = issueDescription(draft.slice(0, TEXT_MAX));
  return next && next !== issueDescription(text) ? next : null;
}

/**
 * A due date to save when the field is left: a whole day (YYYY-MM-DD, years 2000 to 2999) or
 * cleared (null); undefined when unchanged or half typed, like the 0002-11-13 a year passes
 * through while it is typed, which is never sent.
 */
export function dueToSave(draft: string, current: string | undefined): string | null | undefined {
  if (!draft) return current ? null : undefined;
  if (!/^2\d{3}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(draft)) return undefined;
  return draft === current ? undefined : draft;
}

/**
 * One edit's save: nothing when there is nothing to save (undefined); otherwise the write, and on
 * a refusal the field goes back to what is stored ('reverted'), the error having shown as a toast.
 */
export async function commitEdit<T>(next: T | undefined, write: (value: T) => Promise<boolean>): Promise<'unchanged' | 'saved' | 'reverted'> {
  if (next === undefined) return 'unchanged';
  return (await write(next)) ? 'saved' : 'reverted';
}
