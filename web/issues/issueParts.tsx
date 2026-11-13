import { forwardRef, useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { ISSUE_PRIORITIES, ISSUE_PRIORITY_LABEL, ISSUE_STATUSES, ISSUE_STATUS_LABEL, isOpenIssue } from '../../shared/issues.ts';
import type { IssuePriority, IssueStatus, SuperIssue } from '../../shared/types.ts';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { AlertSquare, CheckCircle, ChevronLeft, ChevronRight, Circle, CircleAlert, CircleDashed, CircleHalf, CircleThreeQuarter, Copy, Maximize2, Minus, NoSignal, Pause, SignalHigh, SignalLow, SignalMedium, Trash2 } from '../mono/icons.tsx';
import { LAYER } from '../mono/layers.ts';
import { StatusMark } from '../ui/StatusMark.tsx';
import { STATUS_MARKS, type StatusState } from '../ui/statusMarks.ts';
import { Popover } from '../mono/Popover.tsx';
import { menuKeyTarget } from '../ui/menuFocus.ts';
import { WhoAvatar } from '../notes/parts.tsx';
import { attempt, useApp } from '../store.ts';
import { cx, MenuDivider, MenuLabel, MenuRow, MenuRowRole } from '../ui/common.tsx';
import { PanelRow } from '../ui/PanelList.tsx';
import { dueBucket, type RowProperty } from './issuesView.ts';
import { openIssue } from './openIssue.ts';

// The pieces an issue is drawn with, shared by the Issues page and (phase 4) the right panel's list.

/**
 * Status glyphs (ACH-D46): the part-filled rings for In progress and In review, MonoCode's circled
 * check for Done and minus for Canceled, through the shared StatusMark (ACH-D45).
 * Theme colours only (ACH-D14): Needs you warning, In progress accent, In review info, Done success.
 */
// `tint` is the same colour as `cls`, important, for menu rows (which grey their icons); written out
// in full because Tailwind only builds the classes it finds in the source.
export const ISSUE_ICON: Record<IssueStatus, { icon: typeof Circle; cls: string; tint: string }> = {
  needs_you: { icon: CircleAlert, cls: 'text-warning', tint: 'text-warning!' },
  in_review: { icon: CircleThreeQuarter, cls: 'text-info', tint: 'text-info!' },
  in_progress: { icon: CircleHalf, cls: 'text-accent', tint: 'text-accent!' },
  waiting: { icon: Pause, cls: 'text-content/55', tint: 'text-content/55!' },
  todo: { icon: Circle, cls: 'text-content/55', tint: 'text-content/55!' },
  backlog: { icon: CircleDashed, cls: 'text-content/40', tint: 'text-content/40!' },
  // The shared StatusMark's pass and cancel marks (web/ui/statusMarks.ts): same glyph, same colour.
  done: { icon: CheckCircle, cls: STATUS_MARKS.pass.tone, tint: 'text-success!' },
  canceled: { icon: Minus, cls: STATUS_MARKS.cancel.tone, tint: 'text-content/45!' },
};

/** Done and Canceled are drawn by the shared StatusMark itself (ACH-D45). */
const MARK_STATE: Partial<Record<IssueStatus, StatusState>> = { done: 'pass', canceled: 'cancel' };

export function StatusIcon({ status, className = 'size-3.5' }: { status: IssueStatus; className?: string }) {
  const mark = MARK_STATE[status];
  if (mark) return <StatusMark state={mark} className={className} />;
  const { icon: Icon, cls } = ISSUE_ICON[status];
  return <Icon aria-hidden className={cx(className, 'shrink-0', cls)} strokeWidth={1.75} />;
}

/** Priority glyphs (ACH-D46, option A): hugeicons' signal bars with the unlit ones dimmed. */
export const PRIORITY_ICON: Record<IssuePriority, { icon: typeof Circle; cls: string; tint: string }> = {
  urgent: { icon: AlertSquare, cls: 'text-danger', tint: 'text-danger!' },
  high: { icon: SignalHigh, cls: 'text-content/70', tint: 'text-content/70!' },
  normal: { icon: SignalMedium, cls: 'text-content/70', tint: 'text-content/70!' },
  low: { icon: SignalLow, cls: 'text-content/70', tint: 'text-content/70!' },
  none: { icon: NoSignal, cls: 'text-content/30', tint: 'text-content/30!' },
};

export function PriorityIcon({ priority, className = 'size-3.5' }: { priority: IssuePriority; className?: string }) {
  const { icon: Icon, cls } = PRIORITY_ICON[priority];
  return <Icon aria-hidden className={cx(className, 'shrink-0', cls)} strokeWidth={1.75} />;
}

/** A row's priority: its glyph, named on hover. */
export function PriorityMark({ priority }: { priority: IssuePriority }) {
  return <span title={ISSUE_PRIORITY_LABEL[priority]} className="inline-flex"><PriorityIcon priority={priority} /></span>;
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
 * show (container `issues`); the full text is in the row's tooltip. A click, Enter or Open opens
 * the issue view in a tab (openIssue): the row never unfolds to show details.
 */
export function IssueRow({ issue, properties, today, now, selected = false, onOpen = () => openIssue(issue.id) }: {
  issue: SuperIssue;
  properties: readonly RowProperty[];
  today: string;
  now: number;
  /** The issue the page has selected (ACH-D52). */
  selected?: boolean;
  /** Defaults to opening the issue view. */
  onOpen?: () => void;
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
      selected={selected}
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
      onOpen={onOpen}
      menuLabel={`Issue ${issue.key}`}
      menu={close => <IssueMenu issue={issue} close={close} onOpen={onOpen} />}
    />
  );
}

/**
 * The page of a menu shown. Whenever the page changes (and when it first shows), focus goes to its
 * search field if it has one, so typing filters at once, or else to its first row.
 */
export function MenuPage({ page, focus = true, children }: { page: string; /** Off: leave focus where it is (a submenu opened by hover). */ focus?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    // A tick later: a popover's first render cannot take focus yet (ContextMenu waits a frame too).
    const timer = setTimeout(() => {
      const el = box.current;
      const rows = '[role="menuitem"]:not(:disabled), [role="option"]:not(:disabled)';
      // A search field first; else the row holding the current value (so Enter keeps it, as in
      // Linear); else the first row.
      (el?.querySelector<HTMLElement>('input')
        ?? el?.querySelector<HTMLElement>(`:is(${rows}):is([aria-current="true"], [aria-selected="true"])`)
        ?? el?.querySelector<HTMLElement>(rows))?.focus({ preventScroll: true });
    });
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  return <div ref={box}>{children}</div>;
}

/**
 * Arrow keys, Home and End move between a menu's rows; from a search field, Down goes to the first
 * value. Kept inside: the menu a flyout hangs off never sees them.
 */
export function moveMenuFocus(e: KeyboardEvent<HTMLElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled), [role="menuitem"]:not(:disabled)')];
  const fromField = (e.target as HTMLElement).tagName === 'INPUT';
  if (fromField && e.key !== 'ArrowDown') return;
  // Up from the first value goes back to the search field above it, rather than wrapping to the last.
  const field = e.currentTarget.querySelector<HTMLInputElement>('input');
  if (field && e.key === 'ArrowUp' && rows.indexOf(document.activeElement as HTMLElement) === 0) {
    e.preventDefault();
    e.stopPropagation();
    field.focus();
    return;
  }
  const target = fromField ? (rows.length ? 0 : null) : menuKeyTarget(rows.length, rows.indexOf(document.activeElement as HTMLElement), e.key);
  if (target === null) return;
  e.preventDefault();
  e.stopPropagation();
  rows[target].focus();
}

/**
 * A submenu (ACH-D46, option B): a popover at the submenu layer beside the row that opened it. Left
 * arrow closes it and returns to that row; Escape and a click outside close the whole menu.
 */
export function Submenu({ anchor, label, onClose, focus = true, width = 216, role = 'menu', children }: {
  anchor: HTMLElement;
  /** Opened by click or key: its first row (or search field) takes focus. By hover: focus stays. */
  focus?: boolean;
  label: string;
  onClose: () => void;
  width?: number;
  role?: 'menu' | 'dialog';
  children: ReactNode;
}) {
  const back = () => { onClose(); anchor.querySelector<HTMLElement>('button')?.focus(); };
  return (
    <Popover
      anchor={anchor}
      side="right"
      align="start"
      gap={6}
      width={width}
      layer={LAYER.submenu}
      constrainHeight={false}
      onDismiss={reason => { if (reason === 'outside') onClose(); }}
      // Escape is the menu's: it reaches the menu this hangs off through React (after a search field
      // here has had its turn), and that menu closes, taking this with it.
      dismissOnEscape={false}
      // Clicks on the menu it hangs off are that menu's own (they open another submenu or run a row).
      ignore="[role='menu'], [role='dialog']"
      data-submenu
      role={role}
      aria-label={label}
      onKeyDown={e => {
        if (e.key === 'ArrowLeft' && (e.target as HTMLElement).tagName !== 'INPUT') { e.preventDefault(); e.stopPropagation(); back(); return; }
        moveMenuFocus(e);
      }}
      className="p-1.5 font-sans"
    >
      <MenuRowRole.Provider value="menuitem"><MenuPage page="open" focus={focus}>{children}</MenuPage></MenuRowRole.Provider>
    </Popover>
  );
}

/** A menu row that opens a submenu: on click, Enter, the right arrow or hover. Its value shows quietly at the end. */
export function SubmenuRow({ icon, title, value, open, onOpen }: { icon?: typeof Circle; title: string; value?: string; open: boolean; onOpen: (row: HTMLElement, focus: boolean) => void }) {
  const row = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={row}
      onMouseEnter={e => onOpen(e.currentTarget, false)}
      onKeyDown={e => { if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onOpen(e.currentTarget, true); } }}
      aria-haspopup="menu"
      aria-expanded={open}
    >
      <MenuRow
        icon={icon}
        highlighted={open}
        title={<span className="flex items-center justify-between gap-2">{title}<span className="flex items-center gap-1 text-[11px] font-normal text-content/45">{value}<ChevronRight aria-hidden className="size-3" strokeWidth={1.75} /></span></span>}
        onSelect={() => { if (row.current) onOpen(row.current, true); }}
      />
    </div>
  );
}

