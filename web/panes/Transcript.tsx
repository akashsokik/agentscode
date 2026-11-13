/**
 * The agent transcript, laid out the way MonoCode's AgentTranscript lays out a turn:
 * the prompt, a fold line that keeps time while the agent works and folds the work
 * away when it is done, the answer, and a row of turn actions. The markup of each
 * row (UserMessageBlock, WorkFoldLine, TurnRow, ActivityToolRow, ToolCallSummary,
 * InterjectionDivider, ApprovalControls, TurnDuration, DaySeparator) follows MonoCode.
 *
 * While a turn runs, MonoCode's motion follows it too: work the agent has written past folds behind
 * the fold line, the work in flight sits in a short live window whose steps arrive in beats (the rail
 * runs on, branches, and the row rises in), new prose fades in word by word, and a prompt you send
 * rises into place at the top of the view before the rest of its turn fades in under it.
 */
import { formatKeys, type KeySpec } from '../keys.ts';
import { Kbd } from '../ui/Kbd.tsx';
import { IS_MAC } from '../platform.ts';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Agent, Approval, Entry, ToolCall, TurnMeta } from '../../shared/types.ts';
import { turnMetricsText } from '../../shared/turnUsage.ts';
import { foldableWork, groupTurnItems, isDreamLine, keptInView, memoryLine, turnItemKey, walkthroughResult, workKind, workSummaryLine, type TurnItem } from '../activity.ts';
import { api } from '../api.ts';
import { modelLabel } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { browserScreenshot, presentTool } from '../toolPresentation.ts';
import { groupTurns, type Turn } from '../turns.ts';
import { isAnchoring, openingAnchor, rememberedView, rememberView, type Opening } from '../transcriptView.ts';
import { distanceFromEnd, Follower, scrollsUp, WHEEL_HOLD_MS } from '../transcriptScroll.ts';
import { Markdown } from '../ui/Markdown.tsx';
import { MentionText } from '../ui/MentionText.tsx';
import { reducedMotion, staggerWordFades, WORD_FADE_MS } from '../ui/wordFade.ts';
import { ChipButton, cx, Empty, INPUT, Loading, TextButton } from '../ui/common.tsx';
import { AiIdea, ChartBreakoutSquare, Check, ChevronDown, ChevronRight, Copy, Eraser, File, Folder, MessageSquare, Route, Search, Sparkles } from '../mono/icons.tsx';
import { StatusMark } from '../ui/StatusMark.tsx';
import { MarkTile, PhaseTile } from '../mono/ActivityTile.tsx';
import { Popover } from '../mono/Popover.tsx';
import { RevealHeight } from '../mono/RevealHeight.tsx';
import { Shimmer } from '../mono/Shimmer.tsx';
import { MessageImages } from './ImageViews.tsx';
import { Comms, DelegationRow, EDGE, GUTTER, PeerPrompt, PeerTrailRow } from './PeerMessages.tsx';
import { approvalKeyAction, approvalText } from '../approvalText.ts';
import { commsIndex, repeatedPromptTurns } from '../peerText.ts';
import { AgentAvatar } from '../ui/Avatar.tsx';

/**
 * Whether something with this id is landing now, as opposed to having been on screen already or
 * having been there when the transcript opened. Only arrivals animate, so history never replays.
 */
const Arrivals = createContext<(id: string) => boolean>(() => false);

/** Captures, on mount, whether `id` is arriving; later renders keep that answer. */
function useArriving(id: string): boolean {
  const arriving = useContext(Arrivals);
  const [value] = useState(() => arriving(id));
  return value;
}

// ---- formatting (MonoCode AgentTranscript helpers) -------------------------

export function dayStamp(at: number, now = Date.now()): [string, string] {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = same(date, today) ? 'Today' : same(date, yesterday) ? 'Yesterday'
    : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return [day, formatClockTime(at)];
}

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatElapsed(elapsedMs: number | null): string | null {
  if (elapsedMs == null) return null;
  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** The turn clock, as the words after the agent's name: "worked for 8s", "working for 12s". */
function formatWorkingDuration(elapsedMs: number | null, done = false): string {
  const verb = done ? 'worked' : 'working';
  const elapsed = formatElapsed(elapsedMs);
  if (elapsed == null) return done ? verb : `${verb}…`;
  return `${verb} for ${elapsed}`;
}

/** The agent's model as the turn clock names it; the CLI default stays unnamed. */
function useModelName(agent: Agent): string | undefined {
  const label = useApp(s => modelLabel(agent, s.snapshot?.models[agent.engine]));
  return label === 'Default' ? undefined : label;
}

function useElapsedFrom(startedAt: number | undefined, paused: boolean): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [paused]);
  return startedAt == null ? null : Math.max(0, now - startedAt);
}

// ---- rows ------------------------------------------------------------------

export function DaySeparator({ at }: { at: number }) {
  const [day, time] = dayStamp(at);
  return (
    // Plain text, no pill: each header under it carries its own time.
    <div role="separator" aria-label={`${day} ${time}`} title={`${day} ${time}`} data-day-separator className="px-4 pb-3 pt-6 text-center font-sans text-[11.5px] leading-4 text-content/40">
      {day}
    </div>
  );
}

export function CopyTurnButton({ text, label = 'Copy response' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      className="-ml-1 rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          if (timer.current != null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check className="size-3.5" strokeWidth={1.75} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    </button>
  );
}

/**
 * MonoCode's UserMessageBlock, chat layout: your message as a bubble on the right, a pill while
 * it fits on one line and rounded once it wraps. Copy and the time show under it on hover.
 */
