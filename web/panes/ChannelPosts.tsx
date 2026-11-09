/**
 * Channel posts in MonoCode's Mono chat layout. Yours are its UserMessageBlock: a bubble on the
 * right, with Copy, Reply in thread and the time under it on hover. An agent's turn opens with
 * MonoTurnHeader's signature pill (engine logo and name), its text below, and TurnDuration's
 * action row under it on hover. Posts by the same author within five minutes share one header.
 * A root with replies gets a LaunchedSessionCard that opens its thread, and agents still on a
 * post show as MonoTurnHeader's live rows: the pill, then the shimmering work ticker.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent, ChannelDelivery, ChannelPost } from '../../shared/types.ts';
import { cost, duration, relativeTime, someNames } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { continuesGroup, seenBaseline, type Thread } from '../threads.ts';
import { Markdown } from '../ui/Markdown.tsx';
import { ChipButton, cx } from '../ui/common.tsx';
import { Bot, Chatting, ChevronDown, CircleAlert, Clock, Loader, MessageSquare } from '../mono/icons.tsx';
import { Shimmer } from '../mono/Shimmer.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { useNow } from '../ui/useNow.ts';
import { channelAttachmentUrl } from '../api.ts';
import { PostImages } from './ComposerImages.tsx';
import { MessageImages } from './ImageViews.tsx';
import { CopyTurnButton, DaySeparator, UserMessageBlock } from './Transcript.tsx';
import { AgentAvatar } from '../ui/Avatar.tsx';
import { AvatarStack } from '../ui/AvatarStack.tsx';

export const SPINNER = 'inline-block w-3.5 shrink-0 select-none text-center text-[11px] leading-none';

const DELIVERY_LABEL: Record<ChannelDelivery['status'], string> = {
  queued: 'Queued',
  working: 'Working',
  replied: 'Replied',
  failed: 'Failed',
  stopped: 'Stopped',
};

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Past this many recipients, a post shows counts per status until you expand it. */
const DELIVERY_LIST = 6;

/** Who a post started, and how far each of them got. Names open the agent. */
export function Deliveries({ to, agents }: { to: ChannelDelivery[]; agents: Agent[] }) {
  const [expanded, setExpanded] = useState(false);
  if (to.length > DELIVERY_LIST && !expanded) {
    const needYou = to.filter(d => d.status === 'working' && agents.find(a => a.id === d.agentId)?.status === 'waiting').length;
    const counts = (Object.keys(DELIVERY_LABEL) as ChannelDelivery['status'][])
      .map(status => [status, to.filter(d => d.status === status).length - (status === 'working' ? needYou : 0)] as const)
      .filter(([, n]) => n > 0);
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-content/60">{to.length} agents</span>
        {needYou ? <span className="text-warning">{needYou} need you</span> : null}
        {counts.map(([status, n]) => (
          <span key={status} className={`inline-flex items-center gap-1 ${status === 'failed' ? 'text-danger' : status === 'stopped' ? 'text-content/35' : 'text-content/50'}`}>
            {status === 'working' ? <TerminalSpinner className={SPINNER} /> : null}
            {n} {DELIVERY_LABEL[status].toLowerCase()}
          </span>
        ))}
        <button type="button" onClick={() => setExpanded(true)} className="rounded text-content/55 hover:text-content">Show everyone</button>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {to.length > DELIVERY_LIST ? <button type="button" onClick={() => setExpanded(false)} className="rounded text-content/55 hover:text-content">Show counts</button> : null}
      {to.map(d => {
        const agent = agents.find(a => a.id === d.agentId);
        const needsYou = d.status === 'working' && agent?.status === 'waiting';
        const tone = needsYou ? 'text-warning' : d.status === 'failed' ? 'text-danger' : d.status === 'stopped' ? 'text-content/35' : 'text-content/50';
        return (
          <button
            key={d.agentId}
            type="button"
            disabled={!agent}
            title={d.error ?? (agent ? `Open ${agent.name}` : undefined)}
            onClick={e => agent && openAgent(agent, e)}
            className="inline-flex items-center gap-1 rounded text-content/60 hover:text-content disabled:hover:text-content/60"
          >
            {agent ? <AgentAvatar agent={agent} className="size-3.5" /> : null}
            <span>{d.name}</span>
            {d.status === 'working' && !needsYou ? <TerminalSpinner className={SPINNER} /> : null}
            <span className={tone}>{needsYou ? 'Needs you' : DELIVERY_LABEL[d.status]}</span>
          </button>
        );
      })}
    </span>
  );
}

