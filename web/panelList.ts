// The shared list of the SuperAgent's right-panel tabs (ACH-D37): Decisions, Issues, Routines and
// Notes read the same way, one line per item, grouped under sentence-case headers. The rules are
// pure, so they are tested without a DOM; web/ui/PanelList.tsx draws them.
import type { IssueStatus, SuperAction, SuperAsk, SuperIssue, SuperRoutine } from '../shared/types.ts';

export interface Group<T> { key: string; label: string; items: T[] }

/** A time as a row shows it: "15:38" today, "12 Nov" before (the full date goes in the title). */
export function shortWhen(at: number, now: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return d.toTimeString().slice(0, 5);
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}

/** A day's header: Today, Yesterday, then "11 Nov". */
export function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}

/** Newest first, in one group per day. */
export function groupByDay<T>(items: readonly T[], at: (item: T) => number, now: number): Group<T>[] {
  const groups: Group<T>[] = [];
  for (const item of [...items].sort((a, b) => at(b) - at(a))) {
    const d = new Date(at(item));
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(at(item), now), items: [item] });
  }
  return groups;
}

/** Every word of the query, in any order and case, somewhere in the item's text (MonoCode's filter). */
export function matches(query: string, ...texts: (string | undefined | null)[]): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = texts.filter(Boolean).join(' ').toLowerCase();
  return words.every(w => text.includes(w));
}

/** A summary the server cut short ends in "..."; the row shows it without the dots. */
export function cleanSummary(summary: string): string {
  return summary.replace(/(\.\.\.|…)\s*$/, '').trimEnd();
}

/** Who wrote a note, when it is worth saying: never "You" (most are yours), never blank. */
export function authorLabel(by: string | undefined | null): string | null {
  const name = (by ?? '').trim();
  return !name || /^you$/i.test(name) ? null : name;
}

/** The key that opens a row's menu from the keyboard: the context-menu key, or ⇧F10. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

// ---- Decisions ---------------------------------------------------------------------------------

export type DecisionKind = 'delegate' | 'message' | 'issue' | 'agent' | 'channel' | 'other';
export function decisionKind(tool: string): DecisionKind {
  if (/^delegate/.test(tool)) return 'delegate';
  if (/message|nudge/.test(tool)) return 'message';
  if (/issue|goal/.test(tool)) return 'issue';
  if (/agent/.test(tool)) return 'agent';
  if (/channel/.test(tool)) return 'channel';
  return 'other';
}

export type DecisionsFilter = 'actions' | 'answers';

/** What the SuperAgent did (or what you answered), searched and grouped by day. */
export function decisionGroups(log: readonly SuperAction[] | undefined, asks: readonly SuperAsk[] | undefined, filter: DecisionsFilter, query: string, now: number) {
  const answered = (asks ?? []).filter(a => a.answeredAt !== undefined);
  return {
    counts: { actions: log?.length ?? 0, answers: answered.length },
    actions: filter === 'actions' ? groupByDay((log ?? []).filter(a => matches(query, a.summary, a.why)), a => a.at, now) : [],
    answers: filter === 'answers' ? groupByDay(answered.filter(a => matches(query, a.question, a.detail, a.answer)), a => a.answeredAt!, now) : [],
  };
}

// ---- Issues -------------------------------------------------------------------------------------

export type IssuesFilter = 'open' | 'done';
/** Open issues in sections, in the order the SuperAgent needs you first; done issues last. */
const OPEN_SECTIONS: { status: Exclude<IssueStatus, 'done'>; label: string }[] = [
  { status: 'blocked', label: 'Needs you' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'queued', label: 'Queued' },
];

export function issueGroups(issues: readonly SuperIssue[] | undefined, filter: IssuesFilter, query: string): { counts: { open: number; done: number }; open: Group<SuperIssue>[]; done: SuperIssue[] } {
  const all = issues ?? [];
  const found = all.filter(g => matches(query, g.text, g.notes));
  const open = found.filter(g => g.status !== 'done').sort((a, b) => a.order - b.order);
  const done = found.filter(g => g.status === 'done').sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt));
  return {
    counts: { open: all.filter(g => g.status !== 'done').length, done: all.filter(g => g.status === 'done').length },
    open: filter === 'open' ? OPEN_SECTIONS.map(s => ({ key: s.status, label: s.label, items: open.filter(g => g.status === s.status) })).filter(s => s.items.length) : [],
    done,
  };
}

// ---- Routines ----------------------------------------------------------------------------------

/** Proposals waiting for you first, then your routines; paused ones stay in place, dimmed. */
export function routineGroups(routines: readonly SuperRoutine[] | undefined, query: string): Group<SuperRoutine>[] {
  const found = (routines ?? []).filter(r => matches(query, r.name, r.instruction, r.why));
  return [
    { key: 'proposed', label: 'Waiting for you', items: found.filter(r => r.proposed) },
    { key: 'own', label: 'Routines', items: found.filter(r => !r.proposed) },
  ].filter(g => g.items.length);
}

/** A schedule in a row's meta: "Daily 09:00", "Every 6 h". */
export function shortSchedule(schedule: SuperRoutine['schedule']): string {
  return schedule.kind === 'daily' ? `Daily ${schedule.at}` : `Every ${schedule.hours} h`;
}

// ---- Notes -------------------------------------------------------------------------------------

/** A project's notes list: in-force decisions, then notes, then replaced ones (folded), newest first. */
export function notesSections<T extends { kind: 'D' | 'N'; state: string; num?: number }>(entries: readonly T[], filter: 'all' | 'D' | 'N') {
  const shown = (e: T) => filter === 'all' || e.kind === filter;
  return {
    counts: { all: entries.length, D: entries.filter(e => e.kind === 'D').length, N: entries.filter(e => e.kind === 'N').length },
    decisions: entries.filter(e => e.state === 'active' && shown(e)),
    notes: entries.filter(e => e.state === 'note' && shown(e)),
    replaced: entries.filter(e => e.state === 'replaced' && shown(e)),
  };
}
