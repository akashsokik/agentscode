/**
 * The quick composer: talk to the SuperAgent, any agent, or start a new agent in a project, from a
 * small card. After MonoCode's quick composer (a rounded card, one picker open at a time, Enter
 * sends, Cmd+Enter sends and opens, Esc closes a picker and then dismisses), and more: the
 * SuperAgent's questions answerable inline, the team at a glance, and the target's reply as it
 * streams. It fills the desktop app's floating window (quick.html) and, in a browser, the in-app
 * quick bar (web/ui/SuperQuickBar.tsx).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ENGINES, type Agent, type EngineKind, type Entry, type SuperAsk } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useAgentFiles, useProjectsFiles } from '../composer/catalog.ts';
import { mentionNames, useMentionHints } from '../composer/mentionHints.ts';
import { MentionPicker } from '../composer/Pickers.tsx';
import { mentionTokenAt, pickValue, rankMentions, replaceToken, withFolders, type MentionPick } from '../composer/tokens.ts';
import { IS_MAC } from '../platform.ts';
import { attempt, loadEntries, useApp } from '../store.ts';
import { projectLabel } from '../projects.ts';
import { heldText, openAsks } from '../superText.ts';
import { cx } from '../ui/common.tsx';
import { EngineIcon, ENGINE_NAMES } from '../ui/EngineIcon.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { ArrowUp, Check, ChevronDown, Folder, Plus, Search, Sparkles, X } from '../mono/icons.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { answerQuick, sendQuick, targetAgentId, teamStatus, type QuickTarget, type TeamMember, type TeamState } from './route.ts';
import { AgentAvatar, AvatarGlyph } from '../ui/Avatar.tsx';
import { SUPER_LOOK } from '../../shared/avatar.ts';

type Picker = 'target' | 'project' | 'model' | null;

const DRAFT_KEY = 'agentscode:quick-draft';
const TARGET_KEY = 'agentscode:quick-target';
const FIELD_MAX = 220;
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
/** Card motion, as MonoCode's picker motion: a quick ease-out on height, a fade on the panel. */
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

function readTarget(): QuickTarget {
  try {
    const raw = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null') as QuickTarget | null;
    if (raw && (raw.kind === 'super' || (raw.kind === 'agent' && typeof raw.agentId === 'string') || (raw.kind === 'new' && ENGINES.includes(raw.engine)))) return raw;
  } catch { /* fall through */ }
  return { kind: 'super' };
}

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

interface Props {
  /** window: the desktop app's floating window, which draws its own card; modal: inside the app's Modal. */
  mode: 'window' | 'modal';
  /** Put it away; the draft stays. */
  onDismiss: () => void;
  /** Open an agent's conversation in the main window. */
  onOpenAgent: (agentId: string) => void;
  /** The window reports the card's height so it can take it (desktop only). */
  onHeight?: (height: number) => void;
  /** Called with a focus function, so the window can focus the field each time it shows. */
  registerFocus?: (focus: () => void) => void;
}