/**
 * An issue's right-click menu (ACH-D27): Open, Status and Priority (each a submenu beside it, the
 * value in force shown by its fill, ACH-D46), Copy key, Cancel and Remove (confirmed in place).
 */
export function IssueMenu({ issue, close, onOpen }: { issue: SuperIssue; close: () => void; onOpen?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) return <RemoveConfirm issue={issue} close={close} onBack={() => setConfirming(false)} />;
  return (
    <MenuPage page="main">
      {onOpen ? <MenuRow icon={Maximize2} title="Open" shortcut="Enter" onSelect={() => { close(); onOpen(); }} /> : null}
      <StatusPriorityRows issue={issue} close={close} />
      <MenuDivider />
      <MenuRow icon={Copy} title={`Copy ${issue.key}`} onSelect={() => { close(); void navigator.clipboard?.writeText(issue.key); }} />
      {isOpenIssue(issue) ? <MenuRow icon={Minus} title="Cancel issue" onSelect={() => { close(); void attempt(() => api.updateIssue(issue.id, { status: 'canceled' })); }} /> : null}
      <MenuRow icon={Trash2} title="Remove…" danger onSelect={() => setConfirming(true)} />
    </MenuPage>
  );
}

/** Remove, confirmed in place inside the menu. */
export function RemoveConfirm({ issue, close, onBack, onRemoved }: { issue: SuperIssue; close: () => void; onBack: () => void; onRemoved?: () => void }) {
  return (
    <MenuPage page="remove">
      <MenuLabel>Remove {issue.key}?</MenuLabel>
      <MenuRow icon={Trash2} title="Remove" hint="You can undo it from the SuperAgent's Decisions." danger onSelect={() => { close(); void attempt(() => api.removeIssue(issue.id)).then(ok => { if (ok) onRemoved?.(); }); }} />
      <MenuRow icon={ChevronLeft} title="Back" onSelect={onBack} />
    </MenuPage>
  );
}

