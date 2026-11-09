/**
 * The SuperAgent's own parts of its pane: the questions it waits on you for, as cards with the
 * choices to click, and its decision log on the right of the pane, where anything it did on its own
 * can be undone.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GoalStatus, SuperAsk, SuperGoal } from '../../shared/types.ts';
import { api } from '../api.ts';
import { memoryDate } from '../memory.ts';
import { openAsks } from '../super.ts';
import { decisionRows, GOAL_STATUS_LABEL, goalSections, heldText, superLogMax, superLogWidth, type DecisionRow } from '../superText.ts';
import { open } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { cx, HeaderButton, IconTab, PRIMARY, TEXTAREA, TextButton } from '../ui/common.tsx';
import { ResizeHandle, useColumnWidth } from '../ui/ResizeHandle.tsx';
import { ChevronDown, ChevronUp, CircleDot, ListBullet, PanelRight, Pencil, Trash2 } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';

/** Open questions above the composer; empty, it takes no room. */
export function SuperInbox() {
  const asks = useApp(s => s.snapshot?.super.asks);
  const held = useApp(s => s.snapshot?.super.held);
  const waiting = openAsks(asks);
  if (!waiting.length && !held) return null;
  return (
    <div data-super-inbox className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 pb-2">
      {/* Mail it may not take a turn for yet: never silent, so work you asked for never stalls unseen. */}
      {held ? (
        <p role="status" data-super-held className="rounded-lg border border-content/10 bg-content/3 px-3 py-2 font-sans text-[12px] text-content/65">
          {heldText(held)}
        </p>
      ) : null}
      {waiting.map(ask => <AskCard key={ask.id} ask={ask} />)}
    </div>
  );
}

function AskCard({ ask }: { ask: SuperAsk }) {
  const [busy, setBusy] = useState(false);
  const send = async (body: { answer: string } | { dismiss: true }) => {
    setBusy(true);
    await attempt(() => api.answerSuper(ask.id, body));
    setBusy(false);
  };
  return (
    <div data-super-ask={ask.id} className="rounded-lg border border-content/10 bg-content/3 px-3 py-2.5 font-sans">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-content">{ask.question}</p>
        <TextButton disabled={busy} onClick={() => void send({ dismiss: true })} className="shrink-0 text-[12px]">Not now</TextButton>
      </div>
      {ask.detail ? <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-content/55">{ask.detail}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {ask.options.map((option, i) => (
          i === 0
            ? <button key={option} type="button" className={PRIMARY} disabled={busy} onClick={() => void send({ answer: option })}>{option}</button>
            : <SecondaryButton key={option} disabled={busy} onClick={() => void send({ answer: option })}>{option}</SecondaryButton>
        ))}
      </div>
    </div>
  );
}

const time = (ts: number) => `${memoryDate(ts)} ${new Date(ts).toTimeString().slice(0, 5)}`;

/**
 * The SuperAgent's decision log, on the right of its pane: what it did on its own, newest first,
 * each with why and Undo, then what you answered it. Kept live by `super` events. `over` floats it
 * above the conversation in a narrow pane; otherwise it sits beside it, resizable from its left edge.
 */
