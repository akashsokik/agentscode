/**
 * The SuperAgent's own parts of the app: in its pane, the questions it waits on you for, as cards
 * with the choices to click; in the right panel, its Decisions (anything it did on its own, which you
 * can undo), Issues and Routines tabs, drawn with the shared panel list (web/ui/PanelList.tsx, ACH-D37).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { IssueStatus, RoutineSchedule, SuperAction, SuperAsk, SuperIssue, SuperRoutine } from '../../shared/types.ts';
import { api } from '../api.ts';
import { openAsks } from '../super.ts';
import { ISSUE_STATUS_LABEL, heldText, migrateSeen, scheduleLabel, SUPER_TABS, superTabCounts, superTabDots, superTabLatest, type SuperTab } from '../superText.ts';
import { ISSUE_TITLE_MAX, isOpenIssue } from '../../shared/issues.ts';
import { armRemove, cleanSummary, decisionGroups, keepArmed, decisionKind, focusAfterRemoval, issueGroups, issueMoves, routineGroups, shortSchedule, shortWhen, type DecisionKind, type DecisionsFilter, type IssuesFilter } from '../panelList.ts';
import { open } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { INPUT, MenuDivider, MenuRow, PRIMARY, TEXTAREA, TextButton } from '../ui/common.tsx';
import { Kbd } from '../ui/Kbd.tsx';
import { useNow } from '../ui/useNow.ts';
import { AgentAvatar } from '../ui/Avatar.tsx';
import { DetailButton, focusAdd, focusRow, PanelEmpty, PanelList, PanelRow, PanelSection, PanelToolbar, RowAction, RowIcon } from '../ui/PanelList.tsx';
import { Bot, Chatting, Check, CheckCircle, ChevronDown, ChevronUp, CircleAlert, CircleDashed, CircleDot, CircleX, Clock, Copy, CornerDownRight, Eye, ListBullet, MessageMultiple, MessageSquare, Pause, Pencil, Play, Search as SearchIcon, Trash2, Undo2, X } from '../mono/icons.tsx';
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

const SEEN_KEY = 'podcode:super-tabs-seen';
function readSeen(): Partial<Record<SuperTab, number>> {
  try {
    const saved = migrateSeen(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>);
    return Object.fromEntries(SUPER_TABS.filter(t => typeof saved[t] === 'number').map(t => [t, saved[t] as number]));
  } catch { return {}; }
}

/**
 * The SuperAgent's tabs in the right panel: the count on each, and a dot on a tab that has something
 * new you have not seen. Opening a tab marks what is on it as seen, remembered across restarts.
 */
