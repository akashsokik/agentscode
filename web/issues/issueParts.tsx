import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ISSUE_PRIORITIES, ISSUE_PRIORITY_LABEL, ISSUE_STATUSES, ISSUE_STATUS_LABEL, isOpenIssue } from '../../shared/issues.ts';
import type { IssuePriority, IssueStatus, SuperIssue } from '../../shared/types.ts';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { CheckCircle, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleDashed, CircleDot, Copy, Eye, Gauge, Minus, Pause, Trash2 } from '../mono/icons.tsx';
import { WhoAvatar } from '../notes/parts.tsx';
import { attempt, useApp } from '../store.ts';
import { cx, MenuDivider, MenuLabel, MenuRow } from '../ui/common.tsx';
import { PanelRow } from '../ui/PanelList.tsx';
import { dueBucket, type RowProperty } from './issuesView.ts';

// The pieces an issue is drawn with, shared by the Issues page and (phase 4) the right panel's list.

/**
 * Status marks from the existing mono icons, until the glyphs from the gaps demo are approved
 * (ACH-D43 gap 1). Done is MonoCode's circled check in the success colour and Canceled its minus
 * (ACH-D45); both move to the shared StatusMark once it lands.
 */
export const ISSUE_ICON: Record<IssueStatus, { icon: typeof CircleDot; cls: string }> = {
  needs_you: { icon: CircleAlert, cls: 'text-warning' },
  in_review: { icon: Eye, cls: 'text-content/75' },
  in_progress: { icon: CircleDot, cls: 'text-content/75' },
  waiting: { icon: Pause, cls: '' },
  todo: { icon: CircleDashed, cls: '' },
  backlog: { icon: CircleDashed, cls: 'text-content/40' },
  done: { icon: CheckCircle, cls: 'text-success' },
  canceled: { icon: Minus, cls: 'text-content/40' },
};

export function StatusIcon({ status, className = 'size-3.5' }: { status: IssueStatus; className?: string }) {
  const { icon: Icon, cls } = ISSUE_ICON[status];
  return <Icon aria-hidden className={cx(className, 'shrink-0', cls)} strokeWidth={1.6} />;
}

/**
 * An issue's priority. In words until the priority glyphs are approved (ACH-D43 gap 2); "No
 * priority" shows nothing.
 */
