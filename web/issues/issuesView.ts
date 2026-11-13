import { CLOSED_STATUSES, ISSUE_PRIORITIES, ISSUE_PRIORITY_LABEL, ISSUE_STATUSES, ISSUE_STATUS_LABEL, isOpenIssue } from '../../shared/issues.ts';
import type { IssuePriority, IssueStatus, SuperIssue } from '../../shared/types.ts';

// The Issues page's logic (ACH-D42, ACH-D43 phase 3), kept apart from React so it is tested on its
// own: the views, the Filter menu's properties and chips, grouping, ordering and the Display options.
// The right panel's list moves onto this in phase 4.

// ---- Views ---------------------------------------------------------------------------------------

export type IssuesViewName = 'all' | 'active' | 'backlog' | 'mine';
export const ISSUE_VIEWS: readonly { view: IssuesViewName; label: string }[] = [
  { view: 'all', label: 'All' },
  { view: 'active', label: 'Active' },
  { view: 'backlog', label: 'Backlog' },
  { view: 'mine', label: 'Mine' },
];

/**
 * All: every issue. Active: open and past the backlog (Needs you to Todo). Backlog: status Backlog.
 * Mine: assigned to you, or waiting on you (Needs you), since both are yours to act on.
 */
export function inView(issue: SuperIssue, view: IssuesViewName): boolean {
  if (view === 'active') return isOpenIssue(issue) && issue.status !== 'backlog';
  if (view === 'backlog') return issue.status === 'backlog';
  if (view === 'mine') return Boolean(issue.forUser) || issue.status === 'needs_you';
  return true;
}

// ---- Filter ----------------------------------------------------------------------------------------

export type IssueProperty = 'status' | 'priority' | 'assignee' | 'project' | 'labels' | 'due';
export const ISSUE_PROPERTIES: readonly { property: IssueProperty; label: string }[] = [
  { property: 'status', label: 'Status' },
  { property: 'priority', label: 'Priority' },
  { property: 'assignee', label: 'Assignee' },
  { property: 'project', label: 'Project' },
  { property: 'labels', label: 'Labels' },
  { property: 'due', label: 'Due date' },
];

/** Values per property; within one property any value matches, across properties all must. */
export type IssueFilters = Partial<Record<IssueProperty, string[]>>;

/** Assignee values: YOU, an agent's id, or NONE. Project and label values: an id or name, or NONE. */
export const YOU = 'you';
export const NONE = 'none';

export type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
export const DUE_BUCKETS: readonly DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];
export const DUE_LABEL: Record<DueBucket, string> = { overdue: 'Overdue', today: 'Due today', week: 'Due this week', later: 'Due later', none: 'No due date' };

/** A calendar day in local time, "2026-11-13": what dueDate is compared with. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from `from` to `to`, both "YYYY-MM-DD". */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Where a due date falls from today: overdue, today, within the next six days, later, or none. */
export function dueBucket(dueDate: string | undefined, today: string): DueBucket {
  if (!dueDate) return 'none';
  const days = daysBetween(today, dueDate);
  if (!Number.isFinite(days)) return 'none';
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= 6 ? 'week' : 'later';
}

/** The values an issue has for a property (labels can be several, the rest one). */
export function propertyValues(issue: SuperIssue, property: IssueProperty, today: string): string[] {
  switch (property) {
    case 'status': return [issue.status];
    case 'priority': return [issue.priority];
    case 'assignee': return [issue.forUser ? YOU : issue.agentId ?? NONE];
    case 'project': return [issue.projectId ?? NONE];
    case 'labels': return issue.labels.length ? issue.labels : [NONE];
    case 'due': return [dueBucket(issue.dueDate, today)];
  }
}

export function matchesFilters(issue: SuperIssue, filters: IssueFilters, today: string, except?: IssueProperty): boolean {
  return (Object.keys(filters) as IssueProperty[]).every(property => {
    const wanted = filters[property];
    if (property === except || !wanted?.length) return true;
    return propertyValues(issue, property, today).some(v => wanted.includes(v));
  });
}

/** Turns one value of a property on or off; a property left with no values is dropped. */
export function toggleFilter(filters: IssueFilters, property: IssueProperty, value: string): IssueFilters {
  const current = filters[property] ?? [];
  const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
  const { [property]: _dropped, ...rest } = filters;
  return next.length ? { ...rest, [property]: next } : rest;
}