export function useSuperTabs(selected: string): { counts: Record<SuperTab, number>; dots: Record<SuperTab, boolean> } {
  const log = useApp(s => s.snapshot?.super.log);
  const issues = useApp(s => s.snapshot?.super.issues);
  const routines = useApp(s => s.snapshot?.super.routines);
  const now = useNow();
  const [seen, setSeen] = useState(readSeen);
  const lists = { log, issues, routines };
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

const fullTime = (ts: number) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const KIND_ICON: Record<DecisionKind, typeof ListBullet> = { delegate: CornerDownRight, message: MessageSquare, issue: CircleDot, agent: Bot, channel: MessageMultiple, other: ListBullet };

/**
 * The Decisions tab (ACH-D37): what the SuperAgent did on its own, one line each, grouped by day,
 * with Undo on hover, in the row's menu and when it is open; Answers shows what you answered it.
 * Search covers summaries and why. Kept live by `super` events.
 */
export function DecisionsView() {
  const log = useApp(s => s.snapshot?.super.log);
  const asks = useApp(s => s.snapshot?.super.asks);
  const now = useNow();
  const [filter, setFilter] = useState<DecisionsFilter>('actions');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { counts, actions, answers } = decisionGroups(log, asks, filter, query, now);
  const toggle = (id: string) => setOpen(o => (o === id ? null : id));
  const groups = filter === 'actions' ? actions : answers;
  return (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      <PanelToolbar
        query={query}
        onQuery={setQuery}
        searchLabel={filter === 'actions' ? 'Search what the SuperAgent did' : 'Search your answers'}
        filter={{ label: 'Show', value: filter, onChange: setFilter, options: [{ value: 'actions', label: 'Actions', count: counts.actions }, { value: 'answers', label: 'Answers', count: counts.answers }] }}
      />
      <PanelList label={filter === 'actions' ? 'What the SuperAgent did' : 'Your answers'}>
        {!groups.length ? (
          query.trim() ? <PanelEmpty icon={<SearchIcon strokeWidth={1.5} />} title={`Nothing about "${query.trim()}"`} />
            : filter === 'actions' ? <PanelEmpty icon={<ListBullet strokeWidth={1.5} />} title="No decisions yet">When the SuperAgent creates agents or channels, delegates or nudges on its own, it shows here with why, and you can undo it.</PanelEmpty>
              : <PanelEmpty icon={<Chatting strokeWidth={1.5} />} title="No answers yet">Questions the SuperAgent asks you show here once you answer them.</PanelEmpty>
        ) : filter === 'actions' ? actions.map(g => (
          <section key={g.key} aria-label={g.label}>
            <PanelSection label={g.label} count={g.items.length} />
            {g.items.map(a => <DecisionItem key={a.id} action={a} now={now} expanded={open === a.id} onToggle={() => toggle(a.id)} />)}
          </section>
        )) : answers.map(g => (
          <section key={g.key} aria-label={g.label}>
            <PanelSection label={g.label} count={g.items.length} />
            {g.items.map(a => <AnswerItem key={a.id} ask={a} now={now} expanded={open === a.id} onToggle={() => toggle(a.id)} />)}
          </section>
        ))}
      </PanelList>
    </div>
  );
}

function DecisionItem({ action, now, expanded, onToggle }: { action: SuperAction; now: number; expanded: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false);
  const undone = action.undoneAt !== undefined;
  const undoable = Boolean(action.undo) && !undone;
  const summary = cleanSummary(action.summary);
  // Undo takes its own button away (an undone action has none): focus goes back to the row.
  const undo = async () => { if (busy) return; setBusy(true); await attempt(() => api.undoSuper(action.id)); setBusy(false); focusRow(document, action.id); };
  const KindIcon = KIND_ICON[decisionKind(action.tool)];
  return (
    <PanelRow
      id={action.id}
      lead={<KindIcon className="size-3.5" strokeWidth={1.6} />}
      title={summary}
      label={`${summary}${undone ? ', undone' : ''}, ${fullTime(action.at)}`}
      dim={undone}
      meta={<time dateTime={new Date(action.at).toISOString()}>{undone ? 'Undone · ' : ''}{shortWhen(action.at, now)}</time>}
      actions={undoable ? <RowAction label={`Undo: ${summary}`} busy={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</RowAction> : undefined}
      expanded={expanded}
      onOpen={onToggle}
      menuLabel={`Decision: ${summary}`}
      menu={close => (
        <>
          <MenuRow icon={expanded ? ChevronUp : ChevronDown} title={expanded ? 'Close' : 'Open'} shortcut="Enter" onSelect={() => { close(); onToggle(); }} />
          <MenuRow icon={Undo2} title="Undo" disabled={!undoable || busy} onSelect={() => { close(); void undo(); }} />
          <MenuDivider />
          <MenuRow icon={Copy} title="Copy summary" onSelect={() => { close(); void navigator.clipboard?.writeText(action.summary); }} />
        </>
      )}
    >
      <p className="whitespace-pre-wrap break-words">{action.summary}</p>
      {action.why ? <p className="mt-1 text-content/50">Why: {action.why}</p> : null}
      <p className="mt-1 text-[11px] text-content/40">{fullTime(action.at)}{undone ? ` · undone ${fullTime(action.undoneAt!)}` : ''}</p>
      {undoable ? <div className="mt-2 flex gap-1.5"><DetailButton busy={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</DetailButton></div> : null}
    </PanelRow>
  );
}

function AnswerItem({ ask, now, expanded, onToggle }: { ask: SuperAsk; now: number; expanded: boolean; onToggle: () => void }) {
  const answer = ask.dismissed ? 'Put aside' : ask.answer ?? '';
  return (
    <PanelRow
      id={ask.id}
      lead={<Chatting className="size-3.5" strokeWidth={1.6} />}
      title={ask.question}
      label={`${ask.question}: ${answer}, ${fullTime(ask.answeredAt!)}`}
      meta={<><span className="max-w-24 truncate">{answer}</span><span>· {shortWhen(ask.answeredAt!, now)}</span></>}
      expanded={expanded}
      onOpen={onToggle}
      menuLabel={`Answer: ${ask.question}`}
      menu={close => (
        <>
          <MenuRow icon={expanded ? ChevronUp : ChevronDown} title={expanded ? 'Close' : 'Open'} shortcut="Enter" onSelect={() => { close(); onToggle(); }} />
          <MenuRow icon={Copy} title="Copy question and answer" onSelect={() => { close(); void navigator.clipboard?.writeText(`${ask.question}\n${answer}`); }} />
        </>
      )}
    >
      <p className="whitespace-pre-wrap break-words">{ask.question}</p>
      {ask.detail ? <p className="mt-1 text-content/50">{ask.detail}</p> : null}
      <p className="mt-1">Your answer: <span className="text-content">{answer}</span></p>
      <p className="mt-1 text-[11px] text-content/40">{fullTime(ask.answeredAt!)}</p>
    </PanelRow>
  );
}

/** Issues are one line; line breaks typed or pasted become spaces. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');

/** Existing mono icons until the status glyphs from the approved demo land (ACH-D41, phase 3). */
const ISSUE_ICON: Record<IssueStatus, { icon: typeof ListBullet; cls: string }> = {
  needs_you: { icon: CircleAlert, cls: 'text-warning' },
  in_review: { icon: Eye, cls: 'text-content/75' },
  in_progress: { icon: CircleDot, cls: 'text-content/75' },
  waiting: { icon: Pause, cls: '' },
  todo: { icon: CircleDashed, cls: '' },
  backlog: { icon: CircleDashed, cls: 'text-content/40' },
  done: { icon: CheckCircle, cls: '' },
  canceled: { icon: CircleX, cls: 'text-content/40' },
};

/** A one-line composer: Enter adds, Escape closes. Opened by +. */
function Composer({ placeholder, label, onAdd, onClose, children }: { placeholder: string; label: string; onAdd: (text: string) => Promise<boolean>; onClose: () => void; children?: ReactNode }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onAdd(text.trim());
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div className="mx-2.5 mb-1.5 rounded-lg border border-content/12 px-2 py-1.5 font-sans" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <input
        autoFocus
        aria-label={label}
        value={text}
        maxLength={500}
        // Never disabled while adding: Chromium blurs a disabled field, and focus must stay for the next one.
        aria-busy={busy || undefined}
        readOnly={busy}
        onChange={e => setText(oneLine(e.target.value))}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void add(); } }}
        placeholder={placeholder}
        className="h-6 w-full bg-transparent text-[12.5px] text-content outline-none placeholder:text-content/40"
      />
      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-content/45">
        {children}
        <span className="ml-auto inline-flex items-center gap-1"><Kbd spec="Enter" quiet /> add <Kbd spec="Escape" quiet /> close</span>
      </div>
    </div>
  );
}