/**
 * An issue's Status and Priority rows, each opening its submenu (ACH-D46, option B), for any issue
 * menu: the Issues page's and the right panel's. Pointing at another row of the menu closes the
 * open submenu. `onChanged` runs after a change is saved (the panel puts focus back on the row).
 */
export function StatusPriorityRows({ issue, close, onChanged }: { issue: SuperIssue; close: () => void; onChanged?: () => void }) {
  const [sub, setSub] = useState<{ which: 'status' | 'priority'; anchor: HTMLElement; focus: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = box.current?.closest('[role="menu"]');
    if (!menu || !sub) return;
    const over = (e: Event) => { if (!box.current?.contains(e.target as Node)) setSub(null); };
    menu.addEventListener('pointerover', over);
    return () => menu.removeEventListener('pointerover', over);
  }, [sub]);
  const update = (patch: { status?: IssueStatus; priority?: IssuePriority }) => {
    close();
    void attempt(() => api.updateIssue(issue.id, patch)).then(() => onChanged?.());
  };
  const openSub = (which: 'status' | 'priority') => (anchor: HTMLElement, focus: boolean) => setSub(s => (s?.which === which && !focus ? s : { which, anchor, focus }));
  return (
    <div ref={box}>
      <SubmenuRow icon={tinted(ISSUE_ICON[issue.status].icon, ISSUE_ICON[issue.status].tint)} title="Status" value={ISSUE_STATUS_LABEL[issue.status]} open={sub?.which === 'status'} onOpen={openSub('status')} />
      <SubmenuRow icon={tinted(PRIORITY_ICON[issue.priority].icon, PRIORITY_ICON[issue.priority].tint)} title="Priority" value={ISSUE_PRIORITY_LABEL[issue.priority]} open={sub?.which === 'priority'} onOpen={openSub('priority')} />
      {sub?.which === 'status' ? (
        <Submenu key={`status-${sub.focus}`} anchor={sub.anchor} focus={sub.focus} label={`Status of ${issue.key}`} onClose={() => setSub(null)}>
          {ISSUE_STATUSES.map(st => {
            const { icon, tint } = ISSUE_ICON[st];
            return <MenuRow key={st} icon={tinted(icon, tint)} title={ISSUE_STATUS_LABEL[st]} current={issue.status === st} onSelect={() => update({ status: st })} />;
          })}
        </Submenu>
      ) : null}
      {sub?.which === 'priority' ? (
        <Submenu key={`priority-${sub.focus}`} anchor={sub.anchor} focus={sub.focus} label={`Priority of ${issue.key}`} onClose={() => setSub(null)}>
          {ISSUE_PRIORITIES.map(p => {
            const { icon, tint } = PRIORITY_ICON[p];
            return <MenuRow key={p} icon={tinted(icon, tint)} title={ISSUE_PRIORITY_LABEL[p]} current={issue.priority === p} onSelect={() => update({ priority: p })} />;
          })}
        </Submenu>
      ) : null}
    </div>
  );
}