export function UserMessageBlock({ entry, media, caption, actions, footer, className = 'pb-5 pt-1.5' }: {
  entry: Pick<Entry, 'id' | 'agentId' | 'text' | 'ts' | 'images' | 'mentions'>;
  /** Shown above the bubble in place of the entry's own images (a channel post's uploads). */
  media?: ReactNode;
  caption?: ReactNode;
  /** More buttons in the hover row, after Copy (a channel post's Reply in thread). */
  actions?: ReactNode;
  /** Under the message and its caption, above the hover row (a channel post's deliveries and thread). */
  footer?: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [singleLine, setSingleLine] = useState(true);
  const textRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => {
      const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
      setSingleLine(el.scrollHeight <= line + 1);
      if (!expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [entry.text, expanded]);
  return (
    <div data-prompt-anchor={entry.id} className={`user-message-row group/usermsg flex flex-col items-end overflow-visible pl-14 pr-4 ${className}`}>
      <div className="user-message-hover-zone flex w-fit min-w-0 max-w-full flex-col items-end overflow-visible">
        {media ?? (entry.images?.length ? <MessageImages agentId={entry.agentId} images={entry.images} /> : null)}
        {/* A message can be images alone; then there is no bubble. */}
        {entry.text ? (
          <div data-chat-message={entry.id} data-chat-message-role="user" className={`user-message-bubble relative w-fit min-w-0 max-w-[min(100%,36rem)] bg-content/10 px-3 py-2 font-sans text-content transition-[background-color] duration-200 ${singleLine && !overflows ? 'rounded-full' : 'rounded-xl'}`}>
            <pre ref={textRef} className={`min-w-0 whitespace-pre-wrap break-words font-sans text-sm ${expanded ? '' : 'line-clamp-4'}`}><MentionText text={entry.text} refs={entry.mentions} agentId={entry.agentId || undefined} /></pre>
            {overflows ? (
              <TextButton aria-expanded={expanded} className="mt-1 -ml-1" onClick={() => setExpanded(v => !v)}>
                {expanded ? 'Show less' : 'Show more'}
              </TextButton>
            ) : null}
          </div>
        ) : null}
        {caption ? (
          <div className="flex max-w-full items-center gap-2 px-3 pt-1 font-sans text-xs text-content/50"><span role="status">{caption}</span></div>
        ) : null}
        {footer}
        <div className="user-message-actions flex items-center gap-1 px-3 pt-1">
          {entry.text ? <CopyTurnButton text={entry.text} label="Copy message" /> : null}
          {actions}
          <time dateTime={new Date(entry.ts).toISOString()} title={new Date(entry.ts).toLocaleString()} className="ml-1 font-sans text-xs text-content/40">
            {formatClockTime(entry.ts)}
          </time>
        </div>
      </div>
    </div>
  );
}

/** Where a user prompt came from, when it was a channel post. */
function ChannelCaption({ channelId, queued }: { channelId: string; queued?: boolean }) {
  const name = useApp(s => s.snapshot?.channels.find(c => c.id === channelId)?.name);
  return (
    <span className="flex items-center gap-2">
      {queued ? <span>Queued</span> : null}
      <button type="button" disabled={!name} onClick={() => openToSide({ kind: 'channel', channelId })} className="hover:text-content disabled:hover:text-content/50">
        {name ? `Posted in #${name}` : 'Posted in a deleted channel'}
      </button>
    </span>
  );
}

/** MonoCode's pill: a search pattern or one step of a chained command, 24px tall. */
function Pill({ children, title, onOpen, className = '' }: { children: ReactNode; title?: string; onOpen?: () => void; className?: string }) {
  const base = `flex h-6 min-w-0 max-w-[200px] shrink items-center gap-1 rounded-md bg-content/6 font-mono text-[12px] ${className}`;
  if (!onOpen) return <span title={title} className={base}>{children}</span>;
  return (
    <button
      type="button"
      title={title}
      aria-label={title ? `Open ${title}` : undefined}
      className={`${base} cursor-pointer text-left hover:text-[var(--link-color)]`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {children}
    </button>
  );
}

/** What did not fit: "+3", outlined so it reads as a count, not one more step. */
function MorePill({ rest, failed, what }: { rest: string[]; failed: boolean; what: string }) {
  const list = rest.join(', ');
  return (
    <span title={list} aria-label={`${rest.length} more ${what}: ${list}`} className={`flex h-6 shrink-0 items-center rounded-md border border-content/12 px-1.5 font-mono text-[12px] ${failed ? 'text-danger' : 'text-content/50'}`}>
      +{rest.length}
    </span>
  );
}

/** Actions whose target is code: a command, a URL or a query. */
const MONO_TARGETS = new Set(['Run', 'Fetch', 'Search the web']);

/**
 * MonoCode's ToolCallSummary (tools.rs): the verb, then what it acted on. A command shows bare in
 * mono, or as a chip per step when it chains several; a search shows its patterns as pills; a file
 * is a chip that opens it.
 */
function ToolCallSummary({ tool, failed, agentId }: { tool: ToolCall; failed: boolean; agentId: string }) {
  const shown = presentTool(tool);
  const actionTone = failed ? 'text-danger' : 'text-content/50';
  const targetTone = failed ? 'text-danger' : 'text-content/70';
  const openFile = (path: string, diff = false) => open({ kind: diff ? 'diff' : 'file', root: { agent: agentId }, path });
  let body: ReactNode = null;
  if (shown.chips) {
    const rest = shown.chips.slice(3).map(chip => chip.label);
    body = (
      <>
        {shown.description ? <span title={shown.description} className="min-w-16 shrink truncate font-sans text-sm">{shown.description}</span> : null}
        {shown.chips.slice(0, 3).map((chip, index) => (
          <Pill key={index} title={chip.path ?? chip.label} onOpen={chip.path ? () => openFile(chip.path!) : undefined} className="px-1.5">
            {chip.action === 'Read' ? <File className="size-3.5 shrink-0" strokeWidth={1.75} />
              : chip.action === 'List' ? <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
              : chip.action === 'Find' ? <Search className="size-3 shrink-0 text-content/45" strokeWidth={2} />
              : null}
            <span className="min-w-0 truncate">{chip.label}</span>
          </Pill>
        ))}
        {rest.length ? <MorePill rest={rest} failed={failed} what="steps" /> : null}
      </>
    );
  } else if (shown.patterns?.length) {
    const rest = shown.patterns.slice(2);
    body = (
      <>
        {shown.patterns.slice(0, 2).map((pattern, index) => (
          <Pill key={index} title={pattern} className="px-2"><span className="min-w-0 truncate">{pattern}</span></Pill>
        ))}
        {rest.length ? <MorePill rest={rest} failed={failed} what="patterns" /> : null}
      </>
    );
  } else if (shown.file) {
    const { path, diff, folder } = shown.file;
    body = (
      <button
        type="button"
        title={path}
        aria-label={`Open ${path}`}
        className="-my-0.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded bg-content/6 px-1 py-0.5 text-left font-mono text-[12px] hover:text-[var(--link-color)]"
        onClick={(event) => {
          event.stopPropagation();
          openFile(path, diff);
        }}
      >
        {folder ? <Folder className="size-3.5 shrink-0" strokeWidth={1.75} /> : <File className="size-3.5 shrink-0" strokeWidth={1.75} />}
        <span className="min-w-0 truncate">{shown.target}</span>
      </button>
    );
  } else if (shown.target) {
    body = <span title={shown.target} className={`min-w-0 truncate ${MONO_TARGETS.has(shown.action) ? 'font-mono text-[12px]' : 'font-sans text-sm'}`}>{shown.target}</span>;
  }
  // A plain command needs no verb: the command says what it ran.
  const label = shown.action === 'Run' && body ? null : shown.action;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-sans text-sm" title={body ? undefined : tool.name}>
      {label ? <span className={`shrink-0 ${actionTone}`}>{label}</span> : null}
      {body ? <span className={`flex min-w-0 items-center gap-1.5 ${targetTone}`}>{body}</span> : null}
    </span>
  );
}

/** MonoCode's ActivityToolRow with ToolCall's expandable output. Rows are bare; only a failure is marked. */
function ActivityToolRow({ entry, agentId }: { entry: Entry; agentId: string }) {
  const [open, setOpen] = useState(false);
  const tool = entry.tool!;
  const failed = tool.status === 'error';
  const detail = [tool.detail, tool.output].filter(Boolean).join('\n\n').trim();
  const expandable = Boolean(detail) && detail !== tool.summary;
  const shot = browserScreenshot(tool);
  return (
    <div className="flex min-w-0 flex-col">
      <div
        aria-label={`Tool call: ${tool.name} ${tool.summary}`}
        onClick={expandable ? () => setOpen(v => !v) : undefined}
        className={`group flex min-h-7 min-w-0 items-center gap-1.5 py-1 ${expandable ? 'cursor-pointer' : ''}`}
      >
        <ToolCallSummary tool={tool} failed={failed} agentId={agentId} />
        {failed ? <StatusMark state="fail" className="size-3.5" label="Failed" /> : null}
        {/* The row toggles on click; this is the keyboard way in, since the row holds the file chip's own button. */}
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide the output' : 'Show the output'}
            onClick={(event) => { event.stopPropagation(); setOpen(v => !v); }}
            className="grid shrink-0 place-items-center rounded p-1 outline-none hover:bg-content/8"
          >
            <ChevronRight className={`size-3.5 transition-transform ${failed ? 'text-danger/60' : 'text-content/40'} ${open ? 'rotate-90' : ''}`} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
      {shot ? (
        <a href={`/api/agents/${agentId}/browser-shots/${shot}`} target="_blank" rel="noreferrer" className="mb-1 mt-0.5 block w-fit" title="Open the screenshot">
          <img src={`/api/agents/${agentId}/browser-shots/${shot}`} alt="Browser screenshot" loading="lazy" className="max-h-48 max-w-[320px] rounded-md border border-content/10 object-contain object-left-top" />
        </a>
      ) : null}
      {open && expandable ? (
        <pre className={`min-w-0 whitespace-pre-wrap break-words py-1 font-mono text-[12px] leading-5 ${failed ? 'text-danger/80' : 'text-content/55'}`}>{detail}</pre>
      ) : null}
    </div>
  );
}

/** MonoCode's ActivityStatusRow. */
function ActivityStatusRow({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 py-1">
      <span title={text} className="min-w-0 flex-1 truncate font-sans text-sm text-content/50">{text.trim()}</span>
    </div>
  );
}

/** One step of a turn's work: a tool call, a teammate message or a status line. */
function WorkRow({ entry, selfId }: { entry: Entry; selfId: string }) {
  if (entry.kind === 'tool') return <ActivityToolRow entry={entry} agentId={selfId} />;
  if (entry.kind === 'peer' && entry.peer) return <PeerTrailRow message={entry.peer} selfId={selfId} />;
  return <ActivityStatusRow text={entry.text} />;
}

/**
 * The agent's prose. A block that lands while you watch fades in word by word, top to bottom; the
 * fade comes off once the last word is in, so folding the block away and back never replays it.
 */
function ProseBlock({ entry }: { entry: Entry }) {
  const reveal = useArriving(entry.id);
  const [fading, setFading] = useState(reveal);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!reveal) return;
    const el = root.current;
    if (!el || reducedMotion()) {
      setFading(false);
      return;
    }
    const lastStart = staggerWordFades(el);
    const timer = window.setTimeout(() => setFading(false), lastStart + WORD_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [reveal]);
  return (
    <div ref={root} className={fading ? 'word-fading' : undefined}>
      <Markdown text={entry.text} words={reveal} />
    </div>
  );
}

/*
 * A burst of steps arrives one after another. The first few play at STEP_ENTRANCE_MS; a queue
 * running past STEP_QUEUE_CALM_MS plays the rest faster, down to STEP_ENTRANCE_MIN_MS by
 * STEP_QUEUE_MS, so a long burst still catches up. (MonoCode's AgentTranscript values.)
 */
const STEP_ENTRANCE_MS = 480;
const STEP_ENTRANCE_MIN_MS = 160;
const STEP_QUEUE_CALM_MS = 960;
const STEP_QUEUE_MS = 2000;

type StepTurn = { wait: number; pace: number };

/**
 * MonoCode's useStepQueue: how long each arriving step waits for the one before it to finish, and
 * how long its own entrance then takes. A step keeps the turn it was first given.
 */
function useStepQueue() {
  const queue = useRef({ next: 0, turns: new Map<string, StepTurn>() });
  return (id: string) => {
    const { turns } = queue.current;
    let turn = turns.get(id);
    if (!turn) {
      const now = performance.now();
      const start = Math.max(now, queue.current.next);
      const wait = start - now;
      const backlog = (STEP_QUEUE_MS - wait) / (STEP_QUEUE_MS - STEP_QUEUE_CALM_MS);
      const pace = Math.max(STEP_ENTRANCE_MIN_MS, STEP_ENTRANCE_MS * Math.min(1, backlog));
      queue.current.next = start + pace;
      turn = { wait, pace };
      turns.set(id, turn);
    }
    return turn;
  };
}

/**
 * MonoCode's PhaseStep: one step on a group's rail. A step that lands while you watch makes room
 * first (what is below glides down, the rail runs into the gap and branches off) and only then does
 * the row rise in. One that lands behind others stays out of the layout until its turn.
 */
function PhaseStep({ live, turn: arrival, children }: { live: boolean; turn?: StepTurn; children: ReactNode }) {
  const [turn] = useState(arrival);
  const [stage, setStage] = useState<'waiting' | 'entering' | 'settled'>(() => (!turn || reducedMotion() ? 'settled' : turn.wait > 0 ? 'waiting' : 'entering'));

  useEffect(() => {
    if (stage !== 'waiting' || !turn) return;
    const timer = window.setTimeout(() => setStage('entering'), turn.wait);
    return () => window.clearTimeout(timer);
  }, [stage, turn]);

  // A missed animationend (the pane hidden mid-entrance) must not leave the row clipped.
  useEffect(() => {
    if (stage !== 'entering' || !turn) return;
    const timer = window.setTimeout(() => setStage('settled'), turn.pace + 120);
    return () => window.clearTimeout(timer);
  }, [stage, turn]);

  return (
    <div
      className="zen-phase-step"
      style={turn ? ({ '--step-ms': `${Math.round(turn.pace)}ms` } as CSSProperties) : undefined}
      data-live={live || undefined}
      data-waiting={stage === 'waiting' || undefined}
      data-entering={stage === 'entering' || undefined}
      onAnimationEnd={(event) => {
        // The row's own rise is the last beat.
        if (event.animationName === 'zen-step-in' && (event.target as Element).parentElement === event.currentTarget) setStage('settled');
      }}
    >
      {children}
    </div>
  );
}

function markScrollEdges(el: HTMLElement) {
  const below = el.scrollHeight - el.clientHeight - el.scrollTop;
  el.dataset.fadeTop = String(el.scrollTop > 1);
  el.dataset.fadeBottom = String(below > 1);
}

/**
 * Keeps a live group's window on its newest step, including while an arriving step's slot opens.
 * Scrolling up inside the window holds it there until you scroll back to the end.
 */
function useLivePhaseScroll(el: HTMLDivElement | null, enabled: boolean, steps: number) {
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (!el || !enabled) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    markScrollEdges(el);
  }, [el, enabled, steps]);

  useEffect(() => {
    if (!el || !enabled) return;
    stick.current = true;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
      markScrollEdges(el);
    };
    const follow = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      markScrollEdges(el);
    });
    el.addEventListener('scroll', onScroll, { passive: true });
    if (el.firstElementChild) follow.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', onScroll);
      follow.disconnect();
    };
  }, [el, enabled]);
}