/**
 * The issues backlog (ACH-D37): what you want done, in order. Open issues by status (needs you, in
 * progress, queued), then Done folded at the end; + opens a one-line composer. An issue opens in
 * place with its notes, who has it, its status and Edit; move, mark done and remove are also in
 * its menu and, on hover, its icons.
 */
export function IssuesView() {
  const issues = useApp(s => s.snapshot?.super.issues);
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  const [filter, setFilter] = useState<IssuesFilter>('open');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const { counts, open: sections, done } = issueGroups(issues, filter, query);
  const ordered = sections.flatMap(s => s.items);
  // The backlog's own order, for moving: positions are among all open issues, not a search's.
  const backlog = (issues ?? []).filter(isOpenIssue).sort((a, b) => a.order - b.order);
  const moves = issueMoves(sections, backlog);
  const root = useRef<HTMLDivElement>(null);
  const toggle = (id: string) => setOpen(o => (o === id ? null : id));
  const doneShown = filter === 'done' || showDone || Boolean(query.trim());
  // The rows on screen, in order: where focus goes when one is removed.
  const shownIds = [...ordered, ...(doneShown ? done : [])].map(g => g.id);
  const item = (issue: SuperIssue) => (
    <IssueItem key={issue.id} issue={issue} moves={moves.get(issue.id) ?? { up: null, down: null }} expanded={open === issue.id} onToggle={() => toggle(issue.id)} onRemoved={() => focusRow(root.current, focusAfterRemoval(shownIds, issue.id))} onSettled={() => focusRow(root.current, issue.id)} />
  );
  const closeAdd = () => { setAdding(false); focusAdd(root.current); };
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col font-sans">
      <PanelToolbar
        query={query}
        onQuery={setQuery}
        searchLabel="Search issues"
        filter={{ label: 'Show', value: filter, onChange: setFilter, options: [{ value: 'open', label: 'Open', count: counts.open }, { value: 'done', label: 'Done', count: counts.done }] }}
        onAdd={() => setAdding(a => !a)}
        addLabel="Add an issue"
      />
      {adding ? (
        <Composer placeholder="Add an issue for the SuperAgent" label="New issue" onClose={closeAdd} onAdd={async text => Boolean(await attempt(() => api.addIssue({ text, projectId: projectId || null })))}>
          <select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)} className="h-5 max-w-40 truncate rounded bg-content/5 px-1 text-[11px] text-content/65 outline-none">
            <option value="">Any project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Composer>
      ) : null}
      <PanelList label="Issues">
        {filter === 'open' && !ordered.length && !query.trim() ? (
          <PanelEmpty icon={<CircleDot strokeWidth={1.5} />} title="No open issues" action={<DetailButton onClick={() => setAdding(true)}>Add issue</DetailButton>}>The SuperAgent works through issues top down, giving each to a free agent.</PanelEmpty>
        ) : null}
        {sections.map(s => (
          <section key={s.key} aria-label={s.label}>
            <PanelSection label={s.label} count={s.items.length} />
            {s.items.map(item)}
          </section>
        ))}
        {done.length ? (
          <section aria-label="Done">
            {filter === 'done' ? <PanelSection label="Done" count={done.length} /> : <PanelSection label="Done" count={done.length} folded={!doneShown} onToggle={() => setShowDone(v => !v)} />}
            {doneShown ? done.map(item) : null}
          </section>
        ) : null}
        {query.trim() && !ordered.length && !done.length ? <PanelEmpty icon={<SearchIcon strokeWidth={1.5} />} title={`No issues about "${query.trim()}"`} /> : null}
        {filter === 'done' && !done.length && !query.trim() ? <PanelEmpty icon={<CheckCircle strokeWidth={1.5} />} title="No done issues yet">Issues the SuperAgent or you mark done show here, newest first.</PanelEmpty> : null}
      </PanelList>
    </div>
  );
}