export function SuperLogSidebar({ id, over, focused, onClose }: { id: string; over: boolean; focused: boolean; onClose: () => void }) {
  const log = useApp(s => s.snapshot?.super.log);
  const asks = useApp(s => s.snapshot?.super.asks);
  const goals = useApp(s => s.snapshot?.super.goals);
  const rows = decisionRows(log);
  const answered = (asks ?? []).filter(a => a.answeredAt !== undefined);
  const column = useColumnWidth('superLog', 300, 240, 0.4);
  const root = useRef<HTMLElement>(null);
  // The pane's width, measured here (before the first paint) so resizing re-renders only the sidebar.
  const paneWidth = useParentWidth(root);
  const mode = over ? 'over' : 'beside';
  // The width you chose, cut to the pane it is in: the window-based cap alone lets it fill a split pane.
  const width = superLogWidth(column.width, column.min, paneWidth, mode);
  // Dragging and the arrow keys stop at the pane-based limit too, and the handle reports it.
  const max = paneWidth > 0 ? Math.min(column.max, superLogMax(column.min, paneWidth, mode)) : column.max;
  const fit = (value: number) => Math.min(max, value);
  const handle = { ...column, width, max, preview: (value: number | null) => column.preview(value === null ? null : fit(value)), commit: (value: number | undefined) => column.commit(value === undefined ? undefined : fit(value)) };
  const close = useRef(onClose);
  close.current = onClose;

  // Over the conversation it is a popover: focus moves into it when it opens.
  useEffect(() => {
    if (over) root.current?.querySelector<HTMLElement>('[data-super-log-hide]')?.focus({ preventScroll: true });
  }, [over]);
  // However it closes, in either mode (Hide, Escape, a click outside), focus that fell to the page
  // goes back to the header's toggle.
  useEffect(() => {
    const panel = root.current;
    return () => {
      if (panel?.isConnected) return;
      const toggle = document.querySelector<HTMLElement>('[data-super-log-toggle]');
      if (toggle && (document.activeElement === document.body || !document.activeElement)) toggle.focus({ preventScroll: true });
    };
  }, []);

  // Escape or a click outside closes it. Escape is heard as it bubbles (as ChannelThread's), only
  // while this pane has focus, never when something inside it already handled Escape (an edit box
  // cancelling), and never while a dialog or popover is open: that one takes Escape.
  useEffect(() => {
    if (!over || !focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-dialog-popover]')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && root.current?.contains(target) && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      close.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // The header's toggle does its own closing; closing here too would reopen it on its click.
      if (!target || root.current?.contains(target) || target.closest('[data-super-log-toggle]')) return;
      close.current();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [over, focused]);
  const undoable = rows.filter(r => r.undoable).length;
  const [view, setView] = useState<SideView>(readView);
  const pickView = (next: SideView) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* private mode */ }
  };
  const openGoals = goalSections(goals).open.length;
  return (
    <aside
      id={id}
      aria-label="SuperAgent sidebar"
      data-super-log
      ref={root}
      style={{ width }}
      // One position utility only: with both, .relative (later in the CSS) wins and it never floats.
      className={cx('flex shrink-0 flex-col border-l border-stroke font-sans', over ? 'body-glass absolute inset-y-0 right-0 z-20 shadow-2xl' : 'relative')}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke pl-2 pr-1.5">
        <div role="tablist" aria-label="SuperAgent sidebar" className="flex min-w-0 flex-1 items-center gap-0.5">
          <IconTab role="tab" aria-selected={view === 'decisions'} icon={ListBullet} label="Decisions" selected={view === 'decisions'} onClick={() => pickView('decisions')} />
          <IconTab role="tab" aria-selected={view === 'goals'} icon={CircleDot} label="Goals" count={openGoals || undefined} selected={view === 'goals'} onClick={() => pickView('goals')} />
        </div>
        <HeaderButton data-super-log-hide icon={PanelRight} label="Hide the sidebar" active onClick={onClose} />
      </div>
      {view === 'goals' ? <GoalsView /> : (
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {rows.length ? (
          <>
            <p className="px-3.5 pb-1 pt-2.5 text-[11px] leading-relaxed text-content/40">
              What it did on its own.{undoable ? ' Undo puts it back, and the SuperAgent hears that you did.' : ''}
            </p>
            <ol>{rows.map(row => <DecisionItem key={row.id} row={row} />)}</ol>
          </>
        ) : (
          <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
            <ListBullet className="size-5 text-content/25" strokeWidth={1.5} />
            <p className="mt-2.5 text-[13px] text-content/60">No decisions yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-content/40">When the SuperAgent creates agents or channels, delegates or nudges, it shows here with why, and you can undo it.</p>
          </div>
        )}
        {answered.length ? (
          <section aria-label="Your answers" className="mt-2 border-t border-stroke">
            <h3 className="px-3.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-content/40">Your answers</h3>
            <ol>
              {answered.map(ask => (
                <li key={ask.id} className="px-3.5 py-2">
                  <p className="text-[12px] leading-5 text-content/75">{ask.question}</p>
                  <p className="text-[12px] leading-5 text-content/45">{ask.dismissed ? 'Put aside' : ask.answer}</p>
                  <p className="text-[11px] text-content/30">{time(ask.answeredAt!)}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
      )}
      {/* From the width on screen, so a drag never jumps from a wider saved width. */}
      <ResizeHandle column={handle} edge="left" label="Resize the sidebar" />
    </aside>
  );
}

type SideView = 'decisions' | 'goals';
const VIEW_KEY = 'agentscode:super-sidebar-view';
function readView(): SideView {
  try { return localStorage.getItem(VIEW_KEY) === 'goals' ? 'goals' : 'decisions'; } catch { return 'decisions'; }
}

/**
 * The goals backlog: what you want done, in order. The SuperAgent works it top down, giving each
 * goal to a free agent; you add, edit, reorder and remove goals here, and see who is on each.
 */
function GoalsView() {
  const goals = useApp(s => s.snapshot?.super.goals);
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  const { open, done } = goalSections(goals);
  const list = useRef<HTMLOListElement>(null);
  const addBox = useRef<HTMLTextAreaElement>(null);
  // After a goal is removed, focus moves to the row now in its place, or the add box when none is.
  const focusAfterRemove = (index: number) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-goal]');
    const next = rows?.[Math.min(index, rows.length - 1)]?.querySelector<HTMLElement>('select, button');
    (next ?? addBox.current)?.focus({ preventScroll: true });
  }));
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await attempt(() => api.addGoal({ text: text.trim(), projectId: projectId || null }));
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-stroke px-3 py-2.5">
        <textarea
          ref={addBox}
          aria-label="New goal"
          value={text}
          rows={2}
          maxLength={500}
          // A goal is one line: Enter adds it, and pasted line breaks become spaces.
          onChange={e => setText(oneLine(e.target.value))}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void add(); } }}
          placeholder="Add a goal for the SuperAgent"
          className={`${TEXTAREA} text-[13px]`}
        />
        <div className="mt-1.5 flex items-center gap-2">
          <select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)} className="h-6 min-w-0 flex-1 truncate rounded-md border border-content/12 bg-transparent px-1.5 text-[12px] text-content/70 outline-none">
            <option value="">Any project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" className={PRIMARY} disabled={busy || !text.trim()} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {open.length ? (
          <ol ref={list} aria-label="Open goals">
            {open.map((goal, i) => <GoalItem key={goal.id} goal={goal} index={i} last={i === open.length - 1} onRemoved={() => focusAfterRemove(i)} />)}
          </ol>
        ) : (
          <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
            <CircleDot className="size-5 text-content/25" strokeWidth={1.5} />
            <p className="mt-2.5 text-[13px] text-content/60">No goals yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-content/40">Add what you want done. The SuperAgent works through them top down, giving each to a free agent, and asks you when it needs to.</p>
          </div>
        )}
        {done.length ? (
          <section aria-label="Done goals" className="border-t border-stroke">
            <button type="button" onClick={() => setShowDone(v => !v)} className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-content/40 hover:text-content/70">
              <ChevronDown className={cx('size-3 transition-transform', showDone ? '' : '-rotate-90')} strokeWidth={2} />
              Done <span className="font-normal tabular-nums">{done.length}</span>
            </button>
            {showDone ? <ol>{done.map((goal, i) => <GoalItem key={goal.id} goal={goal} index={i} last />)}</ol> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function GoalItem({ goal, index, last, onRemoved }: { goal: SuperGoal; index: number; last: boolean; onRemoved?: () => void }) {
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === goal.projectId));
  const agent = useApp(s => (goal.agentId ? s.snapshot?.agents.find(a => a.id === goal.agentId) : undefined));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(goal.text);
  const [busy, setBusy] = useState(false);
  // Remove asks once: the first press arms it for a few seconds, the second removes. If it runs out
  // while the confirm has focus, focus goes back to the Remove button rather than to the page.
  const [confirming, setConfirming] = useState(false);
  const trash = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!confirming) {
      // After React has put the Remove button back: focus it if the confirm had focus when it ran out.
      if (refocus.current) trash.current?.focus({ preventScroll: true });
      refocus.current = false;
      return;
    }
    const timer = setTimeout(() => {
      refocus.current = document.activeElement instanceof Element && Boolean(document.activeElement.closest('[data-goal-confirm]'));
      setConfirming(false);
    }, 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  // After Save or Cancel, focus goes back to the Edit button, not to the page.
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  // Every control names its goal, so a screen reader can tell the rows apart.
  const named = `"${goal.text.length > 60 ? `${goal.text.slice(0, 59)}…` : goal.text}"`;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    const ok = await attempt(action);
    setBusy(false);
    return ok;
  };
  const save = async () => {
    if (!text.trim()) return;
    if (await run(() => api.updateGoal(goal.id, { text: text.trim() }))) setEditing(false);
  };
  const done = goal.status === 'done';
  return (
    <li data-goal={goal.id} data-goal-status={goal.status} className="group/goal border-b border-content/5 px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-center gap-1">
        <select
          aria-label={`Status of ${named}`}
          value={goal.status}
          disabled={busy}
          onChange={e => void run(() => api.updateGoal(goal.id, { status: e.target.value as GoalStatus }))}
          className={cx('h-5 shrink-0 rounded bg-transparent text-[11px] outline-none hover:bg-selection-hover', goal.status === 'blocked' ? 'text-warning' : goal.status === 'in_progress' ? 'text-content/80' : 'text-content/45')}
        >
          {(Object.keys(GOAL_STATUS_LABEL) as GoalStatus[]).map(s => <option key={s} value={s}>{GOAL_STATUS_LABEL[s]}</option>)}
        </select>
        {project ? <span className="min-w-0 truncate text-[11px] text-content/35">· {project.name}</span> : null}
        <span className="flex-1" />
        <span className={cx('flex shrink-0 items-center transition-opacity group-hover/goal:opacity-100 focus-within:opacity-100', confirming ? 'opacity-100' : 'opacity-0')}>
          {!done ? (
            <>
              <IconButton icon={ChevronUp} label={`Move ${named} up`} disabled={busy || index === 0} onClick={() => void run(() => api.moveGoal(goal.id, index - 1))} />
              <IconButton icon={ChevronDown} label={`Move ${named} down`} disabled={busy || last} onClick={() => void run(() => api.moveGoal(goal.id, index + 1))} />
            </>
          ) : null}
          <IconButton ref={editButton} icon={Pencil} label={`Edit ${named}`} disabled={busy} onClick={() => { setText(goal.text); setEditing(true); }} />
          {confirming ? (
            <button
              type="button"
              // The confirm takes focus, so a keyboard press of Remove can be confirmed with Enter.
              autoFocus
              data-goal-confirm
              aria-label={`Confirm removing ${named}`}
              disabled={busy}
              onClick={async () => { if (await run(() => api.removeGoal(goal.id))) onRemoved?.(); }} className="h-5 rounded px-1.5 text-[11px] font-medium text-danger transition-colors hover:bg-selection-hover disabled:opacity-30">
              Remove?
            </button>
          ) : <IconButton ref={trash} icon={Trash2} label={`Remove ${named}`} disabled={busy} onClick={() => setConfirming(true)} />}
        </span>
      </div>
      {editing ? (
        <div className="mt-1 flex flex-col gap-1.5">
          <textarea
            autoFocus
            aria-label={`Edit ${named}`}
            value={text}
            rows={2}
            maxLength={500}
            onChange={e => setText(oneLine(e.target.value))}
            onKeyDown={e => {
              // Escape cancels the edit and stops here, so a panel around it does not also close.
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
            }}
            className={`${TEXTAREA} text-[13px]`}
          />
          <div className="flex justify-end gap-1.5">
            <TextButton onClick={() => setEditing(false)}>Cancel</TextButton>
            <button type="button" className={PRIMARY} disabled={busy || !text.trim()} onClick={() => void save()}>Save</button>
          </div>
        </div>
      ) : (
        <p className={cx('mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-5', done ? 'text-content/40 line-through decoration-content/25' : 'text-content/85')}>{goal.text}</p>
      )}
      {agent || goal.notes ? (
        <div className="mt-1 flex flex-col gap-0.5">
          {agent ? (
            <button type="button" onClick={() => open({ kind: 'agent', agentId: agent.id })} className="self-start rounded text-[12px] text-content/55 underline decoration-content/20 underline-offset-2 hover:text-content">
              {done ? 'Done by' : 'With'} {agent.name}
            </button>
          ) : null}
          {goal.notes ? <p className="text-[12px] leading-relaxed text-content/40">{goal.notes}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

/** Goals are one line; line breaks typed or pasted become spaces. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');

function IconButton({ icon: Icon, label, disabled, onClick, ref }: { icon: typeof Pencil; label: string; disabled?: boolean; onClick: () => void; ref?: React.Ref<HTMLButtonElement> }) {
  return (
    <button ref={ref} type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid size-5 place-items-center rounded text-content/40 transition-colors hover:bg-selection-hover hover:text-content disabled:pointer-events-none disabled:opacity-30">
      <Icon className="size-3" strokeWidth={1.75} />
    </button>
  );
}

function DecisionItem({ row }: { row: DecisionRow }) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    await attempt(() => api.undoSuper(row.id));
    setBusy(false);
  };
  const undone = row.undoneAt !== undefined;
  return (
    <li data-super-action={row.id} className="group/decision border-b border-content/5 px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString()} className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-content/35">
          {time(row.at)}{undone ? ' · undone' : ''}
        </time>
        {row.undoable ? (
          <TextButton aria-label={`Undo: ${row.summary}`} disabled={busy} onClick={() => void undo()} className="shrink-0 opacity-70 transition-opacity group-hover/decision:opacity-100 focus-visible:opacity-100">
            {busy ? 'Undoing…' : 'Undo'}
          </TextButton>
        ) : null}
      </div>
      <p className={cx('mt-0.5 text-[13px] leading-5', undone ? 'text-content/40 line-through decoration-content/25' : 'text-content/85')}>{row.summary}</p>
      {row.why ? <p className="mt-0.5 text-[12px] leading-relaxed text-content/45">{row.why}</p> : null}
    </li>
  );
}

/** The width of an element's parent, measured before the first paint and kept current; 0 until then. */
function useParentWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    setWidth(Math.round(parent.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