export function QuickComposer({ mode, onDismiss, onOpenAgent, onHeight, registerFocus }: Props) {
  const snapshot = useApp(s => s.snapshot);
  const connection = useApp(s => s.connection);
  const agents = snapshot?.agents ?? [];
  const superId = snapshot?.super.agentId ?? null;
  const [target, setTarget] = useState<QuickTarget>(readTarget);
  const [draft, setDraft] = useState(readDraft);
  const [picker, setPicker] = useState<Picker>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  // A target whose agent was removed falls back to the SuperAgent.
  const live: QuickTarget = target.kind === 'agent' && snapshot && !agents.some(a => a.id === target.agentId) ? { kind: 'super' } : target;
  const replyId = targetAgentId(live, superId);
  const replier = agents.find(a => a.id === replyId);
  const entries = useApp(s => (replyId ? s.entries[replyId] : undefined));
  const project = live.kind === 'new' ? snapshot?.projects.find(p => p.id === live.projectId) : undefined;

  // The same @ picker as the agent composer: agents, projects and files (the target's workspace, or
  // the new agent's project), and the same mention notes when sent (shared/mentions.ts on the server).
  const [caret, setCaret] = useState(() => readDraft().length);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const hints = useMentionHints();
  const caretAfter = useRef<number | null>(null);
  const token = picker === null && snapshot ? mentionTokenAt(draft, caret, mentionNames(agents, snapshot.projects)) : null;
  const mentionOpen = Boolean(token) && token?.start !== dismissedAt;
  const agentFiles = useAgentFiles(replyId ?? '', mentionOpen && Boolean(replyId));
  const newProjects = useMemo(() => (live.kind === 'new' && project ? [project] : []), [live.kind, project]);
  const projectFiles = useProjectsFiles(newProjects, mentionOpen && newProjects.length > 0);
  const fileSource = replyId ? agentFiles : projectFiles;
  const folders = useMemo(() => {
    // A new agent works in its project's folder: its files are relative to that, as in its own composer.
    const files = replyId ? agentFiles.value?.files ?? [] : project ? (projectFiles.value?.files ?? []).map(f => f.slice(project.name.length + 1)) : [];
    return withFolders(files);
  }, [replyId, agentFiles.value, projectFiles.value, project]);
  const picks = useMemo(() => (mentionOpen && token
    ? rankMentions({ agents: agents.filter(a => a.id !== replyId), projects: snapshot?.projects ?? [], files: folders, query: token.query })
    : []), [mentionOpen, token?.query, agents, replyId, snapshot?.projects, folders]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = Math.min(highlight, Math.max(0, picks.length - 1));
  useEffect(() => { setHighlight(0); }, [token?.query]);
  const pickMention = (choice: MentionPick) => {
    if (!token) return;
    hints.add(choice, token.start);
    const next = replaceToken(draft, token, '@', pickValue(choice));
    caretAfter.current = next.caret;
    setDraft(next.text);
    setCaret(next.caret);
  };
  // A pick moves the caret past what it wrote, once the new text is in the field.
  useLayoutEffect(() => {
    if (caretAfter.current == null) return;
    field.current?.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [draft]);

  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, draft); } catch { /* private mode */ } }, [draft]);
  useEffect(() => { try { localStorage.setItem(TARGET_KEY, JSON.stringify(target)); } catch { /* private mode */ } }, [target]);
  useEffect(() => { if (replyId) void loadEntries(replyId); }, [replyId]);

  const focusField = () => requestAnimationFrame(() => field.current?.focus());
  useEffect(() => {
    focusField();
    registerFocus?.(focusField);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The field grows with what you write, up to FIELD_MAX, then scrolls.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(FIELD_MAX, el.scrollHeight)}px`;
  }, [draft, live.kind]);

  useCardMotion(card, panel, picker, onHeight);

  // Esc closes an open picker first, then puts the composer away; Cmd+K, Cmd+P and Cmd+. open the pickers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mentionOpen && token) {
          e.preventDefault();
          e.stopPropagation();
          setDismissedAt(token.start);
        } else if (picker) {
          e.preventDefault();
          e.stopPropagation();
          setPicker(null);
          focusField();
        } else if (mode === 'window') {
          e.preventDefault();
          onDismiss();
        }
        return;
      }
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const which: Picker = e.code === 'KeyK' ? 'target' : e.code === 'KeyP' ? 'project' : e.code === 'Period' ? 'model' : null;
      if (!which) return;
      e.preventDefault();
      e.stopPropagation();
      setPicker(current => (current === which ? null : which));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picker, mode, onDismiss, mentionOpen, token?.start]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (open: boolean) => {
    if (busy || !draft.trim() || !snapshot) return;
    setBusy(true);
    setError('');
    try {
      const { agentId } = await sendQuick(live, draft, { agents, superId }, api, hints.for(draft));
      setDraft('');
      setCaret(0);
      hints.clear();
      // A new agent is the one to follow now; the next message goes to it too.
      if (live.kind === 'new') setTarget({ kind: 'agent', agentId });
      void loadEntries(agentId, true);
      if (open) onOpenAgent(agentId);
    } catch (err) {
      setError((err as Error).message || 'That did not go through.');
    } finally {
      setBusy(false);
      focusField();
    }
  };

  const onFieldKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // An open @ picker takes the arrows, Tab and a plain Enter; Cmd+Enter still sends and opens.
    if (mentionOpen && picks.length && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((active + (e.key === 'ArrowDown' ? 1 : picks.length - 1)) % picks.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        pickMention(picks[active]);
        return;
      }
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit(IS_MAC ? e.metaKey : e.ctrlKey);
  };

  const pick = (next: QuickTarget) => {
    setTarget(next);
    setPicker(null);
    setError('');
    focusField();
  };
  const asNew = (change: Partial<Extract<QuickTarget, { kind: 'new' }>>): QuickTarget => ({
    kind: 'new',
    projectId: live.kind === 'new' ? live.projectId : snapshot?.projects[0]?.id ?? null,
    engine: live.kind === 'new' ? live.engine : 'claude',
    model: live.kind === 'new' ? live.model : '',
    ...change,
  });

  const placeholder = live.kind === 'super' ? (superId ? 'Ask the SuperAgent, or tell it what to do next' : 'Ask the SuperAgent. It is set up when you send.')
    : live.kind === 'agent' ? `Message ${replier?.name ?? 'the agent'}`
    : `Describe the task for a new agent ${project ? `in ${project.name}` : 'across all projects'}`;

  const surface = mode === 'window'
    ? 'rounded-[16px] border border-content/10 bg-background-base'
    : '';

  return (
    <div ref={card} data-quick-composer className={cx('relative flex max-h-[680px] flex-col overflow-clip font-sans text-content', surface)}>
      {mode === 'window' ? (
        // A thin strip to drag the window by, as MonoCode's.
        <div data-window-drag aria-hidden className="group absolute inset-x-0 top-0 z-10 flex h-3 items-start justify-center pt-1">
          <span className="h-0.5 w-6 rounded-full bg-content/12 transition-colors group-hover:bg-content/30" />
        </div>
      ) : null}

      <header className="flex shrink-0 items-center gap-2 px-4 pt-3.5">
        <ToolbarButton active={picker === 'target'} onClick={() => setPicker(p => (p === 'target' ? null : 'target'))} title={`Who to talk to (${MOD}K)`}>
          <TargetIcon target={live} agent={replier} />
          <span className="truncate font-medium text-content/85">{targetName(live, replier)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        </ToolbarButton>
        {live.kind === 'agent' && replier ? <AgentStateLine agent={replier} /> : null}
        <span className="flex-1" />
        {live.kind === 'new' ? (
          <ToolbarButton active={picker === 'project'} onClick={() => setPicker(p => (p === 'project' ? null : 'project'))} title={`Project (${MOD}P)`}>
            <Folder className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
            <span className="truncate">{project?.name ?? 'All projects'}</span>
            <ChevronDown className="size-3 shrink-0 opacity-50" />
          </ToolbarButton>
        ) : null}
        {mode === 'window' ? (
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={onDismiss} className="grid size-6 shrink-0 place-items-center rounded-md text-content/35 transition-colors hover:bg-selection-hover hover:text-content">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
      </header>

      {!snapshot ? (
        <p className="px-5 pb-1 pt-4 text-[13px] text-content/45">{connection === 'closed' ? 'Waiting for AgentsCode on this machine…' : 'Connecting to AgentsCode…'}</p>
      ) : (
        <>
          <TeamStrip agents={agents} onOpen={onOpenAgent} />
          {/* Mail held for the SuperAgent, as its pane shows it. */}
          {snapshot.super.held ? (
            <p role="status" data-quick-held className="mx-3.5 mt-2.5 shrink-0 rounded-[10px] bg-content/[0.03] px-3 py-2 text-[12px] leading-relaxed text-content/60">{heldText(snapshot.super.held)}</p>
          ) : null}
          <Asks asks={openAsks(snapshot.super.asks)} />
          <Reply target={live} agent={replier} entries={entries} />
        </>
      )}

      <div className="relative shrink-0">
        <textarea
          ref={field}
          aria-label={placeholder}
          value={draft}
          rows={1}
          disabled={!snapshot}
          onChange={e => { setDraft(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); if (error) setError(''); }}
          onSelect={e => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={onFieldKey}
          aria-autocomplete="list"
          aria-expanded={mentionOpen}
          placeholder={placeholder}
          className="scrollbar-none block w-full resize-none bg-transparent px-5 pb-2.5 pt-3.5 text-[15px] leading-6 text-content outline-none placeholder:text-content/35"
        />
      </div>

      {mentionOpen ? (
        <div className="shrink-0 px-3 pb-2">
          <MentionPicker
            picks={picks}
            query={token?.query ?? ''}
            active={active}
            loading={fileSource.loading}
            truncated={fileSource.value?.truncated}
            onActive={setHighlight}
            onPick={pickMention}
          />
        </div>
      ) : null}

      <footer className="flex shrink-0 items-center gap-1.5 border-t border-stroke px-3 py-2">
        {live.kind === 'new' ? (
          <ToolbarButton active={picker === 'model'} onClick={() => setPicker(p => (p === 'model' ? null : 'model'))} title={`Engine and model (${MOD}.)`}>
            <EngineIcon engine={live.engine} className="size-3.5 shrink-0" />
            <span className="truncate">{modelName(live.engine, live.model, snapshot?.models[live.engine]?.models)}</span>
            <ChevronDown className="size-3 shrink-0 opacity-50" />
          </ToolbarButton>
        ) : (
          <ToolbarButton onClick={() => pick(asNew({}))} title={`Start a new agent instead (${MOD}P for its project)`}>
            <Plus className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
            <span>New agent</span>
          </ToolbarButton>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-3 text-[11px] text-content/40">
          {error ? <span role="alert" title={error} className="min-w-0 truncate text-danger">{error}</span> : (
            <>
              <Hint keys="↵">send</Hint>
              <Hint keys={`${MOD}↵`}>send and open</Hint>
              <Hint keys="⇧↵">new line</Hint>
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => void submit(false)}
          disabled={busy || !draft.trim() || !snapshot}
          aria-label="Send"
          className="primary-action ml-1 grid size-7 shrink-0 place-items-center rounded-lg transition-[transform,opacity] duration-150 active:scale-[0.96] disabled:opacity-35"
        >
          {busy ? <TerminalSpinner /> : <ArrowUp className="size-3.5" strokeWidth={2.25} />}
        </button>
      </footer>

      {picker ? (
        <div ref={panel} key={picker} className="flex min-h-0 flex-col border-t border-stroke">
          {picker === 'target' ? (
            <PickerList
              placeholder="Talk to…"
              onClose={() => { setPicker(null); focusField(); }}
              items={[
                { key: 'super', label: 'SuperAgent', hint: superId ? 'Runs the team' : 'Set up when you send', icon: <AvatarGlyph look={SUPER_LOOK} seed="super" className="size-3.5" />, checked: live.kind === 'super', onPick: () => pick({ kind: 'super' }) },
                ...[...agents].filter(a => a.role !== 'super').sort((a, b) => a.name.localeCompare(b.name)).map(a => ({
                  key: a.id, label: a.name, hint: `${projectLabel(a.projectIds, snapshot?.projects, 'All projects')} · ${stateWord(a)}`,
                  icon: <AgentAvatar agent={a} className="size-3.5" />, checked: live.kind === 'agent' && live.agentId === a.id, onPick: () => pick({ kind: 'agent', agentId: a.id }),
                })),
                { key: 'new', label: 'New agent…', hint: `${MOD}P picks its project`, icon: <Plus className="size-3.5" strokeWidth={1.75} />, checked: live.kind === 'new', onPick: () => pick(asNew({})) },
              ]}
            />
          ) : picker === 'project' ? (
            <PickerList
              placeholder="Start a new agent in…"
              onClose={() => { setPicker(null); focusField(); }}
              items={[
                ...(snapshot?.projects ?? []).map(p => ({
                  key: p.id, label: p.name, hint: p.path, icon: <Folder className="size-3.5" strokeWidth={1.75} />,
                  checked: live.kind === 'new' && live.projectId === p.id, onPick: () => pick(asNew({ projectId: p.id })),
                })),
                { key: 'all', label: 'All projects', hint: 'Works across every project', icon: <Folder className="size-3.5 opacity-50" strokeWidth={1.75} />, checked: live.kind === 'new' && live.projectId === null, onPick: () => pick(asNew({ projectId: null })) },
              ]}
            />
          ) : (
            <PickerList
              placeholder="Engine and model…"
              onClose={() => { setPicker(null); focusField(); }}
              items={ENGINES.filter(e => snapshot?.engines[e].available).flatMap(engine => [
                { key: `${engine}:`, label: `${ENGINE_NAMES[engine]} · Default`, hint: snapshot?.models[engine]?.defaultLabel || '', icon: <EngineIcon engine={engine} className="size-3.5" />, checked: live.kind === 'new' && live.engine === engine && !live.model, onPick: () => pick(asNew({ engine, model: '' })) },
                ...(snapshot?.models[engine]?.models ?? []).map(m => ({
                  key: `${engine}:${m.value}`, label: `${ENGINE_NAMES[engine]} · ${m.label}`, hint: m.group ?? m.description, icon: <EngineIcon engine={engine} className="size-3.5" />,
                  checked: live.kind === 'new' && live.engine === engine && live.model === m.value, onPick: () => pick(asNew({ engine, model: m.value })),
                })),
              ])}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The card's height, sent to the window as it changes (the window's top edge stays fixed), and a
 * short ease when a picker opens or closes, so the card grows rather than jumps.
 */
function useCardMotion(card: React.RefObject<HTMLDivElement | null>, panel: React.RefObject<HTMLDivElement | null>, picker: Picker, onHeight?: (height: number) => void) {
  const last = useRef<number | null>(null);
  const previous = useRef(picker);
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    let sent = -1;
    const fit = () => {
      const height = el.getBoundingClientRect().height;
      last.current = height;
      const rounded = Math.ceil(height);
      if (rounded === sent) return;
      sent = rounded;
      onHeight?.(rounded);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [card, onHeight]);
  useLayoutEffect(() => {
    if (previous.current === picker) return;
    previous.current = picker;
    const el = card.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = last.current;
    const to = el.getBoundingClientRect().height;
    const grow = from != null && Math.abs(from - to) > 0.5 ? el.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 220, easing: EASE }) : null;
    const fade = panel.current?.animate([{ opacity: 0, transform: 'translateY(-2px)' }, { opacity: 1, transform: 'none' }], { duration: 160, delay: 40, easing: 'ease-out', fill: 'backwards' });
    return () => { grow?.cancel(); fade?.cancel(); };
  }, [picker, card, panel]);
}

function ToolbarButton({ active = false, title, onClick, children }: { active?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx('flex h-7 min-w-0 max-w-[45%] items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors duration-150', active ? 'bg-selection-emphasis text-content' : 'text-content/65 hover:bg-selection-hover hover:text-content')}
    >
      {children}
    </button>
  );
}

function Hint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 max-[560px]:hidden">
      <kbd className="rounded border border-content/12 px-1 font-sans text-[10px] leading-4 text-content/55">{keys}</kbd>
      {children}
    </span>
  );
}

function TargetIcon({ target, agent }: { target: QuickTarget; agent: Agent | undefined }) {
  if (target.kind === 'super') return <AvatarGlyph look={SUPER_LOOK} seed="super" className="size-3.5" />;
  if (target.kind === 'new') return <Plus className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />;
  return agent ? <AgentAvatar agent={agent} className="size-3.5" /> : null;
}

function targetName(target: QuickTarget, agent: Agent | undefined): string {
  if (target.kind === 'super') return 'SuperAgent';
  if (target.kind === 'new') return 'New agent';
  return agent?.name ?? 'Agent';
}

function modelName(engine: EngineKind, model: string, models: { value: string; label: string }[] | undefined): string {
  if (!model) return `${ENGINE_NAMES[engine]} · Default`;
  return `${ENGINE_NAMES[engine]} · ${models?.find(m => m.value === model)?.label ?? model}`;
}

function stateWord(agent: Agent): string {
  if (agent.status === 'working') return agent.activity || 'Working';
  if (agent.status === 'waiting') return 'Needs you';
  if (agent.status === 'error') return 'Hit a problem';
  if (agent.status === 'done') return 'Done';
  return 'Idle';
}

function AgentStateLine({ agent }: { agent: Agent }) {
  return <span className="min-w-0 truncate text-[12px] text-content/40">{stateWord(agent)}</span>;
}

/** A small mark for each state: the same marks the sidebar and palette use. */
function StateMark({ state }: { state: TeamState }) {
  if (state === 'working') return <TerminalSpinner className="text-content/45" />;
  const dot = {
    'needs-you': 'bg-warning',
    stuck: 'border border-warning bg-transparent',
    failed: 'bg-danger',
    done: 'bg-content/45',
    idle: 'bg-content/15',
  }[state];
  return <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', dot)} />;
}

const STATE_LABEL: Record<TeamState, string> = { 'needs-you': 'Needs you', stuck: 'Stuck', working: 'Working', failed: 'Failed', done: 'Done', idle: 'Idle' };
const STRIP_MAX = 6;

/** Who is doing what; a click opens that agent in the main window. */
function TeamStrip({ agents, onOpen }: { agents: Agent[]; onOpen: (agentId: string) => void }) {
  const approvals = useApp(s => s.snapshot?.approvals);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const team = useMemo(() => teamStatus(agents, approvals ?? [], now), [agents, approvals, now]);
  if (!team.length) return null;
  const shown = team.slice(0, STRIP_MAX);
  return (
    <div aria-label="Your agents" className="flex shrink-0 flex-wrap items-center gap-1 px-3.5 pt-2.5">
      {shown.map((member: TeamMember) => (
        <button
          key={member.id}
          type="button"
          onClick={() => onOpen(member.id)}
          title={`${member.name}: ${STATE_LABEL[member.state]}. ${member.detail}`}
          className="flex h-6 max-w-44 items-center gap-1.5 rounded-md px-1.5 text-[12px] text-content/60 transition-colors hover:bg-selection-hover hover:text-content"
        >
          {/* Its avatar, its mood from its status; the state mark when the agent is not in the snapshot. */}
          {agents.find(a => a.id === member.id) ? <AgentAvatar agent={agents.find(a => a.id === member.id)!} className="size-3.5" /> : <StateMark state={member.state} />}
          <span className="truncate">{member.name}</span>
          {member.state === 'needs-you' || member.state === 'stuck' || member.state === 'failed' ? <span className="shrink-0 text-content/40">{STATE_LABEL[member.state].toLowerCase()}</span> : null}
        </button>
      ))}
      {team.length > shown.length ? <span className="px-1 text-[12px] text-content/35">+{team.length - shown.length} more</span> : null}
    </div>
  );
}

/** The SuperAgent's open questions, answerable here. */
function Asks({ asks }: { asks: SuperAsk[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!asks.length) return null;
  const answer = async (ask: SuperAsk, choice: string | null) => {
    setBusy(ask.id);
    await attempt(() => answerQuick(api, ask.id, choice));
    setBusy(null);
  };
  const shown = asks.slice(0, 3);
  return (
    <div aria-label="The SuperAgent asks" className="flex shrink-0 flex-col gap-1.5 px-3.5 pt-2.5">
      {shown.map(ask => (
        <div key={ask.id} data-quick-ask={ask.id} className="rounded-[10px] border border-content/8 bg-content/[0.03] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-5 text-content/90">{ask.question}</p>
              {ask.detail ? <p className="mt-0.5 line-clamp-3 text-[12px] leading-relaxed text-content/50">{ask.detail}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {ask.options.map((option, i) => (
                  <button
                    key={option}
                    type="button"
                    disabled={busy === ask.id}
                    onClick={() => void answer(ask, option)}
                    className={cx('h-6 rounded-md px-2 text-[12px] transition-colors disabled:opacity-40', i === 0 ? 'primary-action font-medium' : 'border border-content/12 text-content/75 hover:bg-selection-hover hover:text-content')}
                  >
                    {option}
                  </button>
                ))}
                <button type="button" disabled={busy === ask.id} onClick={() => void answer(ask, null)} className="h-6 rounded-md px-1.5 text-[12px] text-content/40 transition-colors hover:text-content/75 disabled:opacity-40">Not now</button>
              </div>
            </div>
          </div>
        </div>
      ))}
      {asks.length > shown.length ? <p className="px-1 text-[11px] text-content/35">{asks.length - shown.length} more in the SuperAgent's tab</p> : null}
    </div>
  );
}

/** The latest exchange with the target: your last message and its reply as it streams. */
function Reply({ target, agent, entries }: { target: QuickTarget; agent: Agent | undefined; entries: Entry[] | undefined }) {
  const exchange = useMemo(() => {
    const list = entries ?? [];
    const lastUser = list.findLastIndex(e => e.kind === 'user');
    const after = lastUser >= 0 ? list.slice(lastUser + 1) : list;
    const reply = [...after].reverse().find(e => e.kind === 'agent');
    const problem = [...after].reverse().find(e => e.kind === 'error');
    return { asked: lastUser >= 0 ? list[lastUser] : undefined, reply, problem };
  }, [entries]);
  if (target.kind === 'new') {
    return <p className="shrink-0 px-5 pt-3 text-[12px] leading-relaxed text-content/45">A new agent starts with this as its first task. It gets a name and appears in the sidebar.</p>;
  }
  if (!agent) return null;
  const working = agent.status === 'working';
  const { asked, reply, problem } = exchange;
  if (!asked && !reply && !working) {
    return target.kind === 'super'
      ? <p className="shrink-0 px-5 pt-3 text-[12px] leading-relaxed text-content/45">It watches every agent, decides next steps by what it knows about you, and asks when it needs you. It never edits code itself.</p>
      : null;
  }
  return (
    <div className="mx-3.5 mt-2.5 flex min-h-0 shrink flex-col rounded-[10px] bg-content/[0.03]">
      {asked ? <p className="truncate px-3 pt-2 text-[12px] text-content/40" title={asked.text}>You: {asked.text}</p> : null}
      <div className="min-h-0 max-h-56 overflow-y-auto overscroll-contain px-3 pb-2.5 pt-1.5">
        {reply ? <Markdown text={reply.text} words={working} className="text-[13px] leading-relaxed" /> : null}
        {problem && !working ? <p className="text-[12px] text-danger">{problem.text}</p> : null}
        {working ? (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-content/45">
            <TerminalSpinner className="text-content/45" />
            <span className="truncate">{agent.activity || 'Thinking'}</span>
          </p>
        ) : !reply && !problem ? <p className="text-[12px] text-content/40">Waiting to start…</p> : null}
      </div>
    </div>
  );
}

/** A picker: a filter box and a list; Up and Down move, Enter picks. Esc is handled by the composer. */
function PickerList({ items, placeholder, onClose }: {
  items: { key: string; label: string; hint?: string; icon?: ReactNode; checked?: boolean; onPick: () => void }[];
  placeholder: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter(i => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q)) : items;
  }, [items, query]);
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex(i => i.checked)));
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setIndex(i => Math.min(i, Math.max(0, shown.length - 1))); }, [shown.length]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); shown[index]?.onPick(); }
    else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
  };
  return (
    <>
      <label className="flex shrink-0 items-center gap-2 px-4 py-2 text-content/45">
        <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input autoFocus value={query} onChange={e => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKey} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/35" />
      </label>
      <div ref={list} role="listbox" aria-label={placeholder} className="min-h-0 max-h-64 overflow-y-auto overscroll-contain px-2 pb-2">
        {shown.length ? shown.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === index}
            data-index={i}
            onMouseMove={() => setIndex(i)}
            onClick={item.onPick}
            className={cx('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-100', i === index ? 'bg-selection-hover text-content' : 'text-content/75')}
          >
            <span className="grid size-4 shrink-0 place-items-center text-content/60">{item.icon}</span>
            <span className="min-w-0 shrink-0 truncate">{item.label}</span>
            {item.hint ? <span className="min-w-0 flex-1 truncate text-[11px] text-content/40">{item.hint}</span> : <span className="flex-1" />}
            {item.checked ? <Check className="size-3.5 shrink-0 text-content/70" strokeWidth={2.25} /> : null}
          </button>
        )) : <p className="px-2 py-2 text-[12px] text-content/45">Nothing matches.</p>}
      </div>
    </>
  );
}
