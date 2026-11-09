/**
 * Teammate messages in a transcript. A message leads with what it means (a report's summary and
 * outcome, a delegation's task, a message's first sentence), says who sent it and when, and heads
 * the turn it caused as one block. A delegation you sent is a card that follows its work to the
 * report; the report links back to it. The wording lives in web/peerText.ts.
 */
import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import type { PeerMessage } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { openToSide } from '../layout.ts';
import {
  arrivalNote, delegationState, kindWords, messageMarkdown, messagePreview, messageTag, outcomeTone, outcomeWords, reportKind, taskTitle,
  type CommsIndex, type DelegationState, type OutcomeTone,
} from '../peerText.ts';
import { useApp } from '../store.ts';
import { cx, TextButton } from '../ui/common.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { AlertCircle, CheckCircle, CircleX, CornerDownRight } from '../mono/icons.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';

/** The transcript's teammate messages, indexed, so a report and its delegation find each other. */
export const Comms = createContext<CommsIndex>({ byId: new Map(), reportFor: new Map() });

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const TONE_TEXT: Record<OutcomeTone, string> = { success: 'text-success', danger: 'text-danger', warning: 'text-warning' };
const TONE_ICON = { success: CheckCircle, danger: CircleX, warning: AlertCircle } as const;

/** An outcome in words, with the icon and colour the Comms pane uses for it. */
export function OutcomeChip({ words, tone }: { words: string; tone: OutcomeTone }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cx('inline-flex shrink-0 items-center gap-1 font-medium', TONE_TEXT[tone])}>
      <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />
      {words}
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded bg-content/8 px-1.5 py-px text-[11px] font-medium leading-4 text-content/60">{children}</span>;
}

/** Who a teammate is at a glance: their engine mark, name and role. */
function Sender({ id, name }: { id: string; name: string }) {
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === id));
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {agent ? <EngineIcon engine={agent.engine} className="size-4" /> : null}
      <span className="min-w-0 truncate font-medium text-content/85">{name}</span>
      {agent ? <span className="shrink-0 text-content/40">{rolePreset(agent.role).name}</span> : null}
    </span>
  );
}