export function clearFilter(filters: IssueFilters, property: IssueProperty): IssueFilters {
  const { [property]: _dropped, ...rest } = filters;
  return rest;
}

export function activeFilters(filters: IssueFilters): { property: IssueProperty; values: string[] }[] {
  return ISSUE_PROPERTIES.map(p => ({ property: p.property, values: filters[p.property] ?? [] })).filter(f => f.values.length);
}

/** Names for ids: agents and projects come from the snapshot. */
export interface IssueNames {
  agent: (id: string) => string | undefined;
  project: (id: string) => string | undefined;
}

/** A value of a property in words: "In progress", "You", "Ada", "No project", "Due today". */
export function valueLabel(property: IssueProperty, value: string, names: IssueNames): string {
  switch (property) {
    case 'status': return ISSUE_STATUS_LABEL[value as IssueStatus] ?? value;
    case 'priority': return ISSUE_PRIORITY_LABEL[value as IssuePriority] ?? value;
    case 'assignee': return value === YOU ? 'You' : value === NONE ? 'No assignee' : names.agent(value) ?? 'Removed agent';
    case 'project': return value === NONE ? 'No project' : names.project(value) ?? 'Removed project';
    case 'labels': return value === NONE ? 'No labels' : value;
    case 'due': return DUE_LABEL[value as DueBucket] ?? value;
  }
}

/** A chip's words: "Status is Todo", "Status is Todo, In progress", "Labels is any of 3". */
export function chipText(property: IssueProperty, values: string[], names: IssueNames): string {
  const label = ISSUE_PROPERTIES.find(p => p.property === property)!.label;
  if (values.length > 2) return `${label} is any of ${values.length}`;
  return `${label} is ${values.map(v => valueLabel(property, v, names)).join(', ')}`;
}

/**
 * A property's values for its Filter submenu, each with how many issues have it among those the
 * other filters keep: every status and priority, the assignees, projects and labels in use (plus any
 * already chosen), and the due-date ranges.
 */