const TINTED = new Map<string, typeof Circle>();
/** An icon in its own colour inside a menu row, which greys its icons: `cls` is a map's important `tint`. */
export function tinted(icon: typeof Circle, cls: string): typeof Circle {
  const key = `${icon.displayName}|${cls}`;
  let made = TINTED.get(key);
  if (!made) {
    const Icon = icon;
    made = forwardRef<SVGSVGElement, ComponentProps<typeof Circle>>(function Tinted({ className, ...props }, ref) {
      return <Icon ref={ref} {...props} className={cx(className, cls)} />;
    }) as typeof Circle;
    made.displayName = `${icon.displayName}Tinted`;
    TINTED.set(key, made);
  }
  return made;
}

/**
 * Focus back where it was when a popover opened: a closed popover takes its focused row with it and
 * leaves focus on the page body, where F, J and K no longer reach the list. Runs a tick later, once
 * the popover has gone, and leaves focus alone if something else took it on purpose.
 */
export function restoreFocus(opener: Element | null, fallback: HTMLElement | null) {
  setTimeout(() => {
    const now = document.activeElement;
    if (now && now !== document.body) return;
    const target = opener instanceof HTMLElement && opener.isConnected && opener !== document.body ? opener : fallback;
    target?.focus({ preventScroll: true });
  });
}
