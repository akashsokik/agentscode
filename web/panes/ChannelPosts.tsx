/**
 * Channel posts in MonoCode's chat layout: an agent's turn opens with its signature pill (engine
 * logo and name) and its text below; yours are bubbles on the right. Posts by the same author
 * within five minutes share one header. Hover shows the time, Reply in thread and Copy;
 * a root with replies gets a summary row that opens its thread.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent, ChannelDelivery, ChannelPost } from '../../shared/types.ts';
import { cost, duration, relativeTime, someNames } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { continuesGroup, participantMarks, seenBaseline, type Thread } from '../threads.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { MentionText } from '../ui/MentionText.tsx';
import { ChipButton, cx } from '../ui/common.tsx';
import { Bot, Check, ChevronDown, Copy, MessageSquare } from '../mono/icons.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { useNow } from '../ui/useNow.ts';
import { DaySeparator } from './Transcript.tsx';

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
            onClick={e => agent && (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id })}
            className="inline-flex items-center gap-1 rounded text-content/60 hover:text-content disabled:hover:text-content/60"
          >
            {agent ? <EngineIcon engine={agent.engine} className="size-3.5" /> : null}
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

/** "Ada is working…", "Ada and Bo need you": who is on a channel or a thread right now. */
export function ActivityLine({ working, waiting }: { working: Agent[]; waiting: Agent[] }) {
  if (!working.length && !waiting.length) return null;
  return (
    <div role="status" aria-live="polite" className="flex min-w-0 items-center gap-3 px-4 py-2 font-sans text-sm">
      {working.length ? (
        <span className="flex min-w-0 items-center gap-1.5 text-content/55">
          <TerminalSpinner className={SPINNER} />
          <span className="min-w-0 truncate">{`${someNames(working.map(m => m.name))} ${working.length > 1 ? 'are' : 'is'} working…`}</span>
        </span>
      ) : null}
      {waiting.length ? <span className="shrink-0 text-warning">{someNames(waiting.map(m => m.name))} {waiting.length > 1 ? 'need' : 'needs'} you</span> : null}
    </div>
  );
}

const PILL = 'flex min-w-0 items-center gap-1.5 rounded-full bg-content/[0.07] py-0.5 pl-2 pr-3';

/**
 * MonoCode's signature pill: the author's engine logo and name, as a Mono signs its turn.
 * An agent's pill opens it; one that has since been removed keeps a muted bot.
 */
function AuthorPill({ post, agent }: { post: ChannelPost; agent: Agent | undefined }) {
  const mark = agent
    ? <EngineIcon engine={agent.engine} className="size-3.5" />
    : post.from === 'agent' ? <Bot aria-hidden className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} /> : null;
  const name = <span className="min-w-0 truncate font-medium text-content/80">{post.fromName}</span>;
  if (!agent) return <span className={PILL}>{mark}{name}</span>;
  return (
    <button type="button" onClick={e => openAgent(agent, e)} title={`Open ${agent.name}`} className={cx(PILL, 'transition-colors duration-150 hover:bg-content/12')}>
      {mark}{name}
    </button>
  );
}

/** MonoCode's quiet action row: the time, Reply in thread and Copy, shown while you hover the post. */
function PostActions({ post, showTime, onReply, className }: { post: ChannelPost; showTime: boolean; onReply?: () => void; className?: string }) {
  return (
    <div className={cx('flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/post:opacity-100', className)}>
      {showTime ? <time dateTime={new Date(post.ts).toISOString()} title={new Date(post.ts).toLocaleString()} className="px-1 font-sans text-[11px] tabular-nums text-content/40">{clockTime(post.ts)}</time> : null}
      {onReply ? <ActionButton label="Reply in thread" onClick={onReply}><MessageSquare className="size-3.5" strokeWidth={1.75} /></ActionButton> : null}
      <CopyAction text={post.text} />
    </div>
  );
}

function openAgent(agent: Agent, e: { metaKey: boolean; ctrlKey: boolean }) {
  (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id });
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} className="grid size-6.5 place-items-center rounded text-content/55 transition-colors duration-100 hover:bg-content/10 hover:text-content">
      {children}
    </button>
  );
}