export function filterOptions(issues: readonly SuperIssue[], property: IssueProperty, filters: IssueFilters, today: string, names: IssueNames): { value: string; label: string; count: number }[] {
  const pool = issues.filter(g => matchesFilters(g, filters, today, property));
  const counts = new Map<string, number>();
  for (const issue of pool) for (const v of propertyValues(issue, property, today)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let values: string[];
  if (property === 'status') values = [...ISSUE_STATUSES];
  else if (property === 'priority') values = [...ISSUE_PRIORITIES];
  else if (property === 'due') values = [...DUE_BUCKETS];
  else {
    const seen = new Set([...issues.flatMap(g => propertyValues(g, property, today)), ...(filters[property] ?? [])]);
    const named = [...seen].filter(v => v !== NONE && v !== YOU).sort((a, b) => valueLabel(property, a, names).localeCompare(valueLabel(property, b, names)));
    values = [...(property === 'assignee' && seen.has(YOU) ? [YOU] : []), ...named, ...(seen.has(NONE) ? [NONE] : [])];
  }
  return values.map(value => ({ value, label: valueLabel(property, value, names), count: counts.get(value) ?? 0 }));
}

// ---- Search ----------------------------------------------------------------------------------------

/** Every word of the query in the key, title, description or labels. */
export function matchesQuery(issue: SuperIssue, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = [issue.key, issue.title, issue.text, ...issue.labels].join(' ').toLowerCase();
  return words.every(w => text.includes(w));
}

// ---- Display ---------------------------------------------------------------------------------------

export type IssuesGrouping = 'status' | 'assignee' | 'project' | 'priority' | 'none';
export type IssuesOrdering = 'manual' | 'priority' | 'updated' | 'created' | 'due';
export type RowProperty = 'key' | 'priority' | 'labels' | 'project' | 'due' | 'assignee' | 'updated';

/** `short` fits the Display menu's segmented control; `label` is the full name. */
export const GROUPINGS: readonly { value: IssuesGrouping; label: string; short: string }[] = [
  { value: 'status', label: 'Status', short: 'Status' }, { value: 'assignee', label: 'Assignee', short: 'Assignee' }, { value: 'project', label: 'Project', short: 'Project' },
  { value: 'priority', label: 'Priority', short: 'Priority' }, { value: 'none', label: 'No grouping', short: 'None' },
];
export const ORDERINGS: readonly { value: IssuesOrdering; label: string; short: string }[] = [
  { value: 'manual', label: 'Backlog order', short: 'Backlog' }, { value: 'priority', label: 'Priority', short: 'Priority' }, { value: 'updated', label: 'Last updated', short: 'Updated' },
  { value: 'created', label: 'Created', short: 'Created' }, { value: 'due', label: 'Due date', short: 'Due' },
];
export const ROW_PROPERTIES: readonly { value: RowProperty; label: string }[] = [
  { value: 'key', label: 'Key' }, { value: 'priority', label: 'Priority' }, { value: 'labels', label: 'Labels' }, { value: 'project', label: 'Project' }, { value: 'due', label: 'Due date' }, { value: 'assignee', label: 'Assignee' }, { value: 'updated', label: 'Updated' },
];

export interface IssuesDisplay {
  groupBy: IssuesGrouping;
  orderBy: IssuesOrdering;
  /** Off: sub-issues are left out of the list (they show under their parent's issue view). */
  showSubIssues: boolean;
  /** Groups with nothing in them (only where the values are fixed: status and priority). */
  showEmptyGroups: boolean;
  /** Done and Canceled issues; grouped by status they fold at the bottom. */
  showClosed: boolean;
  /** What each row shows after its title. */
  properties: RowProperty[];
}

export const DEFAULT_DISPLAY: IssuesDisplay = {
  groupBy: 'status', orderBy: 'manual', showSubIssues: true, showEmptyGroups: false, showClosed: true,
  properties: ['key', 'priority', 'labels', 'project', 'due', 'assignee', 'updated'],
};

/** Stored options, checked field by field; anything unknown or missing takes its default. */
export function displayFrom(raw: unknown): IssuesDisplay {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly { value: T }[], fallback: T): T => (allowed.some(a => a.value === value) ? value as T : fallback);
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  const properties = Array.isArray(r.properties) ? ROW_PROPERTIES.map(p => p.value).filter(p => (r.properties as unknown[]).includes(p)) : DEFAULT_DISPLAY.properties;
  return {
    groupBy: pick(r.groupBy, GROUPINGS, DEFAULT_DISPLAY.groupBy),
    orderBy: pick(r.orderBy, ORDERINGS, DEFAULT_DISPLAY.orderBy),
    showSubIssues: bool(r.showSubIssues, DEFAULT_DISPLAY.showSubIssues),
    showEmptyGroups: bool(r.showEmptyGroups, DEFAULT_DISPLAY.showEmptyGroups),
    showClosed: bool(r.showClosed, DEFAULT_DISPLAY.showClosed),
    properties,
  };
}

const DISPLAY_KEY = 'podcode.issues.display';

export function readDisplay(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): IssuesDisplay {
  try {
    return displayFrom(JSON.parse(storage?.getItem(DISPLAY_KEY) ?? 'null'));
  } catch {
    return DEFAULT_DISPLAY;
  }
}

export function saveDisplay(display: IssuesDisplay, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(DISPLAY_KEY, JSON.stringify(display));
  } catch { /* storage full or blocked: the options last until reload */ }
}

// ---- Ordering and grouping -------------------------------------------------------------------------

const PRIORITY_RANK: Record<IssuePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };

/** A copy in the chosen order. Ties keep the backlog order; closed issues sort by when they closed. */
export function sortIssues(issues: readonly SuperIssue[], orderBy: IssuesOrdering): SuperIssue[] {
  const manual = (a: SuperIssue, b: SuperIssue) => {
    const ao = isOpenIssue(a), bo = isOpenIssue(b);
    if (ao !== bo) return ao ? -1 : 1;
    if (!ao) return closedAt(b) - closedAt(a);
    return a.order - b.order;
  };
  const by: Record<IssuesOrdering, (a: SuperIssue, b: SuperIssue) => number> = {
    manual,
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    // Soonest first; no due date last.
    due: (a, b) => (a.dueDate ? (b.dueDate ? a.dueDate.localeCompare(b.dueDate) : -1) : b.dueDate ? 1 : 0),
  };
  return [...issues].sort((a, b) => by[orderBy](a, b) || manual(a, b));
}

function closedAt(issue: SuperIssue): number {
  return issue.doneAt ?? issue.canceledAt ?? issue.updatedAt;
}