/** A group that is one teammate message and nothing else (a delegation this agent sent has its own row). */
function isLonePeerRow(entries: Entry[], selfId: string): boolean {
  const entry = entries[0];
  return entries.length === 1 && entry.kind === 'peer' && Boolean(entry.peer) && !(entry.peer!.delegation && entry.peer!.fromAgentId === selfId);
}

/**
 * MonoCode's ActivityPhaseGroup: a run of work under one line saying what it adds up to, led by a
 * tile coloured by that work, its steps on a rail dropping from the tile. The group the agent is in
 * stays open as a short window pinned to the newest step, its tile spinning; the moment the agent
 * moves on it folds back to its line. A click overrides either way. Even one tool call gets its
 * line ("Ran a command"), as in MonoCode, so a run of chips never floats without its verb.
 */
function ActivityPhaseGroup({ entries, active, selfId, trailing }: { entries: Entry[]; active: boolean; selfId: string; trailing?: ReactNode }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useLivePhaseScroll(scroller, active && open, entries.length);
  const arriving = useContext(Arrivals);
  const turnFor = useStepQueue();
  const title = workSummaryLine(entries, active);
  const kind = workKind(entries);

  // A lone message or status line is its own summary; a line over it would say it twice.
  if (entries.length === 1 && entries[0].kind !== 'tool') {
    // A teammate message on its own is a quiet line with no tile: an arrow, who, and how it came out.
    if (isLonePeerRow(entries, selfId)) return <PeerTrailRow message={entries[0].peer!} selfId={selfId} lead trailing={trailing} />;
    return (
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-[5px]"><PhaseTile kind={kind} folds={false} /></span>
        <div className="min-w-0 flex-1">
          <WorkRow entry={entries[0]} selfId={selfId} />
        </div>
      </div>
    );
  }

  const label = active ? (
    <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>{title}</Shimmer>
  ) : (
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/80">{title}</span>
  );
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? `Hide the steps for ${title}` : `Show the steps for ${title}`}
        onClick={() => setOverride(!open)}
        className={`tile-host group flex w-full min-w-0 items-center gap-2 py-1 text-left${open ? ' zen-phase-drop' : ''}`}
      >
        {/* A running phase keeps its spinner unless pointed at; a settled open one keeps the chevron. */}
        <PhaseTile kind={kind} open={open && !active} spinning={active && !reducedMotion()} />
        {label}
      </button>
      <div className="zen-phase-body" data-open={open}>
        {open ? (
          <div ref={setScroller} className={active ? 'zen-phase-live' : undefined}>
            <div className="flex min-w-0 flex-col">
              {entries.map(entry => (
                <PhaseStep key={entry.id} live={active} turn={active && arriving(entry.id) ? turnFor(entry.id) : undefined}>
                  <WorkRow entry={entry} selfId={selfId} />
                </PhaseStep>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** MonoCode's TurnRow: animate one fold open or closed, then release its contents. */
function TurnRow({ folded, children }: { folded: boolean; children: ReactNode | (() => ReactNode) }) {
  const [foldState, setFoldState] = useState<'open' | 'opening' | 'closing' | 'closed'>(folded ? 'closed' : 'open');
  useLayoutEffect(() => {
    setFoldState(current => {
      if (folded) return current === 'closed' ? current : 'closing';
      return current === 'open' ? current : 'opening';
    });
  }, [folded]);
  useEffect(() => {
    if (foldState !== 'opening' && foldState !== 'closing') return;
    const timer = window.setTimeout(() => setFoldState(folded ? 'closed' : 'open'), 350);
    return () => window.clearTimeout(timer);
  }, [foldState, folded]);
  if (folded && foldState === 'closed') return null;
  return (
    <div
      className="zen-fold-item"
      data-fold-state={foldState}
      inert={folded}
      onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget) return;
        setFoldState(folded ? 'closed' : 'open');
      }}
    >
      <div>
        <div className="pb-1">{typeof children === 'function' ? children() : children}</div>
      </div>
    </div>
  );
}

/** MonoCode's LiveFoldTitle: the shimmering clock while the agent works. */
function LiveFoldTitle({ startedAt, paused, waitingLabel }: { startedAt?: number; paused: boolean; waitingLabel?: string }) {
  const elapsedMs = useElapsedFrom(startedAt, paused);
  const text = paused ? (waitingLabel ?? 'waiting for approval') : formatWorkingDuration(elapsedMs, false);
  return <Shimmer className="min-w-0 truncate" duration={1}>{text}</Shimmer>;
}

/**
 * MonoCode's WorkFoldLine, read as a sentence: the agent's avatar in the gutter, its name, the clock
 * ("worked for 2m 17s"), the model as a quiet suffix and the time the turn landed at the right. The
 * work folds behind it.
 */
function WorkFoldLine({ title, agent, model, at, live, expandable, open, onToggle }: {
  title: ReactNode;
  agent: Agent;
  /** The model's name, when it has one. */
  model?: string;
  /** When the turn settled. */
  at?: number;
  live: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  // Only a fold that opens shows the chevron; a line over work that has not folded keeps the mark.
  // Only the turn running now moves and shows the mood; past turns stay calm and still.
  const icon = <MarkTile mark={<AgentAvatar agent={live ? agent : { id: agent.id, role: agent.role, avatar: agent.avatar }} animate={live} className="size-[22px]" />} folds={expandable} open={open} />;
  const label = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-sans text-[12.5px]">
      <span className="shrink-0 font-semibold text-content/90">{agent.name}</span>
      {live ? title : <span className="min-w-0 truncate text-content/45 transition-colors duration-200 group-hover:text-content/80">{title}</span>}
      {model ? <span className="shrink-0 text-content/30">· {model}</span> : null}
      {at != null ? (
        <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="ml-auto shrink-0 pl-2 text-[11.5px] tabular-nums text-content/30">{formatClockTime(at)}</time>
      ) : null}
    </span>
  );
  const row = `tile-host flex w-full min-w-0 items-center gap-2 px-4 py-1 text-left${open ? ' zen-fold-drop' : ''}`;
  if (!expandable) {
    return <div className={`group ${row}`} role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}>{icon}{label}</div>;
  }
  return (
    <button type="button" aria-expanded={open} aria-label={open ? 'Hide the work' : 'Show the work'} aria-live={live ? 'polite' : undefined} onClick={onToggle} className={`group ${row}`}>
      {icon}{label}
    </button>
  );
}

/** MonoCode's TurnMetricsBadge: cache hit, output speed and token counts for this turn, on hover. */
function TurnMetricsBadge({ meta }: { meta?: TurnMeta }) {
  const root = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const text = turnMetricsText(meta);
  if (!text) return null;
  const { headline, detail } = text;
  return (
    <div ref={root} className="relative ml-[3px] shrink-0" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setHovered(true)} onBlur={() => setHovered(false)}>
      <span role="img" tabIndex={0} aria-label={`Turn metrics: ${[headline, detail].filter(Boolean).join('. ')}`} title="Turn metrics" className="grid rounded-md p-1 text-content/40 outline-none hover:bg-content/8 hover:text-content/70">
        <ChartBreakoutSquare className="size-3.5" strokeWidth={1.75} />
      </span>
      {hovered ? (
        <Popover anchor={root} side="top" align="start" className="pointer-events-none w-max px-2.5 py-1.5">
          <div className="text-[12px] leading-4 text-content">{headline}</div>
          {detail ? <div className="text-[11px] leading-4 text-content/50">{detail}</div> : null}
        </Popover>
      ) : null}
    </div>
  );
}