function IssueItem({ issue, moves, expanded, onToggle, onRemoved, onSettled }: { issue: SuperIssue; moves: { up: number | null; down: number | null }; expanded: boolean; onToggle: () => void; onRemoved: () => void; /** After a change that can move the row: focus it again. */ onSettled: () => void }) {
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === issue.projectId));
  const agent = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId) : undefined));
  const [editing, setEditing] = useState(false);
  // Edit renames: the title, one line. The description (Markdown, many lines) is edited in the issue view.
  const [title, setTitle] = useState(issue.title);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [focusConfirm, setFocusConfirm] = useState(false);
  // The confirm disarms after a few seconds, unless it has focus (someone is about to press it).
  useEffect(() => {
    if (!confirming) return;
    const timer = setInterval(() => { if (!keepArmed(document.activeElement === confirmButton.current)) setConfirming(false); }, 4000);
    return () => clearInterval(timer);
  }, [confirming]);
  // Armed from the menu: once the row is open and the menu has gone, focus the confirm.
  useEffect(() => {
    if (!focusConfirm || !confirming) return;
    // After the menu's own focus restore (a frame), so that one finds focus already placed and keeps it.
    const timer = setTimeout(() => { confirmButton.current?.focus(); setFocusConfirm(false); }, 50);
    return () => clearTimeout(timer);
  }, [focusConfirm, confirming]);
  const armFromMenu = () => {
    const next = armRemove(expanded, true);
    if (next.open) onToggle();
    setConfirming(true);
    setFocusConfirm(next.focusConfirm);
  };
  const named = `"${issue.title.length > 60 ? `${issue.title.slice(0, 59)}…` : issue.title}"`;
  const run = async (action: () => Promise<unknown>) => { setBusy(true); const ok = await attempt(action); setBusy(false); return ok; };
  const save = async () => { if (!busy && title.trim() && await run(() => api.updateIssue(issue.id, { title: title.trim() }))) { setEditing(false); onSettled(); } };
  const done = !isOpenIssue(issue);
  // A status change moves the row to another section: focus follows it (or goes to + if it folded away).
  const status = (s: IssueStatus) => { if (!busy) void run(() => api.updateIssue(issue.id, { status: s })).then(onSettled); };
  const edit = () => { setTitle(issue.title); setEditing(true); if (!expanded) onToggle(); };
  const { icon: StatusIcon, cls } = ISSUE_ICON[issue.status];
  const moveTo = (to: number | null) => { if (to !== null && !busy) void run(() => api.moveIssue(issue.id, to)).then(onSettled); };
  const removeNow = async () => { if (await run(() => api.removeIssue(issue.id))) onRemoved(); };
  const remove = <RowAction label={`Confirm removing ${named}`} busy={busy} onClick={() => void removeNow()}><span className="text-danger">Remove?</span></RowAction>;
  return (
    <PanelRow
      id={issue.id}
      lead={<StatusIcon className={`size-3.5 ${cls}`} strokeWidth={1.6} />}
      title={issue.text}
      label={`${ISSUE_STATUS_LABEL[issue.status]}: ${issue.text}${agent ? `, with ${agent.name}` : ''}${project ? `, ${project.name}` : ''}`}
      dim={done}
      meta={<>{agent ? <AgentAvatar agent={agent} animate={false} className="size-3.5" /> : null}{project ? <span className="font-mono text-[10.5px]">{project.code ?? project.name}</span> : null}</>}
      actions={confirming ? remove : (
        <>
          {!done ? <RowIcon icon={ChevronUp} label={`Move ${named} up`} disabled={moves.up === null} busy={busy} onClick={() => moveTo(moves.up)} /> : null}
          {!done ? <RowIcon icon={ChevronDown} label={`Move ${named} down`} disabled={moves.down === null} busy={busy} onClick={() => moveTo(moves.down)} /> : null}
          <RowIcon icon={Pencil} label={`Edit the title of ${named}`} busy={busy} onClick={edit} />
          <RowIcon icon={Trash2} label={`Remove ${named}`} busy={busy} onClick={() => setConfirming(true)} />
        </>
      )}
      expanded={expanded}
      onOpen={onToggle}
      menuLabel={`Issue ${named}`}
      menu={close => (
        <>
          <MenuRow icon={expanded ? ChevronUp : ChevronDown} title={expanded ? 'Close' : 'Open'} shortcut="Enter" onSelect={() => { close(); onToggle(); }} />
          <MenuRow icon={Pencil} title="Edit title" onSelect={() => { close(); edit(); }} />
          {!done ? (
            <>
              <MenuRow icon={ChevronUp} title="Move up" disabled={busy || moves.up === null} onSelect={() => { close(); moveTo(moves.up); }} />
              <MenuRow icon={ChevronDown} title="Move down" disabled={busy || moves.down === null} onSelect={() => { close(); moveTo(moves.down); }} />
            </>
          ) : null}
          <MenuDivider />
          {(Object.keys(ISSUE_STATUS_LABEL) as IssueStatus[]).map(s => (
            <MenuRow key={s} title={s === 'done' ? 'Mark done' : ISSUE_STATUS_LABEL[s]} checked={issue.status === s} disabled={busy} onSelect={() => { close(); status(s); }} />
          ))}
          <MenuDivider />
          <MenuRow icon={Trash2} title="Remove…" danger disabled={busy} onSelect={() => { close(); armFromMenu(); }} />
        </>
      )}
    >
      {editing ? (
        <div className="flex flex-col gap-1.5" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); } }}>
          <input
            autoFocus
            aria-label={`Title of ${named}`}
            value={title}
            maxLength={ISSUE_TITLE_MAX}
            onChange={e => setTitle(oneLine(e.target.value))}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }}
            className={`${INPUT} text-[12.5px]`}
          />
          <div className="flex justify-end gap-1.5">
            <TextButton onClick={() => setEditing(false)}>Cancel</TextButton>
            <button type="button" className={PRIMARY} disabled={!title.trim()} aria-busy={busy || undefined} onClick={() => void save()}>Save</button>
          </div>
        </div>
      ) : <p className="whitespace-pre-wrap break-words">{issue.text}</p>}
      {issue.notes ? <p className="mt-1 text-content/50">{issue.notes}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {agent ? <DetailButton onClick={() => open({ kind: 'agent', agentId: agent.id })}>{done ? 'Done by' : 'With'} {agent.name}</DetailButton> : null}
        <select
          aria-label={`Status of ${named}`}
          value={issue.status}
          aria-busy={busy || undefined}
          onChange={e => status(e.target.value as IssueStatus)}
          className="h-6 rounded-md border border-content/12 bg-transparent px-1 text-[11.5px] text-content/75 outline-none"
        >
          {(Object.keys(ISSUE_STATUS_LABEL) as IssueStatus[]).map(s => <option key={s} value={s}>{ISSUE_STATUS_LABEL[s]}</option>)}
        </select>
        {!editing ? <DetailButton onClick={edit}>Edit title</DetailButton> : null}
        {confirming ? <DetailButton ref={confirmButton} danger label={`Confirm removing ${named}`} busy={busy} onClick={() => void removeNow()}>Remove?</DetailButton> : <DetailButton onClick={() => setConfirming(true)}>Remove</DetailButton>}
      </div>
    </PanelRow>
  );
}

