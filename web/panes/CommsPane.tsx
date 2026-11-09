import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { Agent, PeerMessage, Report } from '../../shared/types.ts';
import { api } from '../api.ts';
import {
  commsThreads, inFilter, isUnseen, matchesQuery, messageKind, STATE_LABEL, threadState, threadTitle, timelineTail,
  messageGist, type CommsFilter, type CommsThread, type ThreadState, type TimelineTail,
} from '../comms.ts';
import { markThreadsSeen, useCommsSeen } from '../commsSeen.ts';
import { relativeTime, STATUS_LABEL } from '../format.ts';
import { open } from '../layout.ts';
import { attempt, useApp } from '../store.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { useNow } from '../ui/useNow.ts';
import { cx, Empty, HeaderButton, StatusLabel, type Tone } from '../ui/common.tsx';
import { outcomeWords, reportKind } from '../peerText.ts';
import {
  AlertCircle, ArrowLeft, Bot, CheckCheck, CheckCircle, ChevronDown, CircleX, Clock, MessageMultiple, Search, Square, X,
  type IconComponent,
} from '../mono/icons.tsx';
import { Shimmer } from '../mono/Shimmer.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { useFollowLatest } from './ChannelPosts.tsx';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

/** "1 message", "3 messages", "2 of 10 messages". */
function count(n: number, noun: string, limit?: number): string {
  return limit ? `${n} of ${limit} ${noun}s` : `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function names(ids: string[], agents: Agent[], messages: PeerMessage[]): string[] {
  return ids.map(id => agents.find(a => a.id === id)?.name
    ?? messages.find(m => m.fromAgentId === id)?.fromName
    ?? messages.find(m => m.toAgentId === id)?.toName
    ?? 'Removed agent');
}

/** "now" reads as "just now" in a sentence; anything else as "3m ago". */
function ago(ts: number, now: number): string {
  const rel = relativeTime(ts, now);
  return rel === 'now' ? 'just now' : `${rel} ago`;
}

const STATUS_TONE: Record<PeerMessage['status'], Tone> = {
  queued: 'neutral',
  delivering: 'neutral',
  delivered: 'success',
  failed: 'danger',
  cancelled: 'muted',
};

/** Delivery state in MonoCode's quiet status type: a spinner while it runs, a tone dot after. */
export function MessageStatus({ message }: { message: PeerMessage }) {
  return (
    <StatusLabel tone={STATUS_TONE[message.status]} busy={message.status === 'delivering'} title={message.error}>
      {STATUS_LABEL[message.status]}
    </StatusLabel>
  );
}

/** inboxStatusMark for conversations: an icon in the state's colour. Working spins instead. */
const STATE_MARK: Record<Exclude<ThreadState, 'working'>, { icon: IconComponent; className: string }> = {
  stopped: { icon: Square, className: 'text-content/40' },
  queued: { icon: Clock, className: 'text-content/50' },
  failed: { icon: CircleX, className: 'text-danger' },
  blocked: { icon: AlertCircle, className: 'text-warning' },
  done: { icon: CheckCircle, className: 'text-success' },
  handled: { icon: CheckCheck, className: 'text-content/40' },
};

function StateIcon({ state, className = 'size-3' }: { state: ThreadState; className?: string }) {
  if (state === 'working') return <TerminalSpinner className="text-content/60" />;
  const { icon: Icon, className: tone } = STATE_MARK[state];
  return <Icon aria-hidden className={cx('shrink-0', className, tone)} strokeWidth={1.75} />;
}

/** The state's words take its colour only when it needs you, as StatusLabel does. */
function stateWords(state: ThreadState): string {
  return state === 'failed' ? 'text-danger' : state === 'blocked' ? 'text-warning' : '';
}

const OUTCOME: Record<Report['outcome'], { icon: IconComponent; className: string }> = {
  passed: { icon: CheckCircle, className: 'text-success' },
  done: { icon: CheckCircle, className: 'text-success' },
  failed: { icon: CircleX, className: 'text-danger' },
  blocked: { icon: AlertCircle, className: 'text-warning' },
};

/** How much of a conversation's message budget is spent, as a hairline meter. */
function BudgetMeter({ used, limit }: { used: number; limit: number }) {
  const share = Math.min(1, used / limit);
  return (
    <span
      role="meter"
      aria-label="Message budget"
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={used}
      className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-content/10"
    >
      <span className={`block h-full rounded-full transition-[width] duration-300 ease-out ${share >= 1 ? 'bg-warning' : 'bg-content/40'}`} style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/** The engine logo that stands for an agent, or a muted bot once it has been removed. */
function AgentMark({ agent, className = 'size-3.5' }: { agent: Agent | undefined; className?: string }) {
  return agent
    ? <EngineIcon engine={agent.engine} className={className} />
    : <Bot aria-hidden className={cx('shrink-0 text-content/45', className)} strokeWidth={1.75} />;
}

function AgentLink({ id, name, agents }: { id: string; name: string; agents: Agent[] }) {
  const agent = agents.find(a => a.id === id);
  if (!agent) return <span className="min-w-0 truncate font-medium text-content/55">{name}</span>;
  return (
    <button type="button" onClick={() => open({ kind: 'agent', agentId: id })} title={`Open ${name}`} className="-mx-1 min-w-0 truncate rounded px-1 font-medium text-content transition-colors duration-100 hover:bg-content/8">
      {name}
    </button>
  );
}

const FILTERS: { value: CommsFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'attention', label: 'Attention' },
];

const EMPTY_FILTER: Record<CommsFilter, string> = {
  all: 'No conversations yet.',
  active: 'Nothing in flight.',
  attention: 'Nothing needs attention.',
};

/**
 * Every agent-to-agent conversation, laid out like MonoCode's Inbox: a list rail of cards with
 * filter tabs and a search box, beside the selected conversation's activity timeline. Below
 * 40rem of pane width it shows one at a time, the list or the conversation you picked, with a
 * way back.
 */
export function CommsPane({ conversationId, chrome }: { conversationId?: string; chrome: PaneChrome }) {
  const messages = useApp(s => s.snapshot?.messages);
  const conversations = useApp(s => s.snapshot?.conversations);
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const seen = useCommsSeen();
  const now = useNow();
  const [filter, setFilter] = useState<CommsFilter>('all');
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  const list = useMemo(() => commsThreads(messages ?? [], conversations ?? []).map(thread => ({
    thread,
    state: threadState(thread),
    title: threadTitle(thread),
  })), [messages, conversations]);
  // Cards that were already there when the pane opened sit still; later arrivals grow in.
  const initial = useRef<Set<string> | null>(null);
  // Only once the snapshot has loaded, or a reload would grow every card in.
  if (messages) initial.current ??= new Set(list.map(item => item.thread.id));

  const searched = list.filter(item => matchesQuery(item.thread, names(item.thread.participants, agents, item.thread.messages), query));
  const shown = searched.filter(item => inFilter(item.state, filter));
  const totals: Record<CommsFilter, number> = {
    all: searched.length,
    active: searched.filter(item => inFilter(item.state, 'active')).length,
    attention: searched.filter(item => inFilter(item.state, 'attention')).length,
  };
  const selected = list.find(item => item.thread.id === conversationId) ?? shown[0];
  const unseen = list.filter(item => isUnseen(item.thread, seen));

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const at = shown.findIndex(item => item.thread.id === selected?.thread.id);
    const next = shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    open({ kind: 'comms', conversationId: next.thread.id });
    listRef.current?.querySelector<HTMLElement>(`[data-thread-id="${next.thread.id}"]`)?.focus();
  };

  return (
    <PaneFrame
      chrome={chrome}
      title={<span className="flex items-center gap-2"><MessageMultiple className="size-3.5 text-content/55" strokeWidth={1.75} /><span className="text-content">Comms</span><span className="font-normal text-content/45">{count(list.length, 'conversation')}</span></span>}
      actions={list.length ? <HeaderButton icon={CheckCheck} label="Mark all as read" disabled={!unseen.length} onClick={() => markThreadsSeen(unseen.map(item => item.thread))} /> : null}
    >
      {!list.length ? (
        <Empty icon={MessageMultiple} title="No agent conversations yet">
          Agents message each other with send_message, reply and delegate_task. Ask one agent to work with another and the exchange shows up here. Mentions inside a channel show in that channel.
        </Empty>
      ) : (
        <div className="@container/comms flex min-h-0 flex-1">
          <div className={cx('flex w-full shrink-0 flex-col border-stroke @min-[40rem]/comms:w-[min(19rem,42%)] @min-[40rem]/comms:border-r', conversationId && '@max-[40rem]/comms:hidden')}>
            <div role="tablist" aria-label="Show" className="flex h-9 shrink-0 items-center gap-px border-b border-stroke px-2">
              {FILTERS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === option.value}
                  onClick={() => setFilter(option.value)}
                  className={cx(
                    'flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 font-sans text-[12px] leading-none transition-colors duration-150',
                    filter === option.value ? 'bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {option.value !== 'all' && totals[option.value] ? (
                    <span className={cx('rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', option.value === 'attention' ? 'bg-warning/15 text-warning' : 'bg-content/10 text-content/60')}>{totals[option.value]}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
              <div className="relative flex h-7 min-w-0 flex-1 items-center">
                <Search aria-hidden className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" strokeWidth={1.75} />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                  placeholder="Filter conversations"
                  aria-label="Filter conversations"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-7 w-full rounded-md bg-transparent pl-7 pr-2 font-sans text-[12px] text-content outline-none placeholder:text-content/40"
                />
              </div>
              {query ? (
                <button type="button" aria-label="Clear filter" title="Clear filter" onClick={() => setQuery('')} className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 transition-colors duration-150 hover:bg-content/10 hover:text-content">
                  <X className="size-3" strokeWidth={1.75} />
                </button>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
              {shown.length ? (
                <ul ref={listRef} onKeyDown={onListKey} aria-label="Conversations" className="flex flex-col gap-0.5 p-1.5">
                  {shown.map(item => (
                    <li key={item.thread.id} className={initial.current?.has(item.thread.id) ? undefined : 'reveal-height-in'}>
                      <ThreadCard
                        thread={item.thread}
                        state={item.state}
                        title={item.title}
                        agents={agents}
                        now={now}
                        active={selected?.thread.id === item.thread.id}
                        unseen={isUnseen(item.thread, seen)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-3 font-sans text-[12px] text-content/50">
                  {query.trim() ? (filter === 'all' ? 'No conversations match.' : `No ${filter === 'active' ? 'active' : 'flagged'} conversations match.`) : EMPTY_FILTER[filter]}
                </p>
              )}
            </div>
          </div>
          {selected ? (
            <div className={cx('flex min-w-0 flex-1', !conversationId && '@max-[40rem]/comms:hidden')}>
              <ThreadView key={selected.thread.id} thread={selected.thread} state={selected.state} title={selected.title} agents={agents} now={now} />
            </div>
          ) : <div className="flex-1" />}
        </div>
      )}
    </PaneFrame>
  );
}

/** InboxCard for a conversation: state and when, what it is about, then who and where it stands. */
function ThreadCard({ thread, state, title, agents, now, active, unseen }: {
  thread: CommsThread;
  state: ThreadState;
  title: string;
  agents: Agent[];
  now: number;
  active: boolean;
  unseen: boolean;
}) {
  const people = names(thread.participants, agents, thread.messages);
  const last = thread.messages[thread.messages.length - 1];
  const first = thread.messages[0];
  const kind = first.delegation ? `Delegation · ${first.delegation.kind}` : messageKind(first);
  return (
    <button
      type="button"
      data-thread-id={thread.id}
      onClick={() => open({ kind: 'comms', conversationId: thread.id })}
      aria-current={active ? 'true' : undefined}
      aria-label={`${title}. ${people.join(', ')}. ${STATE_LABEL[state]}${unseen ? ', new' : ''}`}
      title={title}
      className={cx(
        'flex w-full flex-col rounded-md px-2.5 py-2 text-left font-sans transition-colors duration-100',
        active ? 'bg-selection text-content' : 'text-content/80 hover:bg-content/5 hover:text-content',
      )}
    >
      <span className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="flex shrink-0 items-center -space-x-1">
            {thread.participants.slice(0, 3).map(id => (
              <span key={id} className="grid size-4 place-items-center rounded-full bg-background-base">
                <AgentMark agent={agents.find(a => a.id === id)} className="size-3.5" />
              </span>
            ))}
          </span>
          <span className="min-w-0 truncate text-[11px] text-content/55">{people.join(', ')}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span title={count(thread.messages.length, 'message', thread.conversation?.messageLimit)} className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-content/40">
            <MessageMultiple className="size-3" strokeWidth={1.75} />
            {thread.messages.length}
          </span>
          <time dateTime={new Date(thread.lastTs).toISOString()} title={new Date(thread.lastTs).toLocaleString()} className="text-[11px] tabular-nums text-content/45">{relativeTime(thread.lastTs, now)}</time>
          {unseen ? <span aria-hidden className="size-1.5 rounded-full bg-accent" /> : null}
        </span>
      </span>
      <span className={cx('mt-1 line-clamp-1 text-[13px] leading-snug text-content', unseen ? 'font-semibold' : 'font-medium')}>{title}</span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-content/45">
        <StateIcon state={state} />
        <span className={cx('shrink-0', stateWords(state))}>{STATE_LABEL[state]}</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">
          {thread.messages.length > 1 ? `${last.fromName}: ${messageGist(last)}` : kind}
        </span>
      </span>
    </button>
  );
}

/** True while `ref`'s element is laid out, so a conversation hidden by the narrow layout is not marked read. */
function useDisplayed(ref: RefObject<HTMLElement | null>): boolean {
  const [displayed, setDisplayed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setDisplayed(el.getClientRects().length > 0);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return displayed;
}

function ThreadView({ thread, state, title, agents, now }: { thread: CommsThread; state: ThreadState; title: string; agents: Agent[]; now: number }) {
  const people = names(thread.participants, agents, thread.messages);
  const tail = timelineTail(thread);
  const limit = thread.conversation?.messageLimit;
  const first = thread.messages[0];
  const starter = thread.conversation?.startedBy ?? first.fromAgentId;
  const starterName = names([starter], agents, thread.messages)[0];
  const { ref, onScroll, jump, newPosts } = useFollowLatest(thread.messages.length);
  const rootRef = useRef<HTMLDivElement>(null);
  const displayed = useDisplayed(rootRef);
  useEffect(() => {
    if (displayed) markThreadsSeen([thread]);
  }, [displayed, thread]);
  // What was there when the conversation opened sits still; what arrives later grows in.
  const initial = useRef<Set<string> | null>(null);
  initial.current ??= new Set([...thread.messages.map(m => m.id), ...tail.map(tailKey)]);
  const stops = thread.messages.length + tail.length;

  return (
    <div ref={rootRef} className="@container/thread flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke pl-2 pr-2 font-sans text-[12px] text-content/50 @min-[40rem]/comms:pl-4">
        {/* Only when the list is hidden beside it: back to every conversation. */}
        <HeaderButton icon={ArrowLeft} label="All conversations" className="-mr-1 @min-[40rem]/comms:hidden" onClick={() => open({ kind: 'comms' })} />
        <span className="flex shrink-0 items-center gap-1.5">
          <StateIcon state={state} className="size-3.5" />
          <span className={stateWords(state) || 'text-content/70'}>{STATE_LABEL[state]}</span>
        </span>
        <span className="min-w-0 truncate">
          {first.delegation ? `Delegation · ${first.delegation.kind}` : messageKind(first)} · started {ago(thread.conversation?.createdAt ?? first.ts, now)} by {starterName}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums text-content/45">
          {limit ? <BudgetMeter used={thread.messages.length} limit={limit} /> : null}
          <span className="@max-[28rem]/thread:hidden">{count(thread.messages.length, 'message', limit)}</span>
        </span>
        {thread.conversation && !thread.conversation.stopped ? (
          <button
            type="button"
            onClick={() => void attempt(() => api.stopConversation(thread.id))}
            title="Stop conversation: no more messages are delivered in it"
            className="inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-content/70 transition-[color,background-color,transform] duration-150 hover:bg-content/10 hover:text-content active:scale-[0.97] motion-reduce:transition-none"
          >
            <Square className="size-2.5 fill-current" strokeWidth={0} />
            <span className="@max-[28rem]/thread:hidden">Stop</span>
          </button>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={ref} onScroll={onScroll} className="agent-transcript min-h-0 flex-1 overflow-y-auto">
          <header className="border-b border-stroke">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 pb-4 pt-5 @min-[40rem]/comms:px-6">
              <h1 title={title} className="line-clamp-2 font-sans text-[18px] font-semibold leading-tight text-content">{title}</h1>
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                {thread.participants.map((id, i) => {
                  const agent = agents.find(a => a.id === id);
                  const pill = <><AgentMark agent={agent} />{people[i]}</>;
                  return agent ? (
                    <button key={id} type="button" onClick={() => open({ kind: 'agent', agentId: id })} title={`Open ${agent.name}`} className="inline-flex max-w-64 items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 font-sans text-[11px] text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content">
                      {pill}
                    </button>
                  ) : (
                    <span key={id} className="inline-flex max-w-64 items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 font-sans text-[11px] text-content/45">{pill}</span>
                  );
                })}
              </div>
            </div>
          </header>
          <section className="mx-auto w-full max-w-3xl px-4 pb-8 pt-5 @min-[40rem]/comms:px-6">
            <div className="mb-3 flex items-center gap-2 font-sans text-[12px] text-content/50">
              <h2 className="text-content/70">Activity</h2>
              <span>{count(thread.messages.length, 'message', limit)}</span>
            </div>
            <ol className="flex flex-col">
              {thread.messages.map((message, i) => (
                <TimelineStop
                  key={message.id}
                  card
                  fresh={!initial.current?.has(message.id)}
                  first={i === 0}
                  last={i === stops - 1}
                  node={<AgentMark agent={agents.find(a => a.id === message.fromAgentId)} className="size-4" />}
                >
                  <MessageCard message={message} answered={message.replyTo ? thread.messages.find(m => m.id === message.replyTo) : undefined} agents={agents} now={now} />
                </TimelineStop>
              ))}
              {tail.map((stop, i) => (
                <TailStop
                  key={tailKey(stop)}
                  stop={stop}
                  agents={agents}
                  fresh={!initial.current?.has(tailKey(stop))}
                  first={thread.messages.length + i === 0}
                  last={thread.messages.length + i === stops - 1}
                />
              ))}
            </ol>
          </section>
        </div>
        {newPosts ? (
          <button
            type="button"
            onClick={jump}
            className="absolute bottom-3 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-content/10 bg-background-base px-3 py-1 font-sans text-[12px] text-content shadow-lg transition-colors duration-150 hover:bg-selection"
          >
            <ChevronDown className="size-3.5" strokeWidth={1.75} />
            {newPosts === 1 ? '1 new message' : `${newPosts} new messages`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function tailKey(stop: TimelineTail): string {
  return stop.kind === 'working' ? `working:${stop.agentId}` : stop.kind;
}

/**
 * MonoCode's TimelineStop: a rail column with the stop's node, and its content beside it. The
 * lead segment centres a card's node on the card header, and an event's on its 20px row.
 */
function TimelineStop({ node, first, last, card = false, fresh = false, children }: {
  node: ReactNode;
  first: boolean;
  last: boolean;
  card?: boolean;
  /** Arrived while the conversation was open: grows in. */
  fresh?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={fresh ? 'reveal-height-in' : undefined}>
      <div className="flex gap-3">
        <div aria-hidden className="flex w-5 shrink-0 flex-col items-center">
          <span className={cx('w-px shrink-0', card ? 'h-2' : 'h-0', !first && 'bg-content/10')} />
          <div className="flex size-5 shrink-0 items-center justify-center">{node}</div>
          {last ? null : <span className="w-px flex-1 bg-content/10" />}
        </div>
        <div className={cx('min-w-0 flex-1', !last && 'pb-3')}>{children}</div>
      </div>
    </li>
  );
}

/** What follows the messages: who is working on it now, a spent budget, a stop. */
function TailStop({ stop, agents, fresh, first, last }: { stop: TimelineTail; agents: Agent[]; fresh: boolean; first: boolean; last: boolean }) {
  if (stop.kind === 'working') {
    const agent = agents.find(a => a.id === stop.agentId);
    return (
      <TimelineStop first={first} last={last} fresh={fresh} node={<TerminalSpinner className="text-content/60" />}>
        <p className="flex h-5 min-w-0 items-center gap-1.5 font-sans text-[12px] text-content/50">
          <span className="shrink-0 font-medium text-content">{stop.name}</span>
          <span className="shrink-0">is working on {stop.forName}'s message</span>
          {agent?.activity ? (
            <>
              <span aria-hidden>·</span>
              <Shimmer className="min-w-0 truncate">{agent.activity}</Shimmer>
            </>
          ) : null}
        </p>
      </TimelineStop>
    );
  }
  if (stop.kind === 'budget') {
    return (
      <TimelineStop first={first} last={last} fresh={fresh} node={<AlertCircle className="size-4 text-warning" strokeWidth={1.75} />}>
        <p className="flex h-5 min-w-0 items-center gap-1.5 font-sans text-[12px] text-content/50">
          <span className="shrink-0 font-medium text-content">Message budget used up</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">{stop.used} of {stop.limit}</span>
        </p>
      </TimelineStop>
    );
  }
  return (
    <TimelineStop first={first} last={last} fresh={fresh} node={<Square className="size-2.5 fill-current text-content/45" strokeWidth={0} />}>
      <p className="flex h-5 min-w-0 items-center gap-1.5 font-sans text-[12px] text-content/50">
        <span className="shrink-0 font-medium text-content">Conversation stopped</span>
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate">nothing more is delivered in it</span>
      </p>
    </TimelineStop>
  );
}

/** InboxComment for a peer message: a header of who, what and when, over its body. */
function MessageCard({ message, answered, agents, now }: { message: PeerMessage; answered?: PeerMessage; agents: Agent[]; now: number }) {
  const outcome = message.report ? OUTCOME[message.report.outcome] : undefined;
  return (
    <article className={cx('overflow-hidden rounded-md border bg-content/5', message.status === 'failed' ? 'border-danger/25' : 'border-content/10')}>
      <header className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-stroke px-3 py-1.5 font-sans text-[12px] text-content/50">
        <span className="flex min-w-0 items-center gap-1.5">
          <AgentLink id={message.fromAgentId} name={message.fromName} agents={agents} />
          <span className="shrink-0">to</span>
          <AgentLink id={message.toAgentId} name={message.toName} agents={agents} />
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0">{messageKind(message)}</span>
        {message.delegation ? <><span aria-hidden>·</span><span className="shrink-0">{message.delegation.kind}</span></> : null}
        {message.report && outcome ? (
          <>
            <span aria-hidden>·</span>
            <span className={cx('inline-flex shrink-0 items-center gap-1', outcome.className)}>
              <outcome.icon className="size-3.5" strokeWidth={1.75} />
              {/* As the work it answers reads it: a failed review needs changes (web/peerText.ts). */}
              {outcomeWords(message.report.outcome, reportKind(message, answered))}
            </span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <time dateTime={new Date(message.ts).toISOString()} title={new Date(message.ts).toLocaleString()} className="shrink-0 tabular-nums">{relativeTime(message.ts, now)}</time>
        {/* Handled is the quiet default; only the states still moving, or gone wrong, say so. */}
        {message.status !== 'delivered' ? <span className="ml-auto text-[11px]"><MessageStatus message={message} /></span> : null}
      </header>
      <div className="px-3 py-2.5">
        <CollapsibleBody>
          {message.delegation ? (
            <div className="font-sans">
              <p className="whitespace-pre-wrap text-[13px] font-medium leading-5 text-content">{message.delegation.task}</p>
              <Section label="Acceptance criteria"><p className="whitespace-pre-wrap text-[12px] leading-5 text-content/70">{message.delegation.acceptanceCriteria}</p></Section>
              {message.delegation.context ? <Section label="Context"><p className="whitespace-pre-wrap text-[12px] leading-5 text-content/70">{message.delegation.context}</p></Section> : null}
            </div>
          ) : message.report ? (
            <div>
              <Markdown inert text={message.report.summary} />
              {message.report.evidence.trim() ? (
                <Section label="Evidence">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-content/5 px-2.5 py-2 font-mono text-[12px] leading-5 text-content/60">{message.report.evidence}</pre>
                </Section>
              ) : null}
            </div>
          ) : (
            <Markdown inert text={message.text} />
          )}
        </CollapsibleBody>
      </div>
      {message.error ? (
        <p className="flex items-start gap-1.5 border-t border-stroke px-3 py-2 font-sans text-[12px] text-danger">
          <CircleX className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 break-words">{message.error}</span>
        </p>
      ) : null}
    </article>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <p className="mb-1 font-sans text-[11px] font-medium text-content/45">{label}</p>
      {children}
    </div>
  );
}

const CLAMPED_BODY_PX = 180;

/** MonoCode's CollapsibleBody: long write-ups start clamped behind a fade so the timeline stays scannable. */
function CollapsibleBody({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    // A little slack, so a body barely over the limit just shows in full.
    const measure = () => setOverflows(el.scrollHeight > CLAMPED_BODY_PX + 48);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const clamped = overflows && !expanded;
  return (
    <>
      <div
        style={clamped ? { maxHeight: CLAMPED_BODY_PX } : undefined}
        className={clamped ? 'overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]' : undefined}
      >
        <div ref={inner}>{children}</div>
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="mt-1.5 font-sans text-[12px] text-content/50 transition-colors duration-150 hover:text-content"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}