function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <ActionButton label={copied ? 'Copied' : 'Copy text'} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
      {copied ? <Check className="size-3.5" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
    </ActionButton>
  );
}

/** Under a root with replies: who replied, how many replies, and when the last one came. */
function ThreadSummary({ thread, agents, now, end = false, onOpen }: { thread: Thread; agents: Agent[]; now: number; end?: boolean; onOpen: () => void }) {
  // Everyone who replied: agents by engine, you by your initial, removed agents as a muted bot.
  const marks = participantMarks(thread.participants, agents);
  const { working, waiting } = threadActivity(thread.replies, agents);
  const count = thread.replies.filter(r => r.kind !== 'event').length;
  const last = relativeTime(thread.lastReplyAt, now);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx('group/thread mt-1 flex max-w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-left font-sans text-[12px] transition-colors duration-150 hover:border-content/10 hover:bg-background-base', end ? '-mr-1.5' : '-ml-1.5')}
    >
      {marks.length ? (
        <span className="flex shrink-0 items-center gap-0.5">
          {marks.slice(0, 5).map(mark => (
            <span key={mark.key} title={mark.kind === 'removed' ? `${mark.name} (removed)` : mark.name} className="grid size-4 place-items-center">
              {mark.kind === 'agent' ? <EngineIcon engine={mark.engine} className="size-4" />
                : mark.kind === 'removed' ? <Bot aria-hidden className="size-3.5 text-content/45" strokeWidth={1.75} />
                : <span aria-hidden className="grid size-4 place-items-center rounded bg-content/15 text-[9px] font-semibold uppercase leading-none text-content/70">{mark.name.trim()[0] ?? '?'}</span>}
            </span>
          ))}
          {marks.length > 5 ? <span className="pl-0.5 text-content/45">+{marks.length - 5}</span> : null}
        </span>
      ) : null}
      <span className="shrink-0 font-semibold text-accent">{count} {count === 1 ? 'reply' : 'replies'}</span>
      {waiting.length ? (
        <span className="shrink-0 text-warning">{someNames(waiting.map(a => a.name))} {waiting.length > 1 ? 'need' : 'needs'} you</span>
      ) : working.length ? (
        <span className="flex shrink-0 items-center gap-1 text-content/50"><TerminalSpinner className={SPINNER} />{someNames(working.map(a => a.name))} working</span>
      ) : null}
      <span className="min-w-0 truncate text-content/40 group-hover/thread:hidden">Last reply {last === 'now' ? 'just now' : `${last} ago`}</span>
      <span className="hidden min-w-0 truncate text-content/55 group-hover/thread:inline">View thread</span>
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
  // Agents write Markdown; your posts render as bubbles in PostRow.
  return <Markdown text={post.text} className="text-content" />;
}

const LABEL: Partial<Record<ChannelPost['kind'], [string, string]>> = {
  reply: ['replied', 'text-content/45'],
  error: ['hit a problem', 'text-danger'],
  needs_you: ['needs you', 'text-warning'],
};