/**
 * Scheduled routines (ACH-D37): what the SuperAgent does on its own at set times. Proposals wait
 * for you first; + opens the form. Each becomes an update at its time, within the wake limits and
 * the daily budget.
 */
export function RoutinesView() {
  const routines = useApp(s => s.snapshot?.super.routines);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const groups = routineGroups(routines, query);
  const root = useRef<HTMLDivElement>(null);
  const shownIds = groups.flatMap(g => g.items.map(r => r.id));
  const closeAdd = () => { setAdding(false); focusAdd(root.current); };
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col font-sans">
      <PanelToolbar query={query} onQuery={setQuery} searchLabel="Search routines" onAdd={() => setAdding(a => !a)} addLabel="Add a routine" />
      {adding ? <RoutineForm onClose={closeAdd} /> : null}
      <PanelList label="Routines">
        {groups.map(g => (
          <section key={g.key} aria-label={g.label}>
            <PanelSection label={g.label} count={g.items.length} />
            {g.items.map(r => <RoutineItem key={r.id} routine={r} expanded={open === r.id} onToggle={() => setOpen(o => (o === r.id ? null : r.id))} onRemoved={() => focusRow(root.current, focusAfterRemoval(shownIds, r.id))} onSettled={() => focusRow(root.current, r.id)} />)}
          </section>
        ))}
        {!groups.length ? (
          query.trim() ? <PanelEmpty icon={<SearchIcon strokeWidth={1.5} />} title={`No routines about "${query.trim()}"`} />
            : !adding ? <PanelEmpty icon={<Clock strokeWidth={1.5} />} title="No routines yet" action={<DetailButton onClick={() => setAdding(true)}>Add routine</DetailButton>}>Things the SuperAgent does on a schedule, such as a morning CI check. They run within your wake limits and daily budget.</PanelEmpty> : null
        ) : null}
      </PanelList>
    </div>
  );
}

