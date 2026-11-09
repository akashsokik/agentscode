/**
 * The SuperAgent's own parts of the app: in its pane, the questions it waits on you for, as cards
 * with the choices to click; in the right panel, its Decisions (anything it did on its own, which you
 * can undo), Goals and Routines tabs.
 */
import { useEffect, useRef, useState } from 'react';
import type { GoalStatus, RoutineSchedule, SuperAsk, SuperGoal, SuperRoutine } from '../../shared/types.ts';
import { api } from '../api.ts';
import { memoryDate } from '../memory.ts';
import { openAsks } from '../super.ts';
import { decisionRows, GOAL_STATUS_LABEL, goalSections, heldText, scheduleLabel, SUPER_TABS, superTabCounts, superTabDots, superTabLatest, type DecisionRow, type SuperTab } from '../superText.ts';
import { open } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { cx, PRIMARY, TEXTAREA, TextButton } from '../ui/common.tsx';
import { useNow } from '../ui/useNow.ts';
import { ChevronDown, ChevronUp, CircleDot, Clock, ListBullet, Pencil, Trash2 } from '../mono/icons.tsx';
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
 * The Decisions tab: what the SuperAgent did on its own, newest first, each with why and Undo, then
 * what you answered it. Kept live by `super` events.
 */
export function DecisionsView() {
  const log = useApp(s => s.snapshot?.super.log);
  const asks = useApp(s => s.snapshot?.super.asks);
  const rows = decisionRows(log);
  const answered = (asks ?? []).filter(a => a.answeredAt !== undefined);
  const undoable = rows.filter(r => r.undoable).length;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6 font-sans">
      {rows.length ? (
        <>
          <p className="px-4 pb-1 pt-3 text-[12px] leading-relaxed text-content/45">
            What it did on its own.{undoable ? ' Undo puts it back, and the SuperAgent hears that you did.' : ''}
          </p>
          <ol>{rows.map(row => <DecisionItem key={row.id} row={row} />)}</ol>
        </>
      ) : (
        <TabEmpty icon={ListBullet} title="No decisions yet">When the SuperAgent creates agents or channels, delegates or nudges, it shows here with why, and you can undo it.</TabEmpty>
      )}
      {answered.length ? (
        <section aria-label="Your answers" className="pt-4">
          <h3 className="px-4 pb-1 text-[12px] font-medium text-content/50">Your answers</h3>
          <ol>
            {answered.map(ask => (
              <li key={ask.id} className="px-4 py-2">
                <p className="text-[12px] leading-5 text-content/75">{ask.question}</p>
                <p className="text-[12px] leading-5 text-content/45">{ask.dismissed ? 'Put aside' : ask.answer}</p>
                <p className="text-[11px] text-content/30">{time(ask.answeredAt!)}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

/** An empty tab: a quiet icon, what goes here, and how it gets there. */
function TabEmpty({ icon: Icon, title, children }: { icon: typeof ListBullet; title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center font-sans">
      <Icon className="size-5 text-content/25" strokeWidth={1.5} />
      <p className="mt-2.5 text-[13px] text-content/60">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-content/40">{children}</p>
    </div>
  );
}

const SEEN_KEY = 'agentscode:super-tabs-seen';
function readSeen(): Partial<Record<SuperTab, number>> {
  try {
    const saved = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(SUPER_TABS.filter(t => typeof saved[t] === 'number').map(t => [t, saved[t] as number]));
  } catch { return {}; }
}

/**
 * The SuperAgent's tabs in the right panel: the count on each, and a dot on a tab that has something
 * new you have not seen. Opening a tab marks what is on it as seen, remembered across restarts.
 */
export function useSuperTabs(selected: string): { counts: Record<SuperTab, number>; dots: Record<SuperTab, boolean> } {
  const log = useApp(s => s.snapshot?.super.log);
  const goals = useApp(s => s.snapshot?.super.goals);
  const routines = useApp(s => s.snapshot?.super.routines);
  const now = useNow();
  const [seen, setSeen] = useState(readSeen);
  const lists = { log, goals, routines };
  const latest = superTabLatest(lists);
  const shown = (SUPER_TABS as readonly string[]).includes(selected) ? selected as SuperTab : null;
  const shownLatest = shown ? latest[shown] : 0;
  useEffect(() => {
    if (!shown || shownLatest <= (seen[shown] ?? 0)) return;
    const next = { ...seen, [shown]: shownLatest };
    setSeen(next);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }, [shown, shownLatest, seen]);
  return { counts: superTabCounts(lists, now), dots: superTabDots(latest, seen, selected) };
}

/**
 * The goals backlog: what you want done, in order. The SuperAgent works it top down, giving each
 * goal to a free agent; you add, edit, reorder and remove goals here, and see who is on each.
 */
export function GoalsView() {
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
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      <div className="shrink-0 px-4 pb-2 pt-3">
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
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        {open.length ? (
          <ol ref={list} aria-label="Open goals">
            {open.map((goal, i) => <GoalItem key={goal.id} goal={goal} index={i} last={i === open.length - 1} onRemoved={() => focusAfterRemove(i)} />)}
          </ol>
        ) : (
          <TabEmpty icon={CircleDot} title="No goals yet">Add what you want done. The SuperAgent works through them top down, giving each to a free agent, and asks you when it needs to.</TabEmpty>
        )}
        {done.length ? (
          <section aria-label="Done goals" className="pt-4">
            <button type="button" aria-expanded={showDone} onClick={() => setShowDone(v => !v)} className="flex w-full items-center gap-1.5 px-4 py-1 text-left text-[12px] font-medium text-content/50 hover:text-content/80">
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
    <li data-goal={goal.id} data-goal-status={goal.status} className="group/goal px-4 py-2.5">
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
    <li data-super-action={row.id} className="group/decision px-4 py-2.5">
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

/**
 * Scheduled routines: what the SuperAgent does on its own at set times, in your words. Each becomes
 * an update at its time, so every wake limit and the daily budget apply. Proposals from the
 * SuperAgent wait here until you confirm them.
 */
export function RoutinesView() {
  const routines = useApp(s => s.snapshot?.super.routines) ?? [];
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<RoutineSchedule['kind']>('daily');
  const [at, setAt] = useState('09:00');
  const [hours, setHours] = useState('6');
  const [busy, setBusy] = useState(false);
  const proposed = routines.filter(r => r.proposed);
  const own = routines.filter(r => !r.proposed);
  const ready = Boolean(name.trim() && instruction.trim()) && (kind === 'daily' ? /^\d{1,2}:\d{2}$/.test(at) : Number(hours) >= 1 && Number(hours) <= 168);
  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const schedule: RoutineSchedule = kind === 'daily' ? { kind, at } : { kind, hours: Math.trunc(Number(hours)) };
    const ok = await attempt(() => api.addRoutine({ name: name.trim(), instruction: instruction.trim(), projectId: projectId || null, schedule }));
    setBusy(false);
    if (ok) { setName(''); setInstruction(''); }
  };
  const field = 'h-6 rounded-md border border-content/12 bg-transparent px-1.5 text-[12px] text-content/75 outline-none';
  return (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      <div className="shrink-0 px-4 pb-2 pt-3">
        <input aria-label="Routine name" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Name, for example Morning CI check" className={`${field} h-7 w-full text-[13px]`} />
        <textarea aria-label="What the SuperAgent should do" value={instruction} rows={2} maxLength={1000} onChange={e => setInstruction(e.target.value)} placeholder="What the SuperAgent should do each time" className={`${TEXTAREA} mt-1.5 text-[13px]`} />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <select aria-label="How often" value={kind} onChange={e => setKind(e.target.value as RoutineSchedule['kind'])} className={field}>
            <option value="daily">Daily at</option>
            <option value="every">Every</option>
          </select>
          {kind === 'daily'
            ? <input type="time" aria-label="Time" value={at} onChange={e => setAt(e.target.value)} className={`${field} w-24`} />
            : <><input type="number" aria-label="Hours" min={1} max={168} value={hours} onChange={e => setHours(e.target.value)} className={`${field} w-14`} /><span className="text-[12px] text-content/45">hours</span></>}
          <select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)} className={`${field} min-w-0 flex-1 truncate`}>
            <option value="">Any project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="button" className={PRIMARY} disabled={!ready || busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
        {proposed.length ? (
          <section aria-label="Proposed by the SuperAgent" className="pb-2 pt-2">
            <h3 className="px-4 pb-1 text-[12px] font-medium text-content/50">Proposed, waiting for you</h3>
            <ol>{proposed.map(r => <RoutineItem key={r.id} routine={r} />)}</ol>
          </section>
        ) : null}
        {own.length ? <ol aria-label="Routines">{own.map(r => <RoutineItem key={r.id} routine={r} />)}</ol> : !proposed.length ? (
          <TabEmpty icon={Clock} title="No routines yet">Add something the SuperAgent should do on a schedule, such as checking CI every morning. It runs within your wake limits and daily budget.</TabEmpty>
        ) : null}
      </div>
    </div>
  );
}

function RoutineItem({ routine }: { routine: SuperRoutine }) {
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === routine.projectId));
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => { setBusy(true); await attempt(action); setBusy(false); };
  const named = `"${routine.name}"`;
  return (
    <li data-routine={routine.id} className="group/routine px-4 py-2.5">
      <div className="flex items-center gap-2">
        <p className={cx('min-w-0 flex-1 truncate text-[13px] font-medium', routine.enabled || routine.proposed ? 'text-content/85' : 'text-content/45')}>{routine.name}</p>
        {routine.proposed ? (
          <>
            <TextButton aria-label={`Reject ${named}`} disabled={busy} onClick={() => void run(() => api.removeRoutine(routine.id))}>Reject</TextButton>
            <button type="button" aria-label={`Confirm ${named}`} className={PRIMARY} disabled={busy} onClick={() => void run(() => api.updateRoutine(routine.id, { confirm: true }))}>Confirm</button>
          </>
        ) : (
          <>
            <TextButton aria-label={`${routine.enabled ? 'Pause' : 'Resume'} ${named}`} disabled={busy} onClick={() => void run(() => api.updateRoutine(routine.id, { enabled: !routine.enabled }))}>{routine.enabled ? 'Pause' : 'Resume'}</TextButton>
            <IconButton icon={Trash2} label={`Remove ${named}`} disabled={busy} onClick={() => void run(() => api.removeRoutine(routine.id))} />
          </>
        )}
      </div>
      <p className="mt-0.5 text-[11px] text-content/40">{scheduleLabel(routine.schedule)}{project ? ` · ${project.name}` : ''}{routine.enabled ? '' : routine.proposed ? ' · proposed by the SuperAgent' : ' · paused'}</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-content/65">{routine.instruction}</p>
      {routine.proposed && routine.why ? <p className="mt-0.5 text-[12px] leading-relaxed text-content/40">Why: {routine.why}</p> : null}
    </li>
  );
}
