/**
 * Teammate messages, in the transcript's own flow. A message from a teammate opens its turn the way
 * your message does: a soft bubble, on the left and a shade lighter so it never reads as yours, with
 * a line above it saying who sent it, what it is and how it came out. The agent's answer follows
 * unboxed, as it does for you. What the agent sends while it works (a delegation, a note) is one
 * line in its work trail, like a tool call. Wording lives in web/peerText.ts.
 */
import { RefText } from '../notes/RefChip.tsx';
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import type { PeerMessage } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { openToSide } from '../layout.ts';
import {
  arrivalNote, delegationState, kindWords, messageMarkdown, messagePhrase, messagePreview, messageTag, outcomeTone, outcomeWords, reportKind, taskTitle, trailPhrase,
  type CommsIndex, type DelegationState, type OutcomeTone,
} from '../peerText.ts';
import { useApp } from '../store.ts';
import { cx, TextButton } from '../ui/common.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { CornerDownRight } from '../mono/icons.tsx';
import { StatusMark, StatusText, type StatusState } from '../ui/StatusMark.tsx';
import { AgentAvatar } from '../ui/Avatar.tsx';

/** The transcript's teammate messages, indexed, so a report and its delegation find each other. */
export const Comms = createContext<CommsIndex>({ byId: new Map(), reportFor: new Map() });

export const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const TONE_TEXT: Record<OutcomeTone, string> = { success: 'text-success', danger: 'text-danger', warning: 'text-warning' };
/** An outcome's tone as the shared status mark (ACH-D45). */
const TONE_STATE = { success: 'pass', danger: 'fail', warning: 'warn' } as const satisfies Record<OutcomeTone, StatusState>;

/** An outcome in words, with the icon and colour the app uses for it. */
export function OutcomeChip({ words, tone }: { words: string; tone: OutcomeTone }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 font-medium', TONE_TEXT[tone])}>
      <StatusMark state={TONE_STATE[tone]} className="size-3.5" />
      {words}
    </span>
  );
}

/** A report's outcome as the work it answers reads it: a review that failed needs changes. */
export function useOutcome(message: PeerMessage, answered?: PeerMessage): { words: string; tone: OutcomeTone } | null {
  const { byId } = useContext(Comms);
  if (!message.report) return null;
  const asked = answered ?? (message.replyTo ? byId.get(message.replyTo) : undefined);
  const kind = reportKind(message, asked);
  return { words: outcomeWords(message.report.outcome, kind), tone: outcomeTone(message.report.outcome, kind) };
}

function useAgent(id: string) {
  return useApp(s => s.snapshot?.agents.find(a => a.id === id));
}

function useChannel(message: PeerMessage): string | undefined {
  return useApp(s => (message.channelId ? s.snapshot?.channels.find(c => c.id === message.channelId)?.name ?? 'deleted-channel' : undefined));
}

/**
 * The transcript's gutter: a 22px avatar column and 8px, which with the row's 16px of padding puts
 * every name, bubble and paragraph on the 46px edge the fold line's title already sits on.
 */
export const GUTTER = 'grid min-w-0 grid-cols-[22px_minmax(0,1fr)] gap-x-2';
/** Rows with no avatar of their own that keep to the same edge. */
export const EDGE = 'pl-[46px] pr-4';

/** Who a teammate is at a glance: engine mark, name and role. */
function Who({ id, name, role = true }: { id: string; name: string; role?: boolean }) {
  const agent = useAgent(id);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AgentAvatar agent={agent ?? { id }} className="size-3.5" />
      <span className="min-w-0 truncate font-medium text-content/75">{name}</span>
      {agent && role ? <span className="shrink-0 text-content/40">{rolePreset(agent.role).name}</span> : null}
    </span>
  );
}

/** Opens where a teammate message lives: its channel, or its thread in Comms. */
function OpenThread({ message, channel }: { message: PeerMessage; channel?: string }) {
  return (
    <TextButton onClick={() => openToSide(message.channelId ? { kind: 'channel', channelId: message.channelId } : { kind: 'comms', conversationId: message.conversationId })}>
      {channel ? `Open #${channel}` : 'Open thread'}
    </TextButton>
  );
}