function RoutineForm({ onClose }: { onClose: () => void }) {
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<RoutineSchedule['kind']>('daily');
  const [at, setAt] = useState('09:00');
  const [hours, setHours] = useState('6');
  const [busy, setBusy] = useState(false);
  const ready = Boolean(name.trim() && instruction.trim()) && (kind === 'daily' ? /^\d{1,2}:\d{2}$/.test(at) : Number(hours) >= 1 && Number(hours) <= 168);
  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const schedule: RoutineSchedule = kind === 'daily' ? { kind, at } : { kind, hours: Math.trunc(Number(hours)) };
    const ok = await attempt(() => api.addRoutine({ name: name.trim(), instruction: instruction.trim(), projectId: projectId || null, schedule }));
    setBusy(false);
    if (ok) { setName(''); setInstruction(''); onClose(); }
  };
  const field = 'h-6 rounded-md border border-content/12 bg-transparent px-1.5 text-[12px] text-content/75 outline-none';
  return (
    <div className="mx-2.5 mb-1.5 flex flex-col gap-1.5 rounded-lg border border-content/12 p-2 font-sans" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <input autoFocus aria-label="Routine name" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Name, for example Morning CI check" className="h-6 bg-transparent text-[12.5px] text-content outline-none placeholder:text-content/40" />
      <textarea aria-label="What the SuperAgent should do" value={instruction} rows={2} maxLength={1000} onChange={e => setInstruction(e.target.value)} placeholder="What the SuperAgent should do each time" className={`${TEXTAREA} text-[12.5px]`} />
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label="How often" value={kind} onChange={e => setKind(e.target.value as RoutineSchedule['kind'])} className={field}>
          <option value="daily">Daily at</option>
          <option value="every">Every</option>
        </select>
        {kind === 'daily'
          ? <input type="time" aria-label="Time" value={at} onChange={e => setAt(e.target.value)} className={`${field} w-24`} />
          : <><input type="number" aria-label="Hours" min={1} max={168} value={hours} onChange={e => setHours(e.target.value)} className={`${field} w-14`} /><span className="text-[12px] text-content/45">hours</span></>}
        <select aria-label="Project" value={projectId} onChange={e => setProjectId(e.target.value)} className={`${field} min-w-24 flex-1 truncate`}>
          <option value="">Any project</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <TextButton onClick={onClose}>Cancel</TextButton>
        <button type="button" className={PRIMARY} disabled={!ready || busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
    </div>
  );
}