/** Agents still on these posts: from their deliveries, with those waiting on you apart. */
export function threadActivity(posts: readonly ChannelPost[], agents: readonly Agent[]): { working: Agent[]; waiting: Agent[] } {
  const working = new Map<string, Agent>();
  const waiting = new Map<string, Agent>();
  for (const post of posts) {
    for (const delivery of post.to) {
      if (delivery.status !== 'working') continue;
      const agent = agents.find(a => a.id === delivery.agentId);
      if (agent) (agent.status === 'waiting' ? waiting : working).set(agent.id, agent);
    }
  }
  for (const id of waiting.keys()) working.delete(id);
  return { working: [...working.values()], waiting: [...waiting.values()] };
}

function openAgent(agent: Agent, e: { metaKey: boolean; ctrlKey: boolean }) {
  (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id });
}

/** MonoCode's MonoSignaturePill. */
const PILL = 'flex min-w-0 items-center gap-1.5 rounded-full bg-content/[0.07] py-0.5 pl-2 pr-3';

/**
 * The author's signature pill: engine logo and name, as a Mono signs its turn. An agent's pill
 * opens it; one that has since been removed keeps a muted bot.
 */
function SignaturePill({ name, agent, removed }: { name: string; agent: Agent | undefined; removed: boolean }) {
  const mark = agent
    ? <AgentAvatar agent={agent} className="size-3.5" />
    : removed ? <Bot aria-hidden className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} /> : null;
  const label = <span className="min-w-0 truncate font-medium text-content/80">{name}</span>;
  if (!agent) return <span className={PILL}>{mark}{label}</span>;
  return (
    <button type="button" onClick={e => openAgent(agent, e)} title={`Open ${agent.name}`} className={cx(PILL, 'transition-colors duration-150 hover:bg-content/12')}>
      {mark}{label}
    </button>
  );
}

/** Most agents shown working before the rest fold into a count. */
const ACTIVITY_ROWS = 4;

/**
 * Who is on a channel or a thread right now, as MonoCode's live MonoTurnHeader: each agent's pill,
 * then what it is doing in the shimmering ticker, or that it needs you.
 */
export function ActivityLine({ working, waiting }: { working: Agent[]; waiting: Agent[] }) {
  const all = [...waiting, ...working];
  if (!all.length) return null;
  const shown = all.slice(0, ACTIVITY_ROWS);
  const rest = all.length - shown.length;
  return (
    <div role="status" aria-live="polite" className="pt-2">
      {shown.map(agent => (
        <div key={agent.id} className="flex min-w-0 items-center gap-1.5 px-4 py-1 font-sans text-sm text-content/50">
          <span className="max-w-[45%] shrink-0"><SignaturePill name={agent.name} agent={agent} removed={false} /></span>
          <span aria-hidden className="shrink-0 text-content/25">·</span>
          {agent.status === 'waiting'
            ? <span className="min-w-0 truncate text-warning">Needs you</span>
            : <Shimmer className="min-w-0 truncate font-sans text-sm" duration={1.6}>{agent.activity || 'Working…'}</Shimmer>}
        </div>
      ))}
      {rest > 0 ? (
        <p className="px-4 py-1 font-sans text-sm text-content/45">
          {`And ${someNames(all.slice(ACTIVITY_ROWS).map(a => a.name))}`}
        </p>
      ) : null}
    </div>
  );
}

/** MonoCode's quiet icon button, as Copy is under a message. */
function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="rounded-md p-1 text-content/40 hover:bg-content/8 hover:text-content/70">
      {children}
    </button>
  );
}

function ReplyAction({ onReply }: { onReply: () => void }) {
  return (
    <ActionButton label="Reply in thread" onClick={onReply}>
      <MessageSquare className="size-3.5" strokeWidth={1.75} />
    </ActionButton>
  );
}

/**
 * A root's thread as MonoCode's LaunchedSessionCard: how many replies and when the last came, with
 * who replied in its chip. The icon says whether anyone is still on it or waiting on you.
 */