/** Delivery that needs saying: still waiting, or gone wrong. Delivered is the quiet default. */
function DeliveryNote({ message }: { message: PeerMessage }) {
  if (message.status === 'queued') return <span className="text-content/45">Waiting to be delivered</span>;
  if (message.status === 'failed') return <span className="text-danger" title={message.error}>Not delivered{message.error ? `: ${message.error}` : ''}</span>;
  if (message.status === 'cancelled') return <span className="text-warning">Cancelled</span>;
  return null;
}

/**
 * Go to the delegation a report answers: its row in the work trail, scrolled into view and focused,
 * when it is on screen; otherwise its thread in Comms.
 */
function showDelegation(asked: PeerMessage, from: HTMLElement): void {
  // Inside a Comms thread the request is a message above in the same thread: go there, not to a transcript.
  const thread = from.closest<HTMLElement>('[data-peer-thread]');
  const row = thread
    ? thread.querySelector<HTMLElement>(`[data-peer-message="${CSS.escape(asked.id)}"]`)
    : document.querySelector<HTMLElement>(`[data-peer-card="${CSS.escape(asked.id)}"]`);
  if (!row) {
    openToSide({ kind: 'comms', conversationId: asked.conversationId });
    return;
  }
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.focus({ preventScroll: true });
}

/** The quiet line under a report that names the delegation it answers, and goes to it. */
function Answers({ report, answered }: { report: PeerMessage; answered?: PeerMessage }) {
  const { byId } = useContext(Comms);
  const asked = answered ?? (report.replyTo ? byId.get(report.replyTo) : undefined);
  if (!asked?.delegation) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 text-content/45">
      <CornerDownRight aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="shrink-0">Answers</span>
      <button
        type="button"
        title="Show the request this answers"
        onClick={event => showDelegation(asked, event.currentTarget)}
        className="min-w-0 truncate rounded text-left text-content/60 underline decoration-content/20 underline-offset-2 hover:text-content"
      >
        {taskTitle(asked.delegation.task)}
      </button>
    </span>
  );
}

/**
 * One teammate message as a bubble with its header line: in a transcript, who sent it to you; in
 * Comms (`between`), who sent it to whom. The preview leads; Show more opens the whole message as
 * Markdown, inert, since another agent wrote it.
 */