/** MonoCode's TurnDuration: what you can do with a finished turn, and when it landed. */
function TurnDuration({ elapsedMs, labelHidden, copyText, completedAt, meta, agent, inline = false }: {
  elapsedMs: number | null;
  /** The fold line above already says who worked for how long, and when. */
  labelHidden: boolean;
  copyText?: string;
  completedAt?: number;
  meta?: TurnMeta;
  agent: Agent;
  /** Just the buttons, to sit at the right of the turn's closing row. */
  inline?: boolean;
}) {
  const label = `${agent.name} ${formatWorkingDuration(elapsedMs, true)}`;
  const dot = <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-content/25" />;
  const buttons = (
    <span className="flex shrink-0 items-center gap-1">
      {copyText ? <CopyTurnButton text={copyText} /> : inline ? null : <StatusMark state="pass" quiet className="size-3.5" />}
      <TurnMetricsBadge meta={meta} />
    </span>
  );
  // Quiet until the turn is pointed at (styles.css, [data-turn-actions]).
  if (inline) return <span data-turn-actions aria-label={label} className="flex shrink-0 items-center font-sans text-sm text-content/40">{buttons}</span>;
  return (
    <div data-turn-actions aria-label={label} className={cx(EDGE, 'flex w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden pb-3 pt-1 font-sans text-sm text-content/40')}>
      {buttons}
      {labelHidden ? null : (
        <>
          <span className="flex min-w-0 items-center gap-2.5">
            {dot}
            <span className="flex min-w-0 items-center gap-1.5">
              <AgentAvatar agent={agent} className="size-3.5" animate={false} />
              <span className="min-w-0 truncate" title={label}>{label}</span>
            </span>
          </span>
          {completedAt != null ? (
            <span className="flex shrink-0 items-center gap-2.5">
              {dot}
              <span className="shrink-0 text-content/35">{formatClockTime(completedAt)}</span>
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Whether a menu, picker or dialog is open: then Enter and Esc belong to it. */
function overlayOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]'));
}

/** When an approval in a pane was last answered, so a second Enter does not answer the next one too. */
const answeredAt = new WeakMap<Element, number>();

/** Whether `el` is laid out and wholly inside its scroller's view (and the window's). */
function inView(el: Element | null, scroller: Element | null): boolean {
  if (!el || !el.getClientRects().length) return false;
  const rect = el.getBoundingClientRect();
  const view = scroller?.getBoundingClientRect();
  const top = Math.max(0, view?.top ?? 0);
  const bottom = Math.min(window.innerHeight, view?.bottom ?? window.innerHeight);
  return rect.height > 0 && rect.top >= top && rect.bottom <= bottom;
}

/**
 * A tool call or plan waiting on the user, in the conversation's own flow: the agent's avatar in the
 * gutter, "needs your OK" beside its name, and the question as a sentence in the soft plate a
 * teammate's message gets. Only a read-only lookup's raw input waits behind "Show details"; a
 * command, a diff or any other tool's input shows up front, since that is what you are allowing.
 * Enter allows and Esc denies, for the first approval of the pane you are in while it is on screen
 * (approvalKeyAction says when). Deny by its button can carry a note.
 */
function ApprovalRow({ approval }: { approval: Approval }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [details, setDetails] = useState(false);
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === approval.agentId));
  const root = useRef<HTMLDivElement>(null);
  const decide = (allow: boolean, always = false, message?: string) => attempt(() => api.resolveApproval(approval.id, { allow, always, message }));
  const plan = approval.type === 'plan';
  const deny = () => void decide(false, false, note.trim() || undefined);
  const text = approvalText(approval);

  useEffect(() => {
    const shownAt = performance.now();
    const pane = root.current?.closest('section') ?? null;
    const onKey = (event: KeyboardEvent) => {
      const el = root.current;
      if (!el || !pane) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const field = target?.closest<HTMLElement>('input, textarea, select, [contenteditable="true"]') ?? null;
      // The composer marks itself idle once it has held neither text nor images for a moment (Composer.tsx).
      const idleComposer = field instanceof HTMLTextAreaElement && Boolean(field.closest('[data-composer]')) && pane.contains(field) && field.hasAttribute('data-idle');
      // Something else took the key (a menu, a picker). The idle composer always takes Enter, to
      // send nothing, so there the key is still ours.
      if (event.defaultPrevented && !idleComposer) return;
      const action = approvalKeyAction({
        key: event.key,
        modified: event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing,
        focus: !target || target === document.body || target === document.documentElement ? 'none' : pane.contains(target) ? 'pane' : 'elsewhere',
        paneFocused: pane.hasAttribute('data-pane-focused'),
        onScreen: inView(el.querySelector('[data-approval-allow]'), el.closest('.agent-transcript')),
        first: pane.querySelector('[data-approval]') === el,
        settledForMs: performance.now() - Math.max(shownAt, answeredAt.get(pane) ?? 0),
        typing: Boolean(field) && !idleComposer,
        // A button or link with focus takes Enter itself.
        overlay: overlayOpen() || Boolean(target?.closest('button, a, summary')),
      });
      if (!action) return;
      event.preventDefault();
      void attempt(() => api.resolveApproval(approval.id, { allow: action === 'allow' }));
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // This one is answered (or gone): the next in its pane waits a moment before keys reach it.
      if (pane) answeredAt.set(pane, performance.now());
    };
  }, [approval.id]);

  // Inside a chip button the key reads quietly, as the chip's own text (ACH-D26).
  const key = (spec: KeySpec) => <Kbd spec={spec} quiet className="font-normal opacity-80" />;
  return (
    <div ref={root} data-approval={approval.id} className={cx(GUTTER, 'px-4 py-1.5 font-sans')}>
      <AgentAvatar agent={agent ?? { id: approval.agentId }} className="size-[22px]" />
      <div role="group" aria-label={plan ? 'Plan waiting for your approval' : 'Action waiting for your approval'} className="flex min-w-0 flex-col items-start">
        <div className="flex h-[22px] w-full min-w-0 items-center gap-1.5 text-[12.5px]">
          {agent ? <span className="shrink-0 font-semibold text-content/90">{agent.name}</span> : null}
          <span className="min-w-0 truncate text-warning">{plan ? 'has a plan for your OK' : 'needs your OK'}</span>
          <time dateTime={new Date(approval.createdAt).toISOString()} title={new Date(approval.createdAt).toLocaleString()} className="ml-auto shrink-0 pl-2 text-[11.5px] tabular-nums text-content/30">{formatClockTime(approval.createdAt)}</time>
        </div>
        <div className="mt-1 w-fit min-w-[min(100%,22rem)] max-w-[min(100%,40rem)] rounded-xl bg-content/[0.055] px-3 py-2.5">
          <p className="min-w-0 break-words text-sm leading-5.5 text-content" title={approval.title}>
            {text.target ? <>{text.lead} <span className="font-semibold">{text.target}</span>?</> : text.lead}
          </p>
          {text.path ? <p className="mt-0.5 truncate font-mono text-[11.5px] leading-5 text-content/45" title={text.path}>{text.path}</p> : null}
          {plan && approval.plan ? (
            <div className="mt-2 min-w-0"><Markdown text={approval.plan} /></div>
          ) : text.shown ? (
            <pre className="mt-1.5 max-h-72 min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-content/60">{text.shown}</pre>
          ) : null}
          {approval.description ? <p className="mt-1.5 text-xs text-warning">{approval.description}</p> : null}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <ChipButton primary data-approval-allow title={`${plan ? 'Approve plan' : 'Allow'} (${formatKeys('Enter', IS_MAC)})`} onClick={() => void decide(true)}>{plan ? 'Approve plan' : 'Allow'} {key('Enter')}</ChipButton>
            {approval.canAlwaysAllow ? <ChipButton onClick={() => void decide(true, true)}>Always allow</ChipButton> : null}
            <ChipButton
              aria-expanded={plan ? undefined : noting}
              title={`${plan ? 'Keep planning' : 'Deny'} (${formatKeys('Escape', IS_MAC)}), or click to say why`}
              onClick={() => (noting ? deny() : setNoting(true))}
              className="bg-transparent text-content/60 hover:bg-content/10"
            >
              {plan ? 'Keep planning' : 'Deny'} {key('Escape')}
            </ChipButton>
            {text.hidden ? (
              <TextButton aria-expanded={details} className="ml-auto" onClick={() => setDetails(v => !v)}>{details ? 'Hide details' : 'Show details'}</TextButton>
            ) : null}
          </div>
          {details && text.hidden ? (
            <pre className="mt-2 max-h-72 min-w-0 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[12px] leading-5 text-content/55">{text.hidden}</pre>
          ) : null}
          {noting ? (
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); deny(); }}>
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={plan ? 'What should change in the plan? (optional)' : 'What should it do instead? (optional)'}
                className={INPUT}
              />
              <ChipButton type="submit">Send</ChipButton>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---- one turn ----------------------------------------------------------------

/** An approval that lands while you watch grows open; one already waiting is just there. */
function ArrivingApproval({ approval }: { approval: Approval }) {
  const arriving = useArriving(approval.id);
  return (
    <RevealHeight animateIn={arriving}>
      <ApprovalRow approval={approval} />
    </RevealHeight>
  );
}

/**
 * What the agent remembered or forgot, as one quiet line: "Remembered: the user wants no emojis".
 * The text is what it saved; the agent settings list every entry, to edit or delete.
 */
/** What a dream did, as one quiet line like a memory line: "Dreamed: +2 -1 ~1, soul change proposed". */
function DreamLine({ entry }: { entry: Entry }) {
  const rest = entry.text.replace(/^Dreamed:\s*/, '');
  return (
    <div data-dream-line={entry.id} className="flex min-w-0 items-start gap-1.5 py-1 font-sans text-sm">
      <Sparkles className="mt-[3px] size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
      <span className="min-w-0 text-content/50">Dreamed{rest ? <>: <span className="text-content/80">{rest}</span></> : null}</span>
    </div>
  );
}

/** What create_walkthrough made: a card that opens the walkthrough beside the agent. */
function WalkthroughCard({ entry, agentId }: { entry: Entry; agentId: string }) {
  if (!entry.tool) return null;
  const made = walkthroughResult(entry.tool);
  if (!made) {
    const failed = entry.tool.status === 'error';
    return (
      <div className="flex min-w-0 items-start gap-1.5 py-1 font-sans text-sm">
        <Route className={`mt-[3px] size-3.5 shrink-0 ${failed ? 'text-danger' : 'text-content/45'}`} strokeWidth={1.75} />
        <span className={`min-w-0 ${failed ? 'text-danger' : 'text-content/50'}`}>
          {entry.tool.status === 'running' ? <Shimmer className="inline" duration={1.6}>Making a walkthrough</Shimmer> : failed ? 'Walkthrough not saved' : 'Made a walkthrough'}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      data-walkthrough-card={made.id}
      onClick={() => openToSide({ kind: 'walkthrough', agentId, id: made.id, title: made.title })}
      className="my-1.5 flex w-full max-w-md min-w-0 items-center gap-3 rounded-xl border border-content/10 bg-content/[0.03] px-3.5 py-2.5 text-left font-sans transition-colors duration-150 hover:border-content/20 hover:bg-content/[0.06]"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-content/10 bg-content/5 text-content/60">
        <Route className="size-4" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-content">{made.title}</span>
        <span className="block text-[11.5px] text-content/45">Walkthrough{made.stepCount ? `, ${made.stepCount} steps` : ''}</span>
      </span>
      <span className="shrink-0 text-[12px] text-content/55">Open</span>
    </button>
  );
}

function MemoryLine({ entry }: { entry: Entry }) {
  if (!entry.tool) return null;
  const { verb, text } = memoryLine(entry.tool);
  const Icon = /forget$/.test(entry.tool.name) ? Eraser : AiIdea;
  const failed = entry.tool.status === 'error';
  return (
    <div data-memory-line={entry.id} className="flex min-w-0 items-start gap-1.5 py-1 font-sans text-sm">
      <Icon className={`mt-[3px] size-3.5 shrink-0 ${failed ? 'text-danger' : 'text-content/45'}`} strokeWidth={1.75} />
      <span className={`min-w-0 ${failed ? 'text-danger' : 'text-content/50'}`}>
        {entry.tool.status === 'running' ? <Shimmer className="inline" duration={1.6}>{verb}</Shimmer> : verb}
        {text ? <>: <span className={failed ? undefined : 'text-content/80'}>{text}</span></> : null}
      </span>
    </div>
  );
}

/** One item of a turn outside its fold: prose at full size, a memory line, or a group of work. */
function TurnItemView({ item, active, selfId, underLine, trailing }: { item: TurnItem; active: boolean; selfId: string; underLine: boolean; trailing?: ReactNode }) {
  if (item.type === 'memory') return <div className={EDGE}><MemoryLine entry={item.entry} /></div>;
  if (item.type === 'dream') return <div className={EDGE}><DreamLine entry={item.entry} /></div>;
  if (item.type === 'walkthrough') return <div className={EDGE}><WalkthroughCard entry={item.entry} agentId={selfId} /></div>;
  if (item.type === 'delegation') return <div className={EDGE}><DelegationRow message={item.entry.peer!} /></div>;
  if (item.type === 'prose') {
    return (
      <div data-chat-message={item.entry.id} data-chat-message-role="assistant" className={`min-w-0 ${EDGE} pb-1 text-content ${underLine ? 'pt-1' : 'pt-3'}`}>
        <ProseBlock entry={item.entry} />
      </div>
    );
  }
  return <ArrivingGroup item={item} active={active} selfId={selfId} trailing={trailing} />;
}

/** A group that opens while you watch grows in under the line above it. */
function ArrivingGroup({ item, active, selfId, trailing }: { item: Extract<TurnItem, { type: 'activity' }>; active: boolean; selfId: string; trailing?: ReactNode }) {
  const arriving = useArriving(item.entries[0].id);
  return (
    <RevealHeight animateIn={arriving && active} className={EDGE}>
      <ActivityPhaseGroup entries={item.entries} active={active} selfId={selfId} trailing={trailing} />
    </RevealHeight>
  );
}

/** One item inside the fold, on its rail: a closed group, or the agent's commentary one notch quieter. */
function FoldItemView({ item, selfId }: { item: TurnItem; selfId: string }) {
  if (item.type === 'memory') return <MemoryLine entry={item.entry} />;
  if (item.type === 'dream') return <DreamLine entry={item.entry} />;
  if (item.type === 'walkthrough') return <WalkthroughCard entry={item.entry} agentId={selfId} />;
  if (item.type === 'delegation') return <DelegationRow message={item.entry.peer!} />;
  if (item.type === 'prose') return <div className="py-1"><Markdown text={item.entry.text} /></div>;
  return <ActivityPhaseGroup entries={item.entries} active={false} selfId={selfId} />;
}

function TurnView({ turn, agent, live, waiting, approvals, workOpen, onToggleWork, caption, enter, repeatOf }: {
  turn: Turn;
  /** The same teammate message an earlier turn already ran, delivered again: when that turn started. */
  repeatOf?: number;
  agent: Agent;
  live: boolean;
  waiting: boolean;
  approvals: Approval[];
  workOpen: boolean;
  onToggleWork: () => void;
  /** Overrides the prompt's caption, for one that has not started yet. */
  caption?: ReactNode;
  /** A turn landing while you watch fades up into place. */
  enter: boolean;
}) {
  const [entering] = useState(enter);
  const done = turn.items.findLast(e => e.kind === 'done');
  const errors = turn.items.filter(e => e.kind === 'error');
  const items = useMemo(() => groupTurnItems(turn.items), [turn.items]);
  const fold = foldableWork(items);
  const rest = fold ? items.slice(fold.end + 1) : items;
  // What it remembered stays in sight when the work around it folds away.
  const kept = workOpen ? [] : keptInView(items, fold);
  const lastProse = items.findLast(item => item.type === 'prose');
  const settled = !live && Boolean(done || errors.length);
  const settledAt = done?.ts ?? errors.at(-1)?.ts ?? turn.items.at(-1)?.ts;
  const elapsedMs = done?.meta?.durationMs ?? errors.at(-1)?.meta?.durationMs ?? (settledAt ? settledAt - turn.startedAt : null);
  const who = useModelName(agent);
  // The fold line is the turn's status line from the first token to the last. It never moves, so a
  // turn settling does not shuffle the layout around the answer.
  const showFoldLine = live || items.length > 0 || settled;

  const actions = (inline: boolean) => (
    <TurnDuration
      agent={agent}
      elapsedMs={elapsedMs ?? null}
      labelHidden={showFoldLine}
      copyText={lastProse?.type === 'prose' ? lastProse.entry.text : undefined}
      completedAt={settledAt}
      meta={done?.meta ?? errors.at(-1)?.meta}
      inline={inline}
    />
  );
  // A turn that ends on a quiet teammate line (its report going out) shares that row with its actions.
  const tail = rest.at(-1);
  const sharesRow = settled && !errors.length && !approvals.length && tail?.type === 'activity' && isLonePeerRow(tail.entries, agent.id);

  const prompt = turn.prompt;
  const promptCaption = caption ?? (prompt?.kind === 'user' && prompt.channel ? <ChannelCaption channelId={prompt.channel.id} /> : undefined);
  const body = (
    <>
      <TurnRow folded={!showFoldLine}>
        <WorkFoldLine
          agent={agent}
          live={live}
          expandable={Boolean(fold)}
          open={Boolean(fold) && workOpen}
          onToggle={onToggleWork}
          model={who}
          at={settled ? settledAt : undefined}
          title={live
            ? <LiveFoldTitle startedAt={agent.turnStartedAt ?? turn.startedAt} paused={waiting} />
            : formatWorkingDuration(elapsedMs, true)}
        />
      </TurnRow>
      {fold ? (
        <TurnRow folded={!workOpen}>
          {() => items.slice(fold.start, fold.end + 1).map((item, offset, folded) => (
            <div
              key={turnItemKey(item)}
              className={`flow-root pb-1 pl-[30px] last:pb-0 zen-fold-rail${offset === folded.length - 1 ? ' zen-fold-tail' : ''}${item.type === 'prose' ? ' zen-fold-prose' : ''}`}
            >
              <div className="pl-4 pr-4">
                <FoldItemView item={item} selfId={agent.id} />
              </div>
            </div>
          ))}
        </TurnRow>
      ) : null}
      {kept.map(item => (
        <div key={turnItemKey(item)} className="flow-root pb-1">
          <TurnItemView item={item} selfId={agent.id} active={false} underLine={false} />
        </div>
      ))}
      {rest.map((item, index) => (
        <div key={turnItemKey(item)} className="flow-root pb-1">
          <TurnItemView
            item={item}
            selfId={agent.id}
            // Only the last group can still be the one the agent is in.
            active={live && index === rest.length - 1}
            underLine={index === 0 && showFoldLine}
            trailing={sharesRow && index === rest.length - 1 ? actions(true) : undefined}
          />
        </div>
      ))}
      {errors.map(error => (
        <div key={error.id} className={`${EDGE} py-2 text-danger`}>
          <pre className="min-w-0 whitespace-pre-wrap break-words font-sans text-sm">{error.text}</pre>
        </div>
      ))}
      {approvals.map(approval => <ArrivingApproval key={approval.id} approval={approval} />)}
      {/* The row that closes the turn carries the actions; the gap under it stays the same. */}
      {settled ? (sharesRow ? <div aria-hidden className="h-3" /> : actions(false)) : null}
    </>
  );
  // A turn not started yet (a message waiting its turn) has nothing under its prompt.
  const hasBody = showFoldLine || errors.length > 0 || approvals.length > 0 || rest.length > 0;
  return (
    <div data-transcript-turn={turn.id} className={`transcript-turn flex min-w-0 flex-col${entering ? ' transcript-turn-enter' : ''}`}>
      {prompt?.kind === 'user' ? <UserMessageBlock entry={prompt} caption={promptCaption} /> : null}
      {/* A teammate's message opens its turn as yours does; the answer follows in the same flow. */}
      {prompt?.kind === 'peer' && prompt.peer ? <PeerPrompt message={prompt.peer} arrivedAt={hasBody ? turn.startedAt : undefined} firstAt={repeatOf} /> : null}
      {body}
    </div>
  );
}

// ---- the transcript ----------------------------------------------------------

/*
 * A prompt you send rises from the upper part of the view to its place at the top, then the rest of
 * its turn fades in under it (MonoCode's riseIntoAnchor). One that cannot rise that far, because
 * it is queued behind a running turn, rises a short way from below instead.
 */
const PROMPT_RISE_MS = 560;
const PROMPT_REVEAL_MS = 320;
const PROMPT_FADE_MS = 480;
/** Where the prompt starts, as a fraction of the view's height from the top. */
const PROMPT_RISE_FROM = 0.3;
const PROMPT_NUDGE_PX = 14;
/** How long a disclosure you clicked keeps its place while what it opens or closes settles. */
const TOGGLE_HOLD_MS = 450;
/** Scrolled up to within this of the top, earlier turns load above (MonoCode's loadEarlierOnScroll). */
const LOAD_EARLIER_PX = 160;

/**
 * Whether a scroller between the event's target and the transcript can still move that way, as
 * the live work window or a wide code block can. Then the gesture is its, and following goes on.
 */
function innerScrollerTakes(scroller: HTMLElement, target: EventTarget | null, deltaY: number): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== scroller) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1) {
      const room = deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      if (room && /auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

function riseIntoPlace(scroller: HTMLElement, id: string): (() => void) | undefined {
  const row = scroller.querySelector<HTMLElement>(`[data-prompt-anchor="${CSS.escape(id)}"]`);
  if (!row || typeof row.animate !== 'function' || reducedMotion()) return;
  const view = scroller.getBoundingClientRect();
  const rise = view.top + view.height * PROMPT_RISE_FROM - row.getBoundingClientRect().top;
  const anchored = rise > 1;
  const animation = row.animate(
    [{ transform: `translateY(${anchored ? rise : PROMPT_NUDGE_PX}px)` }, { transform: 'translateY(0)' }],
    { duration: anchored ? PROMPT_RISE_MS : PROMPT_REVEAL_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  );
  // The fade gets its own gentler curve; on the rise's sharp ease-out it would be over before the eye catches it.
  const fade = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: PROMPT_FADE_MS, easing: 'ease-out' });
  // The rest of the turn waits until the prompt lands, then fades in.
  const turn = row.closest<HTMLElement>('.transcript-turn');
  let revealTimer: number | undefined;
  turn?.setAttribute('data-prompt-rise', 'rising');
  animation.onfinish = () => {
    turn?.setAttribute('data-prompt-rise', 'revealing');
    revealTimer = window.setTimeout(() => turn?.removeAttribute('data-prompt-rise'), PROMPT_REVEAL_MS);
  };
  return () => {
    animation.cancel();
    fade.cancel();
    window.clearTimeout(revealTimer);
    turn?.removeAttribute('data-prompt-rise');
  };
}

export function Transcript({ agent, entries, approvals }: { agent: Agent; entries: Entry[] | undefined; approvals: Approval[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** How this agent's transcript stood when its tab last went to the back; see transcriptView.ts. */
  const [remembered] = useState(() => rememberedView(agent.id));
  /** Whether the view follows new output; your own scroll up stops it. See transcriptScroll.ts. */
  const [follower] = useState(() => new Follower(remembered?.pinned ?? true));
  const [showAll, setShowAll] = useState(remembered?.showAll ?? false);
  /** Folds the user opened or closed; the rest stay closed. */
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => remembered?.toggled ?? new Map());
  const busy = agent.status === 'working' || agent.status === 'waiting';

  // Everything on screen when the transcript opens is history; only what lands after it animates.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null && entries !== undefined) {
    seen.current = new Set([...entries.map(e => e.id), ...approvals.map(a => a.id)]);
  }
  const arriving = useCallback((id: string) => seen.current !== null && !seen.current.has(id), []);
  useEffect(() => {
    const set = seen.current;
    if (!set) return;
    for (const entry of entries ?? []) set.add(entry.id);
    for (const approval of approvals) set.add(approval.id);
  });

  /** The latest message you typed in this pane (channel posts are not yours to follow). */
  const ownLatest = useMemo(() => entries?.findLast(e => e.kind === 'user' && !e.channel)?.id, [entries]);
  /**
   * As in MonoCode, once you send here the turn answering you fills the view, so your prompt sits at
   * the top and the reply grows under it. A transcript opened mid-turn starts that way too, and one
   * you come back to from another tab keeps it.
   */
  const opened = useRef<Opening | null>(null);
  if (opened.current === null && entries !== undefined) opened.current = openingAnchor(remembered, ownLatest, busy);
  const anchoring = opened.current !== null && isAnchoring(opened.current, ownLatest);
  useLayoutEffect(() => {
    if (opened.current !== null) rememberView(agent.id, { promptId: ownLatest, anchored: anchoring, showAll, toggled });
  });

  const { sections, queued } = useMemo(() => groupTurns(entries ?? [], agent.id), [entries, agent.id]);
  const comms = useMemo(() => commsIndex(entries ?? []), [entries]);
  const repeats = useMemo(() => repeatedPromptTurns(sections.flatMap(s => (s.type === 'turn' ? [s.turn] : []))), [sections]);
  const { visible, hidden } = useMemo(() => {
    if (showAll) return { visible: sections, hidden: 0 };
    let start = 0;
    for (let i = sections.length - 1; i > 0; i--) {
      const section = sections[i];
      if (section.type === 'note' && section.entry.sessionStart) { start = i; break; }
    }
    const capped = Math.max(start, sections.length - 80);
    return { visible: sections.slice(capped), hidden: capped };
  }, [sections, showAll]);
  const lastTurnId = useMemo(() => {
    const last = sections.findLast(s => s.type === 'turn');
    return last?.type === 'turn' ? last.turn.id : undefined;
  }, [sections]);
  // Questions are answered above the composer, as in MonoCode; tool and plan approvals sit in the turn.
  const inline = approvals.filter(a => a.type !== 'question');
  const liveTurnShown = busy && lastTurnId !== undefined && visible.some(s => s.type === 'turn' && s.turn.id === lastTurnId);

  /** Set when the transcript changed while you were scrolled up; cleared once you are back at the bottom. */
  const [missed, setMissed] = useState(false);
  /** A disclosure you just clicked, held in place while what it opens or closes settles. */
  const held = useRef<{ el: Element; top: number; until: number } | null>(null);

  /**
   * Follows new output while you are at the end, through every change of height (an arriving step
   * opening its slot, a fold closing, an image loading), not only on renders. A disclosure you just
   * clicked stays where it was instead, so what it opens grows down from it.
   */
  const follow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const hold = held.current;
    if (hold && performance.now() < hold.until && hold.el.isConnected) {
      const delta = hold.el.getBoundingClientRect().top - hold.top;
      if (Math.abs(delta) >= 1) el.scrollTop += delta;
      if (distanceFromEnd(el) <= 1) follower.resume();
      else follower.release();
      follower.track(el);
      return;
    }
    held.current = null;
    follower.follow(el, performance.now());
  }, [follower]);

  /*
   * The anchored turn is as tall as the view, less the padding, so its prompt rests where the first
   * message would. Rows under it (a teammate's message queued behind the running turn) share that
   * height, so they do not push the prompt off the top.
   */
  const fit = useCallback(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const style = getComputedStyle(inner);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const viewport = `${Math.max(0, el.clientHeight - padTop - padBottom)}px`;
    if (el.style.getPropertyValue('--transcript-viewport') !== viewport) el.style.setProperty('--transcript-viewport', viewport);
    const anchor = inner.querySelector<HTMLElement>(':scope > .transcript-turn-anchor');
    if (!anchor) return;
    const below = inner.getBoundingClientRect().bottom - padBottom - anchor.getBoundingClientRect().bottom;
    const tail = `${Math.max(0, Math.round(below))}px`;
    if (anchor.style.getPropertyValue('--transcript-tail') !== tail) anchor.style.setProperty('--transcript-tail', tail);
  }, []);

  useLayoutEffect(() => {
    fit();
    follow();
  });

  const empty = entries?.length === 0 && !busy && !queued.length && !inline.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      fit();
      follow();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [empty, fit, follow]);

  /** A gesture whose direction is not known yet holds following briefly; then it is followed again unless it went up. */
  const holdTimer = useRef<number | undefined>(undefined);
  const holdFollowing = (el: HTMLElement) => {
    follower.hold(el, performance.now());
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      if (!el.isConnected) return;
      follower.holdEnded(el);
      follow();
    }, WHEEL_HOLD_MS);
  };
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);

  // A scrollbar drag can end anywhere on the page.
  useEffect(() => {
    const up = () => {
      const el = scroller.current;
      if (el?.isConnected) follower.pointerUp(el);
    };
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    return () => {
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
  }, [follower]);

  /*
   * Earlier turns load above as you scroll up near the top, keeping the view on what you were
   * reading, as MonoCode pages its history; "Show earlier turns" does the same on a click.
   */
  const prepend = useRef<{ el: Element; top: number } | null>(null);
  const showEarlier = () => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || showAll || prepend.current) return;
    const viewTop = el.getBoundingClientRect().top;
    // The button row goes away with the reveal, so the first turn under it holds the place instead.
    const row = [...inner.children].find(child => !child.hasAttribute('data-earlier') && child.getBoundingClientRect().bottom > viewTop);
    prepend.current = row ? { el: row, top: row.getBoundingClientRect().top } : null;
    setShowAll(true);
  };
  useLayoutEffect(() => {
    const mark = prepend.current;
    prepend.current = null;
    const el = scroller.current;
    if (!mark || !el || !mark.el.isConnected) return;
    const delta = mark.el.getBoundingClientRect().top - mark.top;
    if (Math.abs(delta) >= 1) el.scrollTop += delta;
    follower.track(el);
  }, [showAll, follower]);
  /** The offset at the last scroll event, to tell which way the reader went. */
  const lastTop = useRef(0);
  /** Where a touch was, to tell a pull down (scrolling up) from a push up. */
  const touchY = useRef<number | undefined>(undefined);

  /*
   * Back from another tab, the view returns to where you left it: at the end if you were following
   * it, else as far above the end as you were (the turn may have grown meanwhile). Runs after the
   * effect above sizes the anchored turn, so the offset is not clamped against a shorter page.
   */
  const restoreFrom = useRef(remembered && !remembered.pinned ? remembered.fromBottom : null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (restoreFrom.current === null || !el || entries === undefined) return;
    const from = restoreFrom.current;
    restoreFrom.current = null;
    // A prompt you sent while the tab was away brings you to its turn, as sending always does.
    if (ownLatest !== remembered?.promptId) {
      follower.pin(el);
      return;
    }
    el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - from);
    follower.track(el);
  });

  const recordScroll = useCallback((el: HTMLElement) => {
    rememberView(agent.id, { pinned: follower.following, fromBottom: distanceFromEnd(el) });
  }, [agent.id, follower]);
  // Content can grow under a reader scrolled up without a scroll event, so take the final offset as the tab goes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    return () => {
      if (el.isConnected && el.clientHeight > 0) recordScroll(el);
    };
  }, [empty, recordScroll]);

  const jump = (smooth: boolean) => {
    const el = scroller.current;
    follower.resume();
    held.current = null;
    setMissed(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };

  // A message you typed here brings you back down and rises into place; channel posts and the first load do not.
  const own = useRef<{ ready: boolean; id?: string }>({ ready: false });
  useLayoutEffect(() => {
    if (entries === undefined) return;
    const previous = own.current;
    own.current = { ready: true, id: ownLatest };
    if (!previous.ready || !ownLatest || ownLatest === previous.id) return;
    const el = scroller.current;
    if (!el) return;
    held.current = null;
    setMissed(false);
    follower.pin(el);
    return riseIntoPlace(el, ownLatest);
    // Runs per message sent, not per entry.
  }, [ownLatest, entries === undefined]);

  const loaded = useRef(false);
  useEffect(() => {
    if (entries === undefined) return;
    if (!loaded.current) {
      loaded.current = true;
      return;
    }
    if (!follower.following) setMissed(true);
  }, [entries]);

  // A new agent: say what will land here instead of leaving the pane blank.
  if (empty) {
    return (
      <Empty icon={MessageSquare} title={`Nothing with ${agent.name} yet`}>
        Your messages, its work and its exchanges with teammates show up here.
      </Empty>
    );
  }

  /*
   * One list, so a prompt keeps its element from the moment it is sent, through the queue, into the
   * turn that answers it: turns are keyed by their prompt, and a prompt not started yet already
   * renders as the turn it will open. Moving between two lists would remount it mid-rise.
   */
  const lastTurn = visible.findLast(s => s.type === 'turn');
  /*
   * The turn that fills the view is the latest one, when you started it here: the running one, or
   * while the agent is idle, your prompt about to start. A message queued behind a running turn,
   * yours or a teammate's, does not take the view from it; it sits under it (see fit()).
   */
  const anchorPrompt = (busy ? undefined : queued.at(-1)) ?? (lastTurn?.type === 'turn' ? lastTurn.turn.prompt : undefined);
  const anchorKey = anchoring && anchorPrompt?.kind === 'user' && !anchorPrompt.channel ? anchorPrompt.id : undefined;
  const rows: ReactNode[] = [];
  const keys = new Set<string>();
  let previousDay = '';
  const turnRow = (turn: Turn, options: { live: boolean; caption?: ReactNode; approvals: Approval[] }) => {
    const preferred = turn.prompt?.id ?? turn.id;
    const key = keys.has(preferred) ? turn.id : preferred;
    keys.add(key);
    const day = new Date(turn.startedAt).toDateString();
    const stamp = day !== previousDay;
    previousDay = day;
    const workOpen = toggled.get(turn.id) ?? false;
    rows.push(
      <div key={key} className={key === anchorKey ? 'transcript-turn-anchor' : undefined}>
        {stamp ? <DaySeparator at={turn.startedAt} /> : null}
        <TurnView
          turn={turn}
          agent={agent}
          live={options.live}
          waiting={options.live && agent.status === 'waiting'}
          approvals={options.approvals}
          workOpen={workOpen}
          onToggleWork={() => setToggled(map => new Map(map).set(turn.id, !workOpen))}
          caption={options.caption}
          repeatOf={repeats.get(turn.id)}
          // Your own prompt rises instead.
          enter={arriving(key) && key !== ownLatest}
        />
      </div>,
    );
  };
  for (const section of visible) {
    if (section.type === 'note' && isDreamLine(section.entry)) {
      // A dream that ran between sessions sits between turns, as compact as inside one.
      rows.push(<div key={section.entry.id} className={EDGE}><DreamLine entry={section.entry} /></div>);
      continue;
    }
    if (section.type === 'note') {
      rows.push(
        <div key={section.entry.id} className={`${EDGE} py-2 text-content/50`}>
          <pre className="min-w-0 whitespace-pre-wrap break-words font-sans text-sm">{section.entry.text}</pre>
        </div>,
      );
      continue;
    }
    const live = busy && section.turn.id === lastTurnId;
    turnRow(section.turn, { live, approvals: live ? inline : [] });
  }
  if (!liveTurnShown) for (const approval of inline) rows.push(<ArrivingApproval key={approval.id} approval={approval} />);
  for (const entry of queued) {
    // While the agent is idle, a prompt here is about to start: it already sits as its turn, uncaptioned.
    const caption = entry.kind === 'user'
      ? entry.channel ? <ChannelCaption channelId={entry.channel.id} queued={busy} /> : busy ? 'Queued' : undefined
      : undefined;
    turnRow({ id: entry.id, prompt: entry, items: [], startedAt: entry.ts }, { live: false, caption, approvals: [] });
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (!el) return;
          const up = el.scrollTop < lastTop.current;
          lastTop.current = el.scrollTop;
          // A disclosure you clicked settles the following itself; see follow().
          if (held.current && performance.now() < held.current.until) follower.track(el);
          else if (follower.scrolled(el)) setMissed(false);
          if (up && el.scrollTop <= LOAD_EARLIER_PX && !follower.following && hidden > 0) showEarlier();
          recordScroll(el);
        }}
        onWheel={(event) => {
          const el = scroller.current;
          if (!el || innerScrollerTakes(el, event.target, event.deltaY)) return;
          if (event.deltaY === 0) holdFollowing(el);
          else follower.wheel(el, event.deltaY, performance.now());
          // A page that fits the view never scrolls, so the wheel itself asks for earlier turns.
          if (event.deltaY < 0 && el.scrollTop <= LOAD_EARLIER_PX && hidden > 0) showEarlier();
        }}
        onPointerDown={(event) => follower.pointerDown(event.target === event.currentTarget, event.pointerType === 'touch')}
        onKeyDown={(event) => {
          const el = scroller.current;
          const target = event.target as HTMLElement;
          if (!el || event.defaultPrevented || target.isContentEditable || target.closest('input, textarea, select')) return;
          if (scrollsUp(event.key, event.shiftKey) && !innerScrollerTakes(el, target, -1)) follower.release();
        }}
        onTouchStart={(event) => {
          touchY.current = event.touches[0]?.clientY;
          if (scroller.current) holdFollowing(scroller.current);
        }}
        onTouchMove={(event) => {
          const el = scroller.current;
          const next = event.touches[0]?.clientY;
          const previous = touchY.current;
          touchY.current = next;
          // A finger moving down pulls the page up.
          if (!el || next === undefined || previous === undefined || next <= previous) return;
          if (!innerScrollerTakes(el, event.target, previous - next)) follower.release();
        }}
        onClickCapture={(event) => {
          // A disclosure keeps its place while it opens or closes; see follow().
          const toggle = (event.target as Element).closest('[aria-expanded]');
          if (toggle) held.current = { el: toggle, top: toggle.getBoundingClientRect().top, until: performance.now() + TOGGLE_HOLD_MS };
        }}
        className="agent-transcript transcript-fade min-h-0 flex-1 overflow-y-auto"
      >
        <Arrivals.Provider value={arriving}>
        <Comms.Provider value={comms}>
          <div ref={content} className="mx-auto w-full max-w-3xl pb-10 pt-2">
            {entries === undefined ? <Loading /> : null}
            {hidden > 0 ? (
              <div data-earlier className="flex justify-center py-2">
                <TextButton onClick={showEarlier}>
                  Show {hidden} earlier {hidden === 1 ? 'turn' : 'turns'}
                </TextButton>
              </div>
            ) : null}
            {rows}
          </div>
        </Comms.Provider>
        </Arrivals.Provider>
      </div>
      {missed ? (
        <button
          type="button"
          onClick={() => jump(true)}
          className="toast-in absolute bottom-3 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-content/10 bg-background-base px-3 py-1 font-sans text-[12px] text-content hover:bg-selection"
        >
          <ChevronDown className="size-3.5" strokeWidth={1.75} />
          New activity, jump to latest
        </button>
      ) : null}
    </div>
  );
}