export function PriorityMark({ priority }: { priority: IssuePriority }) {
  if (priority === 'none') return null;
  return <span className={cx('shrink-0 text-[11px]', priority === 'urgent' ? 'text-warning' : 'text-content/50')}>{ISSUE_PRIORITY_LABEL[priority]}</span>;
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Nov 20": amber on the day, red once past. */
export function DueDate({ dueDate, today }: { dueDate: string; today: string }) {
  const bucket = dueBucket(dueDate, today);
  const parsed = Date.parse(`${dueDate}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  return (
    <span title={`Due ${dueDate}`} className={cx('shrink-0 tabular-nums', bucket === 'overdue' ? 'text-danger' : bucket === 'today' ? 'text-warning' : '')}>
      {DAY_FORMAT.format(parsed)}
    </span>
  );
}

function Labels({ labels }: { labels: string[] }) {
  if (!labels.length) return null;
  const shown = labels.slice(0, 2);
  return (
    <span className="flex min-w-0 items-center gap-1" title={labels.join(', ')}>
      {shown.map(l => <span key={l} className="max-w-[7rem] truncate rounded-[5px] bg-content/7 px-1.5 leading-[18px] text-content/60">{l}</span>)}
      {labels.length > shown.length ? <span className="text-content/40">+{labels.length - shown.length}</span> : null}
    </span>
  );
}

/** Who an issue is with, in words: "You", the agent's name, or nobody. */
export function assigneeName(issue: SuperIssue, agentName: string | undefined): string | null {
  if (issue.forUser) return 'You';
  if (issue.agentId) return agentName ?? 'Removed agent';
  return null;
}

/**
 * One issue on one wide line: status, title, then (as the Display chooses) key, priority, labels,
 * project, due date, assignee and when it last changed. The narrower the page, the fewer of these
 * show (container `issues`); the full text is in the row's tooltip.
 */
export function IssueRow({ issue, properties, today, now, expanded, onOpen }: {
  issue: SuperIssue;
  properties: readonly RowProperty[];
  today: string;
  now: number;
  expanded: boolean;
  onOpen: () => void;
}) {
  const project = useApp(s => (issue.projectId ? s.snapshot?.projects.find(p => p.id === issue.projectId) : undefined));
  const agentName = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId)?.name : undefined));
  const show = (p: RowProperty) => properties.includes(p);
  const who = assigneeName(issue, agentName);
  const closed = !isOpenIssue(issue);
  const label = [
    `${issue.key} ${ISSUE_STATUS_LABEL[issue.status]}: ${issue.title}`,
    issue.priority !== 'none' ? `${ISSUE_PRIORITY_LABEL[issue.priority]} priority` : '',
    issue.labels.length ? `labels ${issue.labels.join(', ')}` : '',
    project ? project.name : '',
    issue.dueDate ? `due ${issue.dueDate}` : '',
    who ? `with ${who}` : '',
  ].filter(Boolean).join(', ');
  return (
    <PanelRow
      id={issue.id}
      lead={<StatusIcon status={issue.status} />}
      label={label}
      dim={closed}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          {show('key') ? <span className="w-14 shrink-0 font-mono text-[11px] text-content/45">{issue.key}</span> : null}
          <span className="truncate">{issue.title}</span>
        </span>
      )}
      meta={(
        <>
          {show('priority') ? <PriorityMark priority={issue.priority} /> : null}
          {show('labels') ? <span className="hidden @min-[40rem]/issues:flex"><Labels labels={issue.labels} /></span> : null}
          {show('project') && project ? <span className="hidden font-mono text-[10.5px] @min-[34rem]/issues:inline">{project.code ?? project.name}</span> : null}
          {show('due') && issue.dueDate ? <DueDate dueDate={issue.dueDate} today={today} /> : null}
          {show('assignee') && who ? <span title={who} className="inline-flex"><WhoAvatar name={who} agentId={issue.forUser ? undefined : issue.agentId} className="size-3.5" /></span> : null}
          {show('updated') ? <span className="hidden min-w-8 whitespace-nowrap text-right @min-[30rem]/issues:inline">{relativeTime(issue.updatedAt, now)}</span> : null}
        </>
      )}
      expanded={expanded}
      onOpen={onOpen}
      menuLabel={`Issue ${issue.key}`}
      menu={close => <IssueMenu issue={issue} close={close} onOpen={onOpen} />}
    >
      {issue.text.trim() !== issue.title.trim() ? <p className="mb-1 whitespace-pre-wrap break-words">{issue.text}</p> : null}
      <p className="text-[11px] text-content/45">
        {issue.key} · added by {issue.by === 'user' ? 'you' : 'the SuperAgent'} {relativeTime(issue.createdAt, now)} ago{who ? ` · with ${issue.forUser ? 'you' : who}` : ''}
      </p>
    </PanelRow>
  );
}

/**
 * The page of a menu shown. Whenever the page changes (and when it first shows), focus goes to its
 * search field if it has one, so typing filters at once, or else to its first row.
 */
export function MenuPage({ page, children }: { page: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A tick later: a popover's first render cannot take focus yet (ContextMenu waits a frame too).
    const timer = setTimeout(() => {
      const el = box.current;
      (el?.querySelector<HTMLElement>('input') ?? el?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled), [role="option"]:not(:disabled)'))?.focus({ preventScroll: true });
    });
    return () => clearTimeout(timer);
  }, [page]);
  return <div ref={box}>{children}</div>;
}

type IssueMenuPage = 'main' | 'status' | 'priority' | 'remove';

/**
 * An issue's right-click menu (ACH-D27): Open, Status and Priority (each opening its list in place,
 * with a way back), Copy key, Cancel and Remove (confirmed in place).
 */
export function IssueMenu({ issue, close, onOpen }: { issue: SuperIssue; close: () => void; onOpen?: () => void }) {
  const [page, setPage] = useState<IssueMenuPage>('main');
  const update = (patch: { status?: IssueStatus; priority?: IssuePriority }) => { close(); void attempt(() => api.updateIssue(issue.id, patch)); };
  const back = <MenuRow icon={ChevronLeft} title={page === 'remove' ? 'Back' : page === 'status' ? 'Status' : 'Priority'} onSelect={() => setPage('main')} />;
  return (
    <MenuPage page={page}>
      {page === 'main' ? (
        <>
          {onOpen ? <MenuRow icon={ChevronDown} title="Open" shortcut="Enter" onSelect={() => { close(); onOpen(); }} /> : null}
          <MenuRow icon={ISSUE_ICON[issue.status].icon} title={<span className="flex items-center justify-between gap-2">Status<span className="flex items-center gap-1 text-[11px] font-normal text-content/45">{ISSUE_STATUS_LABEL[issue.status]}<ChevronRight aria-hidden className="size-3" strokeWidth={1.75} /></span></span>} onSelect={() => setPage('status')} />
          <MenuRow icon={Gauge} title={<span className="flex items-center justify-between gap-2">Priority<span className="flex items-center gap-1 text-[11px] font-normal text-content/45">{ISSUE_PRIORITY_LABEL[issue.priority]}<ChevronRight aria-hidden className="size-3" strokeWidth={1.75} /></span></span>} onSelect={() => setPage('priority')} />
          <MenuDivider />
          <MenuRow icon={Copy} title={`Copy ${issue.key}`} onSelect={() => { close(); void navigator.clipboard?.writeText(issue.key); }} />
          {isOpenIssue(issue) ? <MenuRow icon={Minus} title="Cancel issue" onSelect={() => update({ status: 'canceled' })} /> : null}
          <MenuRow icon={Trash2} title="Remove…" danger onSelect={() => setPage('remove')} />
        </>
      ) : page === 'status' ? (
        <>
          {back}
          <MenuDivider />
          {ISSUE_STATUSES.map(s => (
            <MenuRow key={s} icon={ISSUE_ICON[s].icon} title={ISSUE_STATUS_LABEL[s]} checked={issue.status === s} onSelect={() => update({ status: s })} />
          ))}
        </>
      ) : page === 'priority' ? (
        <>
          {back}
          <MenuDivider />
          {ISSUE_PRIORITIES.map(p => (
            <MenuRow key={p} title={ISSUE_PRIORITY_LABEL[p]} checked={issue.priority === p} onSelect={() => update({ priority: p })} />
          ))}
        </>
      ) : (
        <>
          <MenuLabel>Remove {issue.key}?</MenuLabel>
          <MenuRow icon={Trash2} title="Remove" hint="You can undo it from the SuperAgent's Decisions." danger onSelect={() => { close(); void attempt(() => api.removeIssue(issue.id)); }} />
          {back}
        </>
      )}
    </MenuPage>
  );
}