function ThreadCard({ thread, agents, now, open: isOpen, onOpen }: { thread: Thread; agents: Agent[]; now: number; open: boolean; onOpen: () => void }) {
  const { working, waiting } = threadActivity(thread.replies, agents);
  const count = thread.replies.filter(r => r.kind !== 'event').length;
  const last = relativeTime(thread.lastReplyAt, now);
  const repliers = thread.participants.filter(p => p.from === 'agent');
  const state = waiting.length
    ? { label: `${someNames(waiting.map(a => a.name))} ${waiting.length > 1 ? 'need' : 'needs'} you`, icon: <Clock className="size-4 shrink-0 text-warning" strokeWidth={1.75} /> }
    : working.length
      ? { label: `${someNames(working.map(a => a.name))} working`, icon: <Loader className="size-4 shrink-0 animate-spin text-content/55 motion-reduce:animate-none" strokeWidth={1.75} /> }
      : undefined;
  const title = `${count} ${count === 1 ? 'reply' : 'replies'}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={isOpen}
      aria-label={`Open thread, ${title}${state ? `, ${state.label}` : ''}`}
      title={state?.label ?? 'View thread'}
      className={`flex w-fit max-w-[min(24rem,100%)] min-w-0 items-center gap-2.5 rounded-xl border py-1.5 pl-3 pr-1.5 text-left font-sans transition-colors hover:border-content/20 hover:bg-content/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${isOpen ? 'border-content/20 bg-content/5' : 'border-content/10'}`}
    >
      {state?.icon ?? <Chatting className="size-4 shrink-0 text-content/45" strokeWidth={1.75} />}
      <span className="min-w-0 truncate text-[13px] text-content">
        {title}
        <span className="text-content/45"> · {last === 'now' ? 'just now' : `${last} ago`}</span>
      </span>
      {repliers.length ? (
        <span className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-full border border-content/10 bg-content/5 px-2 py-0.5 text-[12px] text-content/65">
          <AvatarStack agents={[...new Set(repliers.map(p => p.agentId).filter((id): id is string => Boolean(id)))].reverse().map(id => agents.find(a => a.id === id) ?? { id })} max={3} size="size-3.5" />
          <span className="min-w-0 truncate">{someNames(repliers.map(p => agents.find(a => a.id === p.agentId)?.name ?? p.name))}</span>
        </span>
      ) : null}
    </button>
  );
}

function PostBody({ post, agent }: { post: ChannelPost; agent: Agent | undefined }) {
  if (post.kind === 'error') {
    return <pre className="min-w-0 whitespace-pre-wrap break-words font-sans text-sm text-danger">{post.text}</pre>;
  }
  if (post.kind === 'needs_you') {
    return (
      <div className="flex min-w-0 items-center gap-3 font-sans text-sm">
        <span className="min-w-0 truncate font-mono text-[13px] text-content/80" title={post.text}>{post.text}</span>
        {agent ? (
          <ChipButton onClick={() => open({ kind: 'agent', agentId: agent.id })}>Answer in {agent.name}</ChipButton>
        ) : null}
      </div>
    );
  }
  // Agents write Markdown; your posts render as UserMessageBlock bubbles in PostRow.
  return <Markdown text={post.text} className="text-content" />;
}

const LABEL: Partial<Record<ChannelPost['kind'], [string, string]>> = {
  error: ['hit a problem', 'text-danger'],
  needs_you: ['needs you', 'text-warning'],
};

/** Deliveries that still say something: anything but a finished reply, which the thread shows. */
function pendingDeliveries(post: ChannelPost): ChannelDelivery[] {
  return post.to.filter(d => d.status !== 'replied');
}

/** One post in MonoCode's chat layout. `grouped` drops the header under the previous post by the same author. */
function PostRow({ post, agents, grouped, thread, now, openThreadId, onOpenThread }: {
  post: ChannelPost;
  agents: Agent[];
  grouped: boolean;
  thread: Thread | undefined;
  now: number;
  openThreadId?: string;
  onOpenThread?: (rootId: string) => void;
}) {
  if (post.kind === 'event') {
    return <div className="px-4 py-1.5 text-center font-sans text-xs text-content/45">{post.text}</div>;
  }
  const agent = post.agentId ? agents.find(a => a.id === post.agentId) : undefined;
  const label = LABEL[post.kind];
  // Only top-level posts start threads; a reply whose root is not loaded is shown, not threaded.
  const canThread = Boolean(onOpenThread) && !post.threadId && !post.inReplyTo;
  const reply = canThread ? () => onOpenThread!(post.id) : undefined;
  const pending = pendingDeliveries(post);
  const card = thread && reply ? <ThreadCard thread={thread} agents={agents} now={now} open={openThreadId === post.id} onOpen={reply} /> : null;

  // Yours are MonoCode's UserMessageBlock, with who it started under the bubble.
  if (post.from === 'user') {
    return (
      <UserMessageBlock
        entry={{ id: post.id, agentId: '', text: post.text, ts: post.ts, mentions: post.mentions }}
        // Above the bubble, as MonoCode shows a message's images; a post can be images alone.
        media={post.images?.length ? <MessageImages images={post.images} url={image => channelAttachmentUrl(post.channelId, image)} /> : null}
        caption={pending.length ? <Deliveries to={pending} agents={agents} /> : undefined}
        footer={card ? <div className="flex max-w-full justify-end pt-2">{card}</div> : null}
        actions={reply ? <ReplyAction onReply={reply} /> : null}
      />
    );
  }

  const meta = [post.meta?.durationMs ? duration(post.meta.durationMs) : '', cost(post.meta?.costUsd)].filter(Boolean).join(', ');
  const dot = <span aria-hidden className="size-[3px] shrink-0 rounded-full bg-content/25" />;
  // An agent's turn: MonoTurnHeader's pill, the text, then TurnDuration's row on hover.
  return (
    <div data-chat-message={post.id} className={cx('transcript-turn transcript-turn-mono flex min-w-0 flex-col font-sans', grouped ? '' : 'pt-3')}>
      {grouped ? null : (
        <div className="flex min-w-0 items-center gap-1.5 px-4 py-1 font-sans text-sm text-content/50">
          <span className="max-w-[45%] shrink-0"><SignaturePill name={post.fromName} agent={agent} removed={post.from === 'agent'} /></span>
          {label ? (
            <>
              <span aria-hidden className="shrink-0 text-content/25">·</span>
              <span className={cx('shrink-0', label[1])}>{label[0]}</span>
            </>
          ) : null}
        </div>
      )}
      <div className={cx('min-w-0 px-4 pb-1', grouped ? '' : 'pt-1')}>
        {post.text ? <PostBody post={post} agent={agent} /> : null}
        <PostImages post={post} />
      </div>
      {pending.length ? <div className="px-4 pt-1 font-sans text-xs text-content/50"><Deliveries to={pending} agents={agents} /></div> : null}
      {card ? <div className="flex flex-col gap-2 px-4 pb-1 pt-2">{card}</div> : null}
      <div data-turn-actions className="turn-actions-hover flex w-full min-w-0 max-w-full items-center gap-2.5 overflow-hidden px-4 pb-3 pt-1 font-sans text-sm text-content/40">
        <span className="flex shrink-0 items-center gap-1">
          {post.text ? <CopyTurnButton text={post.text} label="Copy post" /> : null}
          {reply ? <ReplyAction onReply={reply} /> : null}
        </span>
        {meta ? <span className="flex min-w-0 items-center gap-2.5">{dot}<span className="min-w-0 truncate">{meta}</span></span> : null}
        <span className="flex shrink-0 items-center gap-2.5">
          {dot}
          <time dateTime={new Date(post.ts).toISOString()} title={new Date(post.ts).toLocaleString()} className="shrink-0 text-content/35">{clockTime(post.ts)}</time>
        </span>
      </div>
    </div>
  );
}

/**
 * Posts in order with a day separator between days, grouped by author. Pass `threads` and
 * `onOpenThread` for the main list; a thread panel passes `inThread`. `after` is the post shown
 * just above this list (a thread's root), so the first post only gets a separator on a new day.
 */
export function PostList({ posts, agents, threads, openThreadId, onOpenThread, inThread = false, after }: {
  posts: readonly ChannelPost[];
  agents: Agent[];
  threads?: ReadonlyMap<string, Thread>;
  /** The thread open beside the list, whose card shows as pressed. */
  openThreadId?: string;
  onOpenThread?: (rootId: string) => void;
  inThread?: boolean;
  after?: ChannelPost;
}) {
  const now = useNow();
  let previous: ChannelPost | undefined;
  let lastDay = after ? new Date(after.ts).toDateString() : undefined;
  return (
    <>
      {posts.map(post => {
        const day = new Date(post.ts).toDateString();
        const newDay = day !== lastDay;
        lastDay = day;
        // A post right under a thread card gets its own header, so the card reads as the root's.
        const grouped = !newDay && previous !== undefined && continuesGroup(previous, post) && !threads?.has(previous.id);
        previous = post;
        return (
          <div key={post.id}>
            {newDay ? <DaySeparator at={post.ts} /> : null}
            <PostRow post={post} agents={agents} grouped={grouped} thread={threads?.get(post.id)} now={now} openThreadId={openThreadId} onOpenThread={inThread ? undefined : onOpenThread} />
          </div>
        );
      })}
    </>
  );
}

/**
 * Keeps a scroller at the bottom while you are there, and tells you when posts arrive while
 * you have scrolled up. `count` is how many posts the scroller shows.
 */
export function useFollowLatest(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [seen, setSeen] = useState(count);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  // Rebases when the list shrinks (history replaced on reconnect or reload), so the next post is still announced.
  useEffect(() => { setSeen(s => seenBaseline(s, count, atBottom)); }, [atBottom, count]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = bottom;
    setAtBottom(bottom);
  };
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  return { ref, onScroll, jump, newPosts: atBottom ? 0 : Math.max(0, count - seen) };
}

/** MonoCode's TranscriptJumpToBottom, over the bottom of a scroller that has new posts below. */
export function JumpToLatest({ count, onClick }: { count: number; onClick: () => void }) {
  if (!count) return null;
  const label = `${count === 1 ? '1 new post' : `${count} new posts`}, jump to latest`;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 z-30 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={label}
        className="toast-in pointer-events-auto grid size-6 place-items-center rounded-md border border-content/15 bg-content/10 text-content shadow-md backdrop-blur-md hover:bg-content/5"
      >
        <ChevronDown className="size-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}