export function PeerBubble({ message, between = false, answered, arrivedAt, thread = true, trailing }: {
  message: PeerMessage;
  between?: boolean;
  /** The delegation a report answers, when the caller already has it (Comms). */
  answered?: PeerMessage;
  /** When its turn started, to say it waited. */
  arrivedAt?: number;
  /** Offer Open thread (not inside Comms, which is the thread). */
  thread?: boolean;
  /** Under the actions: Comms' delivery error. */
  trailing?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const channel = useChannel(message);
  const sender = useAgent(message.fromAgentId);
  const outcome = useOutcome(message, answered);
  const preview = messagePreview(message);
  const full = messageMarkdown(message);
  const more = full.replace(/\s+/g, ' ').trim() !== preview.replace(/…$/, '').trim();
  const late = arrivalNote(message.ts, arrivedAt, clock);
  const tag = channel ? (message.replyTo ? `Answer in #${channel}` : `Mention in #${channel}`) : messageTag(message);
  const time = (
    <time dateTime={new Date(message.ts).toISOString()} title={`Sent ${new Date(message.ts).toLocaleString()}`} className={cx('shrink-0 tabular-nums', between ? 'text-content/35' : 'ml-auto pl-2 text-[11.5px] text-content/30')}>
      {late ?? clock(message.ts)}
    </time>
  );
  const body = (
    <>
      {/* Your messages sit on the right in a stronger fill; a teammate's on the left, a shade lighter. */}
      <div className="w-fit min-w-0 max-w-[min(100%,40rem)] rounded-xl bg-content/[0.055] px-3 py-2 text-content">
        {expanded ? (
          <div id={bodyId} className="min-w-0"><Markdown inert text={full} /></div>
        ) : (
          <p id={bodyId} className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words text-sm leading-5.5"><RefText text={preview} /></p>
        )}
      </div>
      <div className="-ml-0.5 flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 pt-1 text-xs">
        {more ? (
          <TextButton aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Show less' : 'Show more'}
          </TextButton>
        ) : null}
        {thread ? <OpenThread message={message} channel={channel} /> : null}
        {message.report ? <span className="ml-1 min-w-0"><Answers report={message} answered={answered} /></span> : null}
        <span className="ml-1"><DeliveryNote message={message} /></span>
      </div>
      {trailing}
    </>
  );
  // Comms shows who wrote to whom on one line above the bubble.
  if (between) {
    return (
      <div data-peer-message={message.id} tabIndex={-1} className="flex w-fit min-w-0 max-w-full flex-col items-start rounded font-sans outline-none focus-visible:ring-1 focus-visible:ring-content/30">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-1 pb-1 text-[12px]">
          <span className="flex min-w-0 items-center gap-1.5 text-content/45">
            <Who id={message.fromAgentId} name={message.fromName} role={false} />
            <span className="shrink-0">to</span>
            <Who id={message.toAgentId} name={message.toName} role={false} />
          </span>
          <span className="shrink-0 text-content/45">{tag}</span>
          {outcome ? <OutcomeChip words={outcome.words} tone={outcome.tone} /> : null}
          {time}
        </div>
        {body}
      </div>
    );
  }
  // In a transcript the sender's avatar hangs in the gutter (GUTTER), so its name, its bubble and
  // the agent's answer under it all start on one left edge. The header reads as a sentence.
  return (
    <div data-peer-message={message.id} tabIndex={-1} className={cx(GUTTER, 'w-full rounded font-sans outline-none focus-visible:ring-1 focus-visible:ring-content/30')}>
      <AgentAvatar agent={sender ?? { id: message.fromAgentId }} className="size-[22px]" />
      <div className="flex min-w-0 flex-col items-start">
        <div className="flex h-[22px] w-full min-w-0 items-center gap-1.5 text-[12.5px]">
          <span className="shrink-0 font-semibold text-content/90">{message.fromName}</span>
          <span className="min-w-0 truncate text-content/45">{messagePhrase(message, channel)}</span>
          {outcome ? <OutcomeChip words={outcome.words} tone={outcome.tone} /> : null}
          {time}
        </div>
        <div className="flex w-full min-w-0 flex-col items-start pt-1">{body}</div>
      </div>
    </div>
  );
}

/**
 * A teammate's message opening the turn it caused, placed as your own prompt is (UserMessageBlock)
 * but on the left. `firstAt` marks a second delivery of a message an earlier turn already ran: one
 * quiet line instead.
 */
export function PeerPrompt({ message, arrivedAt, firstAt }: { message: PeerMessage; arrivedAt?: number; firstAt?: number }) {
  if (firstAt !== undefined) {
    return (
      <p className={cx(EDGE, 'flex min-w-0 items-center gap-1.5 pb-2 pt-1 font-sans text-xs text-content/40')}>
        <span className="shrink-0">Redelivered:</span>
        <span className="min-w-0 truncate">same {messageTag(message).toLowerCase()} from {message.fromName} as {clock(firstAt)}</span>
      </p>
    );
  }
  return (
    <section aria-label={`${messageTag(message)} from ${message.fromName}`} className="flex flex-col items-start px-4 pb-5 pt-1.5">
      <PeerBubble message={message} arrivedAt={arrivedAt} />
    </section>
  );
}

function StateChip({ state }: { state: DelegationState }) {
  if (state.tone === 'busy') {
    // The shared pending mark and its words (ACH-D45, ACH-39), not a spinner of its own.
    return <StatusText state="pending">{state.label}</StatusText>;
  }
  if (state.tone === 'neutral') return <span className="shrink-0 text-content/45">{state.label}</span>;
  return <OutcomeChip words={state.label} tone={state.tone} />;
}

/**
 * A delegation this agent sent, as one line of its work like a tool call: the kind, to whom, the
 * task, and where it stands (sent, working, then the report's outcome). Opening it shows the task
 * and, once in, the report.
 */
export function DelegationRow({ message }: { message: PeerMessage }) {
  const { reportFor } = useContext(Comms);
  const report = reportFor.get(message.id);
  const state = delegationState(message, report);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const delegation = message.delegation!;
  const title = taskTitle(delegation.task);
  const recipient = useAgent(message.toAgentId);
  return (
    <div data-peer-card={message.id} tabIndex={-1} className="flex min-w-0 flex-col rounded outline-none focus-visible:ring-1 focus-visible:ring-content/30">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${kindWords(delegation.kind)} delegated to ${message.toName}: ${title}. ${state.label}`}
        onClick={() => setOpen(v => !v)}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left font-sans text-sm"
      >
        <span className="shrink-0 text-content/50">Delegated {kindWords(delegation.kind).toLowerCase()} to</span>
        <span className="flex shrink-0 items-center gap-1 text-content/70"><AgentAvatar agent={recipient ?? { id: message.toAgentId }} className="size-3.5" />{message.toName}</span>
        <span className="min-w-0 flex-1 truncate text-content/50 transition-colors duration-200 group-hover:text-content/75"><RefText inert text={title} /></span>
        <span className="ml-2 text-[12px]"><StateChip state={state} /></span>
      </button>
      {open ? (
        <div id={detailId} className="min-w-0 pb-2 text-[13px]">
          <Markdown inert text={messageMarkdown(message)} />
          {report?.report ? (
            <div className="mt-2">
              <p className="mb-0.5 font-sans text-xs text-content/45">Report from {report.fromName}, {clock(report.ts)}</p>
              <Markdown inert text={messageMarkdown(report)} />
            </div>
          ) : null}
          <div className="-ml-1 flex items-center gap-1 pt-1 font-sans text-xs">
            <OpenThread message={message} />
            <span className="ml-1"><DeliveryNote message={message} /></span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Any other teammate message inside the work trail, one line that opens in place: to or from whom,
 * the kind, the outcome and what it says.
 */
export function PeerTrailRow({ message, selfId, lead = false, trailing }: {
  message: PeerMessage;
  selfId: string;
  /** On its own outside a group of work: led by a small arrow instead of a tile. */
  lead?: boolean;
  /** At the right of the row: the turn's actions, when this row closes the turn. */
  trailing?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const channel = useChannel(message);
  const outcome = useOutcome(message);
  const other = useAgent(message.toAgentId === selfId ? message.fromAgentId : message.toAgentId);
  if (message.delegation && message.fromAgentId === selfId) return <DelegationRow message={message} />;
  const sent = message.toAgentId !== selfId;
  const otherId = sent ? message.toAgentId : message.fromAgentId;
  const phrase = trailPhrase(message, selfId, channel);
  const preview = messagePreview(message);
  // A report this agent sent says again what its answer just said above; the row opens to show it.
  const showPreview = !(sent && message.report);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${phrase}${outcome ? `, ${outcome.words}` : ''}: ${preview}`}
          onClick={() => setOpen(v => !v)}
          className="group flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left font-sans text-[12.5px]"
        >
          {lead ? <CornerDownRight aria-hidden className="size-3 shrink-0 text-content/40" strokeWidth={1.75} /> : null}
          {/* The other agent's avatar: the recipient for what this agent sent, the sender for what it got. */}
          <AgentAvatar agent={other ?? { id: otherId }} animate={false} className="size-3.5" />
          <span className="shrink-0 text-content/50 transition-colors duration-200 group-hover:text-content/75">{phrase}</span>
          {outcome ? <span className="text-[12px]"><OutcomeChip words={outcome.words} tone={outcome.tone} /></span> : null}
          {showPreview ? <span className="min-w-0 flex-1 truncate text-content/40 transition-colors duration-200 group-hover:text-content/65"><RefText inert text={preview} /></span> : null}
        </button>
        {trailing}
      </div>
      {open ? (
        <div id={detailId} className="min-w-0 pb-2 text-[13px]">
          <Markdown inert text={messageMarkdown(message)} />
          <div className="-ml-1 flex flex-wrap items-center gap-1 pt-1 font-sans text-xs">
            <OpenThread message={message} channel={channel} />
            {message.report ? <span className="ml-1 min-w-0"><Answers report={message} /></span> : null}
            <span className="ml-1"><DeliveryNote message={message} /></span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