export interface IssueGroup {
  key: string;
  label: string;
  items: SuperIssue[];
  /** Done and Canceled when grouped by status: folded until opened. */
  closed: boolean;
}

/** The issues shown in groups, in the Display's order. */
export function groupIssues(issues: readonly SuperIssue[], display: IssuesDisplay, names: IssueNames, today = localDay(Date.now())): IssueGroup[] {
  const sorted = sortIssues(issues, display.orderBy);
  const groupOf = (property: IssueProperty, values: string[], closed: (v: string) => boolean = () => false): IssueGroup[] => values
    .map(value => ({ key: value, label: valueLabel(property, value, names), items: sorted.filter(g => propertyValues(g, property, today)[0] === value), closed: closed(value) }));
  let groups: IssueGroup[];
  switch (display.groupBy) {
    case 'none':
      return sorted.length ? [{ key: 'all', label: 'Issues', items: sorted, closed: false }] : [];
    case 'status':
      groups = groupOf('status', [...ISSUE_STATUSES], v => CLOSED_STATUSES.includes(v as IssueStatus));
      break;
    case 'priority':
      groups = groupOf('priority', [...ISSUE_PRIORITIES]);
      break;
    case 'assignee':
    case 'project': {
      // The values in use: You first, then by name, None last.
      groups = groupOf(display.groupBy, filterOptions(sorted, display.groupBy, {}, today, names).map(o => o.value));
      break;
    }
  }
  // Empty groups only where the values are fixed, and never the closed ones while they are hidden.
  return groups.filter(g => g.items.length || (display.showEmptyGroups && (display.groupBy === 'status' || display.groupBy === 'priority') && (display.showClosed || !g.closed)));
}

/**
 * The issues the Display lets through: without "Sub-issues", only top-level ones, and an issue whose
 * parent is gone (removed, or never there) counts as top-level so it never drops out of sight.
 * Without "Done and Canceled", only open ones.
 */
export function displayedIssues(issues: readonly SuperIssue[] | undefined, display: Pick<IssuesDisplay, 'showSubIssues' | 'showClosed'>): SuperIssue[] {
  const all = issues ?? [];
  const ids = new Set(all.map(g => g.id));
  return all.filter(g => (display.showSubIssues || !g.parentId || !ids.has(g.parentId)) && (display.showClosed || isOpenIssue(g)));
}

/** Everything the page shows, from the issues and the user's choices. */
export function issuesPage(issues: readonly SuperIssue[] | undefined, choice: { view: IssuesViewName; filters: IssueFilters; query: string; display: IssuesDisplay }, names: IssueNames, today: string): {
  counts: Record<IssuesViewName, number>;
  groups: IssueGroup[];
  shown: number;
  /** Issues the view has before the filters and search: tells "nothing here" from "nothing matches". */
  inView: number;
} {
  const all = displayedIssues(issues, choice.display);
  const kept = all.filter(g => matchesFilters(g, choice.filters, today) && matchesQuery(g, choice.query));
  const counts = Object.fromEntries(ISSUE_VIEWS.map(v => [v.view, kept.filter(g => inView(g, v.view)).length])) as Record<IssuesViewName, number>;
  const shown = kept.filter(g => inView(g, choice.view));
  return { counts, groups: groupIssues(shown, choice.display, names, today), shown: shown.length, inView: all.filter(g => inView(g, choice.view)).length };
}

/**
 * What to change so an issue opened from elsewhere (the right panel, ACH-D52) shows in the list:
 * the All view when the current one leaves it out, no filters or search when they hide it, and its
 * closed status group unfolded. Display options are the user's and stay; returns null when the issue
 * shows already.
 */
export function revealIssue(issue: SuperIssue, choice: { view: IssuesViewName; filters: IssueFilters; query: string; display: IssuesDisplay }, today: string): {
  view?: IssuesViewName; filters?: IssueFilters; query?: string; unfold?: string;
} | null {
  const out: { view?: IssuesViewName; filters?: IssueFilters; query?: string; unfold?: string } = {};
  if (!inView(issue, choice.view)) out.view = 'all';
  if (!matchesFilters(issue, choice.filters, today)) out.filters = {};
  if (!matchesQuery(issue, choice.query)) out.query = '';
  if (choice.display.groupBy === 'status' && !isOpenIssue(issue)) out.unfold = issue.status;
  return Object.keys(out).length ? out : null;
}