/** One post in MonoCode's chat layout. `grouped` drops the header under the previous post by the same author. */
function PostRow({ post, agents, grouped, thread, now, inThread, onOpenThread }: {
  post: ChannelPost;
  agents: Agent[];
  grouped: boolean;
  thread: Thread | undefined;
  now: number;
  inThread: boolean;
  onOpenThread?: (rootId: string) => void;
}) {
  if (post.kind === 'event') {
    return <div className="px-4 py-1.5 text-center font-sans text-xs text-content/45">{post.text}</div>;
  }
  const agent = post.agentId ? agents.find(a => a.id === post.agentId) : undefined;
  // Inside a thread every agent post is a reply, so the label would only repeat itself.
  const label = post.kind === 'reply' && inThread ? undefined : LABEL[post.kind];
  const meta = [post.meta?.durationMs ? duration(post.meta.durationMs) : '', cost(post.meta?.costUsd)].filter(Boolean).join(', ');
  // Only top-level posts start threads; a reply whose root is not loaded is shown, not threaded.
  const canThread = Boolean(onOpenThread) && !post.threadId && !post.inReplyTo;
  const reply = canThread ? () => onOpenThread!(post.id) : undefined;
  const summary = thread && canThread ? <ThreadSummary thread={thread} agents={agents} now={now} end={post.from === 'user'} onOpen={reply!} /> : null;

  // Yours read as MonoCode's chat bubbles on the right: a pill for one line, rounded when it wraps.
  if (post.from === 'user') {
    return (
      <div data-chat-message={post.id} className={cx('group/post flex flex-col items-end pl-14 pr-4 font-sans', grouped ? 'pt-1' : 'pt-4')}>
        <div className="flex max-w-full items-center justify-end gap-2">
          <PostActions post={post} showTime onReply={reply} />
          <div className="w-fit min-w-0 max-w-[min(100%,36rem)] rounded-[18px] bg-content/10 px-3 py-2 text-sm leading-5 text-content">
            <p className="whitespace-pre-wrap break-words"><MentionText text={post.text} /></p>
          </div>
        </div>
        {post.to.length ? <div className="flex max-w-full justify-end pt-1.5 text-xs text-content/50"><Deliveries to={post.to} agents={agents} /></div> : null}
        {summary}
      </div>
    );
  }

  // An agent's turn opens with its signature pill; the text sits flush beneath it.
  return (
    <div data-chat-message={post.id} className={cx('group/post relative px-4 font-sans', grouped ? 'pt-1' : 'pt-4')}>
      {grouped ? null : (
        <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-sm text-content/50">
          <span className="flex min-w-0 max-w-[45%] shrink-0"><AuthorPill post={post} agent={agent} /></span>
          {label ? <span className={cx('shrink-0', label[1])}>{label[0]}</span> : null}
          <span aria-hidden className="shrink-0 text-content/25">·</span>
          <time dateTime={new Date(post.ts).toISOString()} title={new Date(post.ts).toLocaleString()} className="shrink-0 text-xs tabular-nums text-content/40">{clockTime(post.ts)}</time>
          {meta ? <span className="min-w-0 truncate text-xs text-content/35">{meta}</span> : null}
        </div>
      )}
      <PostBody post={post} agent={agent} />
      {post.to.length ? <div className="pt-1 text-xs text-content/50"><Deliveries to={post.to} agents={agents} /></div> : null}
      {summary}
      {/* Under the reply, as MonoCode does; a grouped post has no header, so its time shows here. */}
      <PostActions post={post} showTime={grouped} onReply={reply} className="-ml-1.5 mt-0.5" />
    </div>
  );
}

/**
 * Posts in order with a day separator between days, grouped by author. Pass `threads` and
 * `onOpenThread` for the main list; a thread panel passes `inThread`. `after` is the post shown
 * just above this list (a thread's root), so the first post only gets a separator on a new day.
 */
export function PostList({ posts, agents, threads, onOpenThread, inThread = false, after }: {
  posts: readonly ChannelPost[];
  agents: Agent[];
  threads?: ReadonlyMap<string, Thread>;
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
        // A post right under a thread summary gets its own header, so the summary reads as the root's.
        const grouped = !newDay && previous !== undefined && continuesGroup(previous, post) && !threads?.has(previous.id);
        previous = post;
        return (
          <div key={post.id}>
            {newDay ? <DaySeparator at={post.ts} /> : null}
            <PostRow post={post} agents={agents} grouped={grouped} thread={threads?.get(post.id)} now={now} inThread={inThread} onOpenThread={onOpenThread} />
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

/** Floats over the bottom of a scroller that has new posts below. */
export function JumpToLatest({ count, onClick }: { count: number; onClick: () => void }) {
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-[2] flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-content/10 bg-background-base px-3 py-1 font-sans text-[12px] text-content shadow-lg hover:bg-selection"
    >
      <ChevronDown className="size-3.5" strokeWidth={1.75} />
      {count === 1 ? '1 new post' : `${count} new posts`}, jump to latest
    </button>
  );
}
