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
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Agent, Approval, Entry, PeerMessage, ToolCall, TurnMeta } from '../../shared/types.ts';
import { turnMetricsText } from '../../shared/turnUsage.ts';
import { foldableWork, groupTurnItems, turnItemKey, workKind, workSummaryLine, type PhaseKind, type TurnItem } from '../activity.ts';
import { api } from '../api.ts';
import { modelLabel } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { groupTurns, type Turn } from '../turns.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { MentionText } from '../ui/MentionText.tsx';
import { reducedMotion, staggerWordFades, WORD_FADE_MS } from '../ui/wordFade.ts';
import { ChipButton, Empty, INPUT, Loading, StatusLabel, TextButton } from '../ui/common.tsx';
import { Bot, ChartBreakoutSquare, Check, ChevronDown, ChevronRight, CircleDashed, Copy, File, MessageSquare, Minus, PenLine, Search, Terminal, Wrench, X } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { RevealHeight } from '../mono/RevealHeight.tsx';
import { Shimmer } from '../mono/Shimmer.tsx';
import { MessageImages } from './ImageViews.tsx';

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

/** MonoCode's turn clock: "Opus 4.5 worked for 8s", or "Worked for 8s" when the model has no name. */
function formatWorkingDuration(elapsedMs: number | null, done = false, who?: string): string {
  const verb = who ? `${who} ${done ? 'worked' : 'working'}` : done ? 'Worked' : 'Working';
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
    <div role="separator" aria-label={`${day} ${time}`} data-day-separator className="flex items-center justify-center px-4 pb-3 pt-6 font-sans text-[12px]">
      <span className="rounded-full bg-content/[0.07] px-3 py-1 leading-4">
        <span className="font-semibold text-content/75">{day}</span>{' '}
        <span className="text-content/45">{time}</span>
      </span>
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
export function UserMessageBlock({ entry, caption }: { entry: Pick<Entry, 'id' | 'agentId' | 'text' | 'ts' | 'images'>; caption?: ReactNode }) {
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
    <div data-prompt-anchor={entry.id} className="user-message-row group/usermsg flex flex-col items-end overflow-visible pb-5 pl-14 pr-4 pt-1.5">
      <div className="user-message-hover-zone flex w-fit min-w-0 max-w-full flex-col items-end overflow-visible">
        {entry.images?.length ? <MessageImages agentId={entry.agentId} images={entry.images} /> : null}
        {/* A message can be images alone; then there is no bubble. */}
        {entry.text ? (
          <div data-chat-message={entry.id} data-chat-message-role="user" className={`user-message-bubble relative w-fit min-w-0 max-w-[min(100%,36rem)] bg-content/10 px-3 py-2 font-sans text-content transition-[background-color] duration-200 ${singleLine && !overflows ? 'rounded-full' : 'rounded-xl'}`}>
            <pre ref={textRef} className={`min-w-0 whitespace-pre-wrap break-words font-sans text-sm ${expanded ? '' : 'line-clamp-4'}`}><MentionText text={entry.text} /></pre>
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
        <div className="user-message-actions flex items-center gap-1 px-3 pt-1">
          {entry.text ? <CopyTurnButton text={entry.text} label="Copy message" /> : null}
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

function useChannelName(message: PeerMessage): string | undefined {
  return useApp(s => (message.channelId ? s.snapshot?.channels.find(c => c.id === message.channelId)?.name ?? 'deleted-channel' : undefined));
}

function peerLabel(message: PeerMessage, selfId: string, channel?: string): { label: string; severityText?: string; severityClass: string } {
  const incoming = message.toAgentId === selfId;
  const label = channel
    ? incoming
      ? message.replyTo ? `${message.fromName} answered in #${channel}` : `${message.fromName} mentioned you in #${channel}`
      : message.replyTo ? `Answered ${message.toName} in #${channel}` : `Mentioned ${message.toName} in #${channel}`
    : incoming
    ? message.report ? `${message.fromName} reported ${message.report.outcome}`
      : message.delegation ? `${message.fromName} delegated ${message.delegation.kind}`
      : message.replyTo ? `${message.fromName} replied`
      : message.expectsReply ? `${message.fromName} asks` : `${message.fromName} notes`
    : message.report ? `Reported ${message.report.outcome} to ${message.toName}`
      : message.delegation ? `Delegated ${message.delegation.kind} to ${message.toName}`
      : message.replyTo ? `Replied to ${message.toName}`
      : message.expectsReply ? `Asked ${message.toName}` : `Note to ${message.toName}`;
  const failed = message.status === 'failed' || message.status === 'cancelled';
  const severityText = failed ? (message.status === 'failed' ? 'Failed' : 'Cancelled')
    : message.status === 'queued' ? 'Queued' : message.status === 'delivering' ? 'Working' : undefined;
  const outcome = message.report?.outcome;
  const severityClass = failed || outcome === 'failed' ? 'text-danger' : outcome === 'blocked' ? 'text-warning' : 'text-content/55';
  return { label, severityText, severityClass };
}

const INTERJECTION_BODY = 'min-w-0 whitespace-pre-wrap break-words font-sans text-[12.5px] leading-5 text-content/70';

/** MonoCode's InterjectionDivider: a teammate's message that opens a turn, or waits for one. */
function PeerPrompt({ message, selfId }: { message: PeerMessage; selfId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => { if (!expanded) setOverflows(el.scrollHeight > el.clientHeight + 1); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [message.text, expanded]);
  const channel = useChannelName(message);
  const { label, severityText, severityClass } = peerLabel(message, selfId, channel);
  return (
    <div className="px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="h-px min-w-4 flex-1 bg-content/12" />
        <div role="separator" aria-label={`Teammate message: ${label}`} className="flex items-center gap-2 px-1.5 font-sans text-[12px] text-content/55">
          <span>{label}</span>
          {severityText ? <span className={`text-[11px] ${severityClass}`}>{severityText}</span> : null}
        </div>
        <div className="h-px min-w-4 flex-1 bg-content/12" />
      </div>
      <div className="mt-2 px-2">
        <pre ref={textRef} className={`${INTERJECTION_BODY} ${expanded ? '' : 'line-clamp-2'}`}>{message.text}</pre>
        <div className="flex items-center gap-2 pt-1">
          {overflows ? (
            <TextButton aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="-ml-1">
              {expanded ? 'Show less' : 'Show more'}
            </TextButton>
          ) : null}
          <OpenThread message={message} channel={channel} />
        </div>
      </div>
    </div>
  );
}

/** Opens where a teammate message lives: its channel, or its thread in Comms. */
function OpenThread({ message, channel }: { message: PeerMessage; channel?: string }) {
  return (
    <TextButton
      onClick={() => openToSide(message.channelId ? { kind: 'channel', channelId: message.channelId } : { kind: 'comms', conversationId: message.conversationId })}
      className="first:-ml-1"
    >
      {channel ? `Open #${channel}` : 'Open thread'}
    </TextButton>
  );
}

/** MonoCode's ActivityInterjectionRow: a teammate message inside the work trail. */
function ActivityPeerRow({ message, selfId }: { message: PeerMessage; selfId: string }) {
  const [open, setOpen] = useState(false);
  const channel = useChannelName(message);
  const { label, severityText, severityClass } = peerLabel(message, selfId, channel);
  const summary = message.text.replace(/\s+/g, ' ').trim();
  return (
    <div className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} aria-label={open ? `Hide the message: ${label}` : `${label}: ${summary}`} onClick={() => setOpen(v => !v)} className="group flex min-w-0 items-center gap-1.5 py-1 text-left">
        <span className="min-w-0 flex-1 truncate font-sans text-sm">
          <span className="text-content/55">{label}</span>
          {severityText ? <span className={`text-[11px] ${severityClass}`}> {severityText}</span> : null}
          {summary ? <span className="text-content/50 transition-colors duration-200 group-hover:text-content/75">{' · '}{summary}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="min-w-0 pb-2">
          <pre className={INTERJECTION_BODY}>{message.text}</pre>
          {message.error ? <p className="mt-1 font-sans text-xs text-danger">{message.error}</p> : null}
          <div className="pt-1"><OpenThread message={message} channel={channel} /></div>
        </div>
      ) : null}
    </div>
  );
}

/** The action and target MonoCode's ToolCallSummary shows for a tool call. */
function toolDisplay(tool: ToolCall): { action: string; target: string; file: boolean; diff: boolean } {
  const name = tool.name;
  const target = tool.summary;
  const single = Boolean(target) && !target.includes(', ');
  switch (name) {
    case 'Read': return { action: 'Read', target, file: single, diff: false };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return { action: 'Edit', target, file: single, diff: true };
    case 'Write': return { action: 'Write', target, file: single, diff: true };
    case 'Bash':
    case 'Shell': return { action: 'Run', target, file: false, diff: false };
    case 'Grep': return { action: 'Search', target, file: false, diff: false };
    case 'Glob': return { action: 'Find', target, file: false, diff: false };
    case 'WebFetch': return { action: 'Fetch', target, file: false, diff: false };
    case 'WebSearch': return { action: 'Search the web', target, file: false, diff: false };
    case 'Task':
    case 'Agent': return { action: 'Agent', target, file: false, diff: false };
    case 'TodoWrite':
    case 'Plan': return { action: 'Plan', target, file: false, diff: false };
    default: {
      const channelTool = name.match(/(?:^mcp__agentscode__|^agentscode\.)(post_to_channel|read_channel|list_channels)$/)?.[1];
      if (channelTool) {
        const action = channelTool === 'post_to_channel' ? 'Posted' : channelTool === 'read_channel' ? 'Read channel' : 'Listed channels';
        return { action, target: target === name || target.startsWith('{') ? '' : target, file: false, diff: false };
      }
      const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/) ?? name.match(/^([^.]+)\.(.+)$/);
      if (mcp) return { action: mcp[1] === 'agentscode' ? 'Comms' : mcp[1], target: mcp[2].replace(/_/g, ' '), file: false, diff: false };
      return { action: name, target: target === name ? '' : target, file: false, diff: false };
    }
  }
}

/** MonoCode's ToolCallSummary (chip variant, as used in the work trail). */
function ToolCallSummary({ tool, failed, agentId }: { tool: ToolCall; failed: boolean; agentId: string }) {
  const { action, target, file, diff } = toolDisplay(tool);
  const actionTone = failed ? 'text-danger' : 'text-content/50';
  const targetTone = failed ? 'text-danger' : 'text-content/70';
  if (!target) {
    return <span className={`min-w-0 flex-1 truncate font-sans text-sm ${actionTone}`} title={tool.name}>{action}</span>;
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[13px]">
      <span className={`shrink-0 font-sans text-sm ${actionTone}`}>{action}</span>
      {file ? (
        <button
          type="button"
          className={`-my-0.5 flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded bg-content/6 px-1 py-0.5 text-left hover:bg-content/10 hover:text-[var(--link-color)] ${targetTone}`}
          title={target}
          onClick={(event) => {
            event.stopPropagation();
            open({ kind: diff ? 'diff' : 'file', root: { agent: agentId }, path: target });
          }}
        >
          <File className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{target}</span>
        </button>
      ) : (
        <span className={`flex min-w-0 flex-1 items-center gap-1.5 pl-1 ${targetTone}`} title={target}>
          <span className="min-w-0 truncate">{target}</span>
        </span>
      )}
    </span>
  );
}

/** MonoCode's ActivityToolRow with ToolCall's expandable output. */
function ActivityToolRow({ entry, live, agentId }: { entry: Entry; live: boolean; agentId: string }) {
  const [open, setOpen] = useState(false);
  const tool = entry.tool!;
  const failed = tool.status === 'error';
  const running = tool.status === 'running';
  const detail = [tool.detail, tool.output].filter(Boolean).join('\n\n').trim();
  const expandable = Boolean(detail) && detail !== tool.summary;
  return (
    <div className="flex min-w-0 flex-col">
      <div
        aria-label={`Tool call: ${tool.name} ${tool.summary}`}
        onClick={expandable ? () => setOpen(v => !v) : undefined}
        className={`group flex min-w-0 items-center gap-1.5 py-1 ${expandable ? 'cursor-pointer' : ''}`}
      >
        {running ? <CircleDashed className={`size-3.5 shrink-0 text-content/40 ${live ? 'zen-tool-spin' : ''}`} strokeWidth={1.75} /> : null}
        <ToolCallSummary tool={tool} failed={failed} agentId={agentId} />
        {failed ? <X className="size-3.5 shrink-0 text-danger" strokeWidth={2} /> : null}
        {/* The row toggles on click; this is the keyboard way in, since the row holds the file chip's own button. */}
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide the output' : 'Show the output'}
            onClick={(event) => { event.stopPropagation(); setOpen(v => !v); }}
            className="-m-0.5 grid shrink-0 place-items-center rounded p-0.5 outline-none hover:bg-content/8"
          >
            <ChevronRight className={`size-3.5 transition-transform ${failed ? 'text-danger/60' : 'text-content/35'} ${open ? 'rotate-90' : ''}`} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
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
function WorkRow({ entry, live, selfId }: { entry: Entry; live: boolean; selfId: string }) {
  if (entry.kind === 'tool') return <ActivityToolRow entry={entry} live={live} agentId={selfId} />;
  if (entry.kind === 'peer' && entry.peer) return <ActivityPeerRow message={entry.peer} selfId={selfId} />;
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

/** MonoCode's ActivityPhaseIcon: the kind of work a group did most of. */
function ActivityPhaseIcon({ kind, className = '' }: { kind: PhaseKind; className?: string }) {
  const props = { className: `size-3.5 shrink-0 text-content/45 ${className}`, strokeWidth: 1.75 };
  if (kind === 'edit') return <PenLine {...props} />;
  if (kind === 'research') return <Search {...props} />;
  if (kind === 'run') return <Terminal {...props} />;
  if (kind === 'agent') return <Bot {...props} />;
  if (kind === 'other' || kind === 'plan') return <Wrench {...props} />;
  return <Minus {...props} />;
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

/**
 * MonoCode's ActivityPhaseGroup: a run of work under one line saying what it adds up to, its steps
 * on a rail. The group the agent is in stays open as a short window pinned to the newest step; the
 * moment the agent moves on it folds back to its line. A click overrides either way.
 */
function ActivityPhaseGroup({ entries, active, selfId }: { entries: Entry[]; active: boolean; selfId: string }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useLivePhaseScroll(scroller, active && open, entries.length);
  const arriving = useContext(Arrivals);
  const turnFor = useStepQueue();
  const title = workSummaryLine(entries, active);
  const kind = workKind(entries);

  // A lone step is not a group: a line repeating the one row under it says nothing twice.
  if (entries.length === 1) {
    return (
      <div className="flex min-w-0 items-start gap-1.5">
        <ActivityPhaseIcon kind={kind} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <WorkRow entry={entries[0]} live={active} selfId={selfId} />
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
        className="group flex w-full min-w-0 items-center gap-1.5 py-1 text-left"
      >
        {/* The two icons share one box, so the swap is instant rather than a cross-fade. */}
        <span className="relative flex size-3.5 shrink-0 items-center justify-center">
          <ActivityPhaseIcon kind={kind} className="group-hover:opacity-0" />
          <ChevronRight className={`absolute size-3.5 text-content/45 opacity-0 transition-transform duration-200 group-hover:opacity-100 ${open ? 'rotate-90' : ''}`} strokeWidth={1.75} />
        </span>
        {label}
      </button>
      <div className="zen-phase-body" data-open={open}>
        {open ? (
          <div ref={setScroller} className={active ? 'zen-phase-live' : undefined}>
            <div className="flex min-w-0 flex-col">
              {entries.map(entry => (
                <PhaseStep key={entry.id} live={active} turn={active && arriving(entry.id) ? turnFor(entry.id) : undefined}>
                  <WorkRow entry={entry} live={active} selfId={selfId} />
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
function LiveFoldTitle({ startedAt, paused, waitingLabel, who }: { startedAt?: number; paused: boolean; waitingLabel?: string; who?: string }) {
  const elapsedMs = useElapsedFrom(startedAt, paused);
  const text = paused ? (waitingLabel ?? 'Waiting for approval') : formatWorkingDuration(elapsedMs, false, who);
  return <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1}>{text}</Shimmer>;
}

/** MonoCode's WorkFoldLine: the agent's mark and the clock, with the work folded behind it. */
function WorkFoldLine({ title, agent, live, expandable, open, onToggle }: {
  title: ReactNode;
  agent: Agent;
  live: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const icon = (
    <span className="relative flex size-3.5 shrink-0 items-center justify-center">
      {open ? (
        <ChevronRight className="size-3.5 rotate-90 text-content/45" strokeWidth={1.75} />
      ) : (
        <>
          <EngineIcon engine={agent.engine} className={`size-3.5 shrink-0 ${expandable ? 'group-hover:opacity-0' : ''}`} />
          {expandable ? <ChevronRight className="absolute size-3.5 text-content/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100" strokeWidth={1.75} /> : null}
        </>
      )}
    </span>
  );
  const label = live ? title : (
    <span className="min-w-0 flex-1 truncate font-sans text-sm text-content/50 transition-colors duration-200 group-hover:text-content/80">{title}</span>
  );
  const row = `flex w-full min-w-0 items-center gap-1.5 px-4 py-1 text-left${open ? ' zen-fold-drop' : ''}`;
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
function TurnDuration({ elapsedMs, labelHidden, copyText, completedAt, meta, agent }: {
  elapsedMs: number | null;
  labelHidden: boolean;
  copyText?: string;
  completedAt?: number;
  meta?: TurnMeta;
  agent: Agent;
}) {
  const label = formatWorkingDuration(elapsedMs, true, useModelName(agent));
  const dot = <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-content/25" />;
  return (
    <div data-turn-actions aria-label={label} className="flex w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden px-4 pb-3 pt-1 font-sans text-sm text-content/40">
      <span className="flex shrink-0 items-center gap-1">
        {copyText ? <CopyTurnButton text={copyText} /> : <Check className="size-3.5" strokeWidth={1.75} />}
        <TurnMetricsBadge meta={meta} />
      </span>
      {labelHidden ? null : (
        <span className="flex min-w-0 items-center gap-2.5">
          {dot}
          <span className="flex min-w-0 items-center gap-1.5">
            <EngineIcon engine={agent.engine} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate" title={label}>{label}</span>
          </span>
        </span>
      )}
      {completedAt != null ? (
        <span className="flex shrink-0 items-center gap-2.5">
          {dot}
          <span className="shrink-0 text-content/35">{formatClockTime(completedAt)}</span>
        </span>
      ) : null}
    </div>
  );
}

/** MonoCode's ApprovalControls, for a tool call or plan waiting on the user. Deny can carry a note. */
function ApprovalRow({ approval }: { approval: Approval }) {
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const decide = (allow: boolean, always = false, message?: string) => attempt(() => api.resolveApproval(approval.id, { allow, always, message }));
  const plan = approval.type === 'plan';
  const deny = () => void decide(false, false, note.trim() || undefined);
  // The one thing in the transcript that waits on you, so it sits in a warning-tinted card.
  return (
    <div className="px-4 py-1.5">
      <div role="group" aria-label={plan ? 'Plan waiting for your approval' : 'Action waiting for your approval'} className="rounded-lg border border-warning/25 bg-warning/[0.04] px-3 py-2.5">
        <StatusLabel tone="warning" className="text-[11px] font-medium">{plan ? 'Plan needs your approval' : 'Needs your approval'}</StatusLabel>
        <div className="mt-1.5 flex w-full min-w-0 items-center gap-2">
          <CircleDashed className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-content/85" title={approval.title}>{approval.title}</span>
        </div>
        {plan && approval.plan ? (
          <div className="mt-2 rounded-lg border border-content/10 bg-content/3 px-3 py-2.5"><Markdown text={approval.plan} /></div>
        ) : approval.detail ? (
          <pre className="mt-1.5 max-h-72 min-w-0 overflow-y-auto whitespace-pre-wrap break-words pl-5.5 font-mono text-[12px] leading-5 text-content/55">{approval.detail}</pre>
        ) : null}
        {approval.description ? <p className="mt-1 pl-5.5 font-sans text-xs text-content/45">{approval.description}</p> : null}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <ChipButton primary onClick={() => void decide(true)}>{plan ? 'Approve plan' : 'Allow'}</ChipButton>
          {approval.canAlwaysAllow ? <ChipButton onClick={() => void decide(true, true)}>Always allow</ChipButton> : null}
          <ChipButton aria-expanded={plan ? undefined : noting} onClick={() => (noting ? deny() : setNoting(true))}>
            {plan ? 'Keep planning' : 'Deny'}
          </ChipButton>
        </div>
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

/** One item of a turn outside its fold: prose at full size, or a group of work. */
function TurnItemView({ item, active, selfId, underLine }: { item: TurnItem; active: boolean; selfId: string; underLine: boolean }) {
  if (item.type === 'prose') {
    return (
      <div data-chat-message={item.entry.id} data-chat-message-role="assistant" className={`min-w-0 px-4 pb-1 text-content ${underLine ? 'pt-1' : 'pt-3'}`}>
        <ProseBlock entry={item.entry} />
      </div>
    );
  }
  return <ArrivingGroup item={item} active={active} selfId={selfId} />;
}

/** A group that opens while you watch grows in under the line above it. */
function ArrivingGroup({ item, active, selfId }: { item: Extract<TurnItem, { type: 'activity' }>; active: boolean; selfId: string }) {
  const arriving = useArriving(item.entries[0].id);
  return (
    <RevealHeight animateIn={arriving && active} className="px-4">
      <ActivityPhaseGroup entries={item.entries} active={active} selfId={selfId} />
    </RevealHeight>
  );
}

/** One item inside the fold, on its rail: a closed group, or the agent's commentary one notch quieter. */
function FoldItemView({ item, selfId }: { item: TurnItem; selfId: string }) {
  if (item.type === 'prose') return <div className="py-1"><Markdown text={item.entry.text} /></div>;
  return <ActivityPhaseGroup entries={item.entries} active={false} selfId={selfId} />;
}

function TurnView({ turn, agent, live, waiting, approvals, workOpen, onToggleWork, caption, enter }: {
  turn: Turn;
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
  const lastProse = items.findLast(item => item.type === 'prose');
  const settled = !live && Boolean(done || errors.length);
  const settledAt = done?.ts ?? errors.at(-1)?.ts ?? turn.items.at(-1)?.ts;
  const elapsedMs = done?.meta?.durationMs ?? errors.at(-1)?.meta?.durationMs ?? (settledAt ? settledAt - turn.startedAt : null);
  const who = useModelName(agent);
  // The fold line is the turn's status line from the first token to the last. It never moves, so a
  // turn settling does not shuffle the layout around the answer.
  const showFoldLine = live || items.length > 0 || settled;

  const prompt = turn.prompt;
  const promptCaption = caption ?? (prompt?.kind === 'user' && prompt.channel ? <ChannelCaption channelId={prompt.channel.id} /> : undefined);
  return (
    <div data-transcript-turn={turn.id} className={`transcript-turn flex min-w-0 flex-col${entering ? ' transcript-turn-enter' : ''}`}>
      {prompt?.kind === 'user' ? <UserMessageBlock entry={prompt} caption={promptCaption} /> : null}
      {prompt?.kind === 'peer' && prompt.peer ? <PeerPrompt message={prompt.peer} selfId={agent.id} /> : null}
      <TurnRow folded={!showFoldLine}>
        <WorkFoldLine
          agent={agent}
          live={live}
          expandable={Boolean(fold)}
          open={Boolean(fold) && workOpen}
          onToggle={onToggleWork}
          title={live
            ? <LiveFoldTitle startedAt={agent.turnStartedAt ?? turn.startedAt} paused={waiting} who={who} />
            : formatWorkingDuration(elapsedMs, true, who)}
        />
      </TurnRow>
      {fold ? (
        <TurnRow folded={!workOpen}>
          {() => items.slice(fold.start, fold.end + 1).map((item, offset, folded) => (
            <div
              key={turnItemKey(item)}
              className={`flow-root pb-1 pl-5 last:pb-0 zen-fold-rail${offset === folded.length - 1 ? ' zen-fold-tail' : ''}${item.type === 'prose' ? ' zen-fold-prose' : ''}`}
            >
              <div className="pl-4 pr-4">
                <FoldItemView item={item} selfId={agent.id} />
              </div>
            </div>
          ))}
        </TurnRow>
      ) : null}
      {rest.map((item, index) => (
        <div key={turnItemKey(item)} className="flow-root pb-1">
          <TurnItemView
            item={item}
            selfId={agent.id}
            // Only the last group can still be the one the agent is in.
            active={live && index === rest.length - 1}
            underLine={index === 0 && showFoldLine}
          />
        </div>
      ))}
      {errors.map(error => (
        <div key={error.id} className="px-4 py-2 text-danger">
          <pre className="min-w-0 whitespace-pre-wrap break-words font-sans text-sm">{error.text}</pre>
        </div>
      ))}
      {approvals.map(approval => <ArrivingApproval key={approval.id} approval={approval} />)}
      {settled ? (
        <TurnDuration
          agent={agent}
          elapsedMs={elapsedMs ?? null}
          labelHidden={showFoldLine}
          copyText={lastProse?.type === 'prose' ? lastProse.entry.text : undefined}
          completedAt={settledAt}
          meta={done?.meta ?? errors.at(-1)?.meta}
        />
      ) : null}
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
/** Within this of the end, the transcript follows new output. */
const NEAR_BOTTOM_PX = 80;

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
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
  const pinned = useRef(true);
  const [showAll, setShowAll] = useState(false);
  /** Folds the user opened or closed; the rest stay closed. */
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map());
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
   * the top and the reply grows under it. A transcript opened mid-turn starts that way too.
   */
  const opened = useRef<{ id?: string; busy: boolean } | null>(null);
  if (opened.current === null && entries !== undefined) opened.current = { id: ownLatest, busy };
  const anchoring = opened.current !== null && (opened.current.busy || ownLatest !== opened.current.id);

  const { sections, queued } = useMemo(() => groupTurns(entries ?? [], agent.id), [entries, agent.id]);
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
      pinned.current = isNearBottom(el);
      return;
    }
    held.current = null;
    if (pinned.current) el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(follow);

  const empty = entries?.length === 0 && !busy && !queued.length && !inline.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    // The anchored turn is as tall as the view, less the padding, so the prompt rests where the first message would.
    const sync = () => {
      const style = getComputedStyle(inner);
      const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      el.style.setProperty('--transcript-viewport', `${Math.max(0, el.clientHeight - pad)}px`);
    };
    sync();
    const observer = new ResizeObserver(records => {
      if (records.some(record => record.target === el)) sync();
      follow();
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [empty, follow]);

  const jump = (smooth: boolean) => {
    const el = scroller.current;
    pinned.current = true;
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
    pinned.current = true;
    held.current = null;
    setMissed(false);
    el.scrollTop = el.scrollHeight;
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
    if (!pinned.current) setMissed(true);
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
  const lastKey = queued.length ? queued.at(-1)!.id : (() => {
    const last = visible.findLast(s => s.type === 'turn');
    return last?.type === 'turn' ? last.turn.prompt?.id : undefined;
  })();
  // A prompt queued behind a running turn does not take the view from it.
  const anchorKey = anchoring && ownLatest && lastKey === ownLatest && !(queued.length && busy) ? ownLatest : undefined;
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
          // Your own prompt rises instead.
          enter={arriving(key) && key !== ownLatest}
        />
      </div>,
    );
  };
  for (const section of visible) {
    if (section.type === 'note') {
      rows.push(
        <div key={section.entry.id} className="px-4 py-2 text-content/50">
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
          if (held.current && performance.now() < held.current.until) return;
          pinned.current = isNearBottom(el);
          if (pinned.current) setMissed(false);
        }}
        onClickCapture={(event) => {
          // A disclosure keeps its place while it opens or closes; see follow().
          const toggle = (event.target as Element).closest('[aria-expanded]');
          if (toggle) held.current = { el: toggle, top: toggle.getBoundingClientRect().top, until: performance.now() + TOGGLE_HOLD_MS };
        }}
        className="agent-transcript min-h-0 flex-1 overflow-y-auto"
      >
        <Arrivals.Provider value={arriving}>
          <div ref={content} className="mx-auto w-full max-w-3xl pb-4 pt-2">
            {entries === undefined ? <Loading /> : null}
            {hidden > 0 ? (
              <div className="flex justify-center py-2">
                <TextButton onClick={() => setShowAll(true)}>
                  Show {hidden} earlier {hidden === 1 ? 'turn' : 'turns'}
                </TextButton>
              </div>
            ) : null}
            {rows}
          </div>
        </Arrivals.Provider>
      </div>
      {missed ? (
        <button
          type="button"
          onClick={() => jump(true)}
          className="toast-in absolute bottom-3 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-content/10 bg-background-base px-3 py-1 font-sans text-[12px] text-content shadow-lg hover:bg-selection"
        >
          <ChevronDown className="size-3.5" strokeWidth={1.75} />
          New activity, jump to latest
        </button>
      ) : null}
    </div>
  );
}