function RoutineItem({ routine, expanded, onToggle, onRemoved, onSettled }: { routine: SuperRoutine; expanded: boolean; onToggle: () => void; onRemoved: () => void; onSettled: () => void }) {
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === routine.projectId));
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => { setBusy(true); const ok = await attempt(action); setBusy(false); return ok; };
  const named = `"${routine.name}"`;
  const paused = !routine.enabled && !routine.proposed;
  const confirm = () => { if (!busy) void run(() => api.updateRoutine(routine.id, { confirm: true })).then(onSettled); };
  const reject = () => busy ? undefined : void run(() => api.removeRoutine(routine.id)).then(ok => { if (ok) onRemoved(); });
  const pause = () => { if (!busy) void run(() => api.updateRoutine(routine.id, { enabled: !routine.enabled })).then(onSettled); };
  return (
    <PanelRow
      id={routine.id}
      lead={paused ? <Pause className="size-3.5 text-content/35" strokeWidth={1.6} /> : <Clock className="size-3.5" strokeWidth={1.6} />}
      title={routine.name}
      label={`${routine.name}, ${scheduleLabel(routine.schedule)}${project ? `, ${project.name}` : ''}${routine.proposed ? ', proposed by the SuperAgent' : paused ? ', paused' : ''}`}
      dim={paused}
      meta={<span>{paused ? 'Paused · ' : ''}{shortSchedule(routine.schedule)}{project ? ` · ${project.code ?? project.name}` : ''}</span>}
      actions={routine.proposed
        ? <RowAction label={`Confirm ${named}`} busy={busy} onClick={confirm}>Confirm</RowAction>
        : <RowAction label={`${routine.enabled ? 'Pause' : 'Resume'} ${named}`} busy={busy} onClick={pause}>{routine.enabled ? 'Pause' : 'Resume'}</RowAction>}
      expanded={expanded}
      onOpen={onToggle}
      menuLabel={`Routine ${named}`}
      menu={close => (
        <>
          <MenuRow icon={expanded ? ChevronUp : ChevronDown} title={expanded ? 'Close' : 'Open'} shortcut="Enter" onSelect={() => { close(); onToggle(); }} />
          {routine.proposed ? (
            <>
              <MenuRow icon={Check} title="Confirm" disabled={busy} onSelect={() => { close(); confirm(); }} />
              <MenuRow icon={X} title="Reject" danger disabled={busy} onSelect={() => { close(); reject(); }} />
            </>
          ) : (
            <>
              <MenuRow icon={routine.enabled ? Pause : Play} title={routine.enabled ? 'Pause' : 'Resume'} disabled={busy} onSelect={() => { close(); pause(); }} />
              <MenuDivider />
              <MenuRow icon={Trash2} title="Remove" danger disabled={busy} onSelect={() => { close(); reject(); }} />
            </>
          )}
        </>
      )}
    >
      <p className="whitespace-pre-wrap break-words">{routine.instruction}</p>
      {routine.proposed && routine.why ? <p className="mt-1 text-content/50">Why: {routine.why}</p> : null}
      <p className="mt-1 text-[11px] text-content/40">{scheduleLabel(routine.schedule)}{project ? ` · ${project.name}` : ''}</p>
      <div className="mt-2 flex gap-1.5">
        {routine.proposed ? (
          <>
            <DetailButton busy={busy} onClick={confirm}>Confirm</DetailButton>
            <DetailButton danger busy={busy} onClick={reject}>Reject</DetailButton>
          </>
        ) : (
          <>
            <DetailButton busy={busy} onClick={pause}>{routine.enabled ? 'Pause' : 'Resume'}</DetailButton>
            <DetailButton danger busy={busy} onClick={reject}>Remove</DetailButton>
          </>
        )}
      </div>
    </PanelRow>
  );
}