function channelName(message: PeerMessage, channels: { id: string; name: string }[] | undefined): string | undefined {
  if (!message.channelId) return undefined;
  return channels?.find(c => c.id === message.channelId)?.name ?? 'deleted-channel';
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

/** Scroll to the card of the delegation a report answers, and put focus on it. */
function showCard(id: string): void {
  const card = document.querySelector<HTMLElement>(`[data-peer-card="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.focus({ preventScroll: true });
}

/** The line under a report that says which delegation it answers. */
function Answers({ report }: { report: PeerMessage }) {
  const { byId } = useContext(Comms);
  const asked = report.replyTo ? byId.get(report.replyTo) : undefined;
  if (!asked?.delegation) return null;
  const onScreen = typeof document !== 'undefined' && Boolean(document.querySelector(`[data-peer-card="${CSS.escape(asked.id)}"]`));
  return (
    <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-content/45">
      <CornerDownRight aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="shrink-0">Answers</span>
      {onScreen ? (
        <button type="button" onClick={() => showCard(asked.id)} className="min-w-0 truncate rounded text-left text-content/65 underline decoration-content/20 underline-offset-2 hover:text-content">
          {taskTitle(asked.delegation.task)}
        </button>
      ) : <span className="min-w-0 truncate text-content/65">{taskTitle(asked.delegation.task)}</span>}
    </p>
  );
}

/** The outcome of a report as the work it answers reads it ("Changes needed" for a failed review). */
function useOutcome(message: PeerMessage): { words: string; tone: OutcomeTone } | null {
  const { byId } = useContext(Comms);
  if (!message.report) return null;
  const answered = message.replyTo ? byId.get(message.replyTo) : undefined;
  return { words: outcomeWords(message.report.outcome, reportKind(message, answered)), tone: outcomeTone(message.report.outcome) };
}

/** The preview, and the whole message as Markdown once you ask for it. */
function MessageBody({ message, channel, extra }: { message: PeerMessage; channel?: string; extra?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const preview = messagePreview(message);
  const full = messageMarkdown(message);
  const more = full.replace(/\s+/g, ' ').trim() !== preview.replace(/…$/, '').trim();
  return (
    <>
      {expanded ? (
        <div id={bodyId} className="mt-1.5 min-w-0 text-[13px]"><Markdown text={full} /></div>
      ) : (
        <p id={bodyId} className="mt-1 line-clamp-3 min-w-0 break-words font-sans text-[13.5px] leading-5.5 text-content/85">{preview}</p>
      )}
      {extra}
      <div className="-ml-1 mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 font-sans text-xs">
        {more ? (
          <TextButton aria-expanded={expanded} aria-controls={bodyId} onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Show less' : 'Show more'}
          </TextButton>
        ) : null}
        <OpenThread message={message} channel={channel} />
        <span className="ml-1"><DeliveryNote message={message} /></span>
      </div>
    </>
  );
}

/**
 * A teammate's message at the head of the turn it caused: who sent it and when, what it is and how
 * it came out, then what it says. `repeat` is a second delivery of a message an earlier turn ran.
 */
export function PeerTurnHeader({ message, arrivedAt, repeat }: { message: PeerMessage; arrivedAt?: number; repeat: boolean }) {
  const channels = useApp(s => s.snapshot?.channels);
  const channel = channelName(message, channels);
  const outcome = useOutcome(message);
  const late = arrivalNote(message.ts, arrivedAt, clock);
  const tag = channel ? (message.replyTo ? `Answer in #${channel}` : `Mention in #${channel}`) : messageTag(message);
  return (
    <header className="px-3.5 pb-2.5 pt-3 font-sans" data-peer-message={message.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
        <Sender id={message.fromAgentId} name={message.fromName} />
        <Tag>{tag}</Tag>
        {outcome ? <OutcomeChip words={outcome.words} tone={outcome.tone} /> : null}
        {repeat ? <span className="text-content/45">Delivered again</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-content/40">
          <time dateTime={new Date(message.ts).toISOString()} title={`Sent ${new Date(message.ts).toLocaleString()}`}>{late ?? clock(message.ts)}</time>
        </span>
      </div>
      {repeat ? (
        <p className="mt-1 truncate text-[12.5px] text-content/50">{messagePreview(message)}</p>
      ) : (
        <MessageBody message={message} channel={channel} extra={message.report ? <Answers report={message} /> : null} />
      )}
    </header>
  );
}

/** A turn that answers a teammate: the message and the work it caused, as one block. */
export function PeerTurnBlock({ message, arrivedAt, repeat, children }: { message: PeerMessage; arrivedAt?: number; repeat: boolean; children?: ReactNode }) {
  return (
    <section
      aria-label={`${messageTag(message)} from ${message.fromName}`}
      className={cx('mx-3 my-3 rounded-xl border bg-content/[0.015]', message.report?.outcome === 'failed' ? 'border-danger/20' : 'border-content/10')}
    >
      <PeerTurnHeader message={message} arrivedAt={arrivedAt} repeat={repeat} />
      {/* A message still waiting has no turn yet. */}
      {children ? <div className="border-t border-content/8 pb-1.5 pt-1">{children}</div> : null}
    </section>
  );
}

function StateChip({ state }: { state: DelegationState }) {
  if (state.tone === 'busy') {
    return <span className="inline-flex shrink-0 items-center gap-1 text-content/60"><TerminalSpinner className="text-content/60" />{state.label}</span>;
  }
  if (state.tone === 'neutral') return <span className="shrink-0 text-content/50">{state.label}</span>;
  return <OutcomeChip words={state.label} tone={state.tone} />;
}

/**
 * A delegation this agent sent, as a card that follows the work: who it went to, the kind and task,
 * and where it stands (sent, working, then the report's outcome, whose summary opens in place).
 */
export function DelegationCard({ message }: { message: PeerMessage }) {
  const { reportFor } = useContext(Comms);
  const report = reportFor.get(message.id);
  const state = delegationState(message, report);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const delegation = message.delegation!;
  return (
    <article
      tabIndex={-1}
      data-peer-card={message.id}
      aria-label={`${delegation.kind} delegated to ${message.toName}: ${state.label}`}
      className="my-1 rounded-lg border border-content/10 bg-content/[0.025] px-3 py-2 font-sans outline-none focus-visible:ring-1 focus-visible:ring-content/30"
    >
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <Tag>{kindWords(delegation.kind)}</Tag>
        <span className="flex min-w-0 items-center gap-1 text-content/45">
          <span className="shrink-0">to</span>
          <Sender id={message.toAgentId} name={message.toName} />
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StateChip state={state} />
          <time dateTime={new Date(message.ts).toISOString()} title={new Date(message.ts).toLocaleString()} className="tabular-nums text-content/35">{clock(message.ts)}</time>
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-content/85">{taskTitle(delegation.task)}</p>
      {open ? (
        <div id={detailId} className="mt-1.5 min-w-0 text-[13px]">
          <Markdown text={messageMarkdown(message)} />
          {report?.report ? (
            <div className="mt-2 border-t border-content/8 pt-2">
              <p className="mb-1 text-[12px] text-content/45">Report from {report.fromName}, {clock(report.ts)}</p>
              <Markdown text={messageMarkdown(report)} />
            </div>
          ) : null}
        </div>
      ) : report?.report ? (
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-5 text-content/55">{messagePreview(report)}</p>
      ) : null}
      <div className="-ml-1 mt-1 flex flex-wrap items-center gap-x-1 text-xs">
        <TextButton aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(v => !v)}>
          {open ? 'Show less' : report?.report ? 'Show task and report' : 'Show task'}
        </TextButton>
        <OpenThread message={message} />
        {message.status === 'failed' || message.status === 'cancelled' ? <span className="ml-1"><DeliveryNote message={message} /></span> : null}
      </div>
    </article>
  );
}

/**
 * A teammate message inside the work trail, one line that opens in place: who, what kind, the
 * outcome and what it says. A delegation this agent sent is a card instead.
 */
export function PeerTrailRow({ message, selfId }: { message: PeerMessage; selfId: string }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const channels = useApp(s => s.snapshot?.channels);
  const channel = channelName(message, channels);
  const outcome = useOutcome(message);
  if (message.delegation && message.fromAgentId === selfId) return <DelegationCard message={message} />;
  const incoming = message.toAgentId === selfId;
  const who = incoming ? `From ${message.fromName}` : `To ${message.toName}`;
  const tag = channel ? `#${channel}` : messageTag(message);
  const preview = messagePreview(message);
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`${who}, ${tag}${outcome ? `, ${outcome.words}` : ''}: ${preview}`}
        onClick={() => setOpen(v => !v)}
        className="group flex min-w-0 items-center gap-1.5 py-1 text-left font-sans text-sm"
      >
        <span className="shrink-0 text-content/55">{who}</span>
        <Tag>{tag}</Tag>
        {outcome ? <span className="text-[12px]"><OutcomeChip words={outcome.words} tone={outcome.tone} /></span> : null}
        <span className="min-w-0 flex-1 truncate text-content/50 transition-colors duration-200 group-hover:text-content/75">{preview}</span>
      </button>
      {open ? (
        <div id={detailId} className="min-w-0 pb-2 text-[13px]">
          <Markdown text={messageMarkdown(message)} />
          {message.report ? <Answers report={message} /> : null}
          <div className="-ml-1 flex items-center gap-1 pt-1 text-xs">
            <OpenThread message={message} channel={channel} />
            <span className="ml-1"><DeliveryNote message={message} /></span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
