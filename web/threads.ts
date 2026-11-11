/**
 * Slack-style threads over a channel's posts, plus the small bits of channel UI state that
 * are easy to get wrong (drafts, the new-post count). Pure functions only (no React or DOM),
 * so node --test runs them directly.
 *
 * A reply's `threadId` names its top-level post. Posts saved before threads existed only
 * have `inReplyTo`, so their root is found by walking that chain. Events are never roots,
 * matching the server's threadRoot.
 */
import type { Agent, ChannelPost, EngineKind } from '../shared/types.ts';

/** Posts this close together from the same author share one header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * The id of the top-level post `post` belongs to, or null when it stands on its own.
 * The id comes back even when that root is not loaded. A broken (cyclic) chain, or one that
 * runs through an event, has no root, so the post stays in the main list.
 */
export function threadRootId(post: ChannelPost, byId: ReadonlyMap<string, ChannelPost>): string | null {
  if (post.threadId) return post.threadId === post.id ? null : post.threadId;
  if (!post.inReplyTo || post.kind === 'event') return null;
  const seen = new Set([post.id]);
  let id = post.inReplyTo;
  for (;;) {
    if (seen.has(id)) return null;
    seen.add(id);
    const parent = byId.get(id);
    if (!parent) return id;
    if (parent.kind === 'event') return null;
    if (parent.threadId) return parent.threadId === parent.id ? parent.id : parent.threadId;
    if (!parent.inReplyTo) return parent.id;
    id = parent.inReplyTo;
  }
}

export interface ThreadParticipant {
  /** 'user', or 'a:<agentId>' for an agent. */
  key: string;
  from: ChannelPost['from'];
  agentId?: string;
  name: string;
}

export interface Thread {
  rootId: string;
  /** Oldest first. */
  replies: ChannelPost[];
  /** Reply authors in order of their first reply. */
  participants: ThreadParticipant[];
  lastReplyAt: number;
}

export interface ChannelThreads {
  /** The main list, oldest first: top-level posts, plus replies whose root is not loaded. */
  main: ChannelPost[];
  /** Threads by root id; only roots that are loaded and have replies. */
  threads: Map<string, Thread>;
}

/** Split a channel's posts into the main list and the threads under it. */
export function buildThreads(posts: readonly ChannelPost[]): ChannelThreads {
  const byId = new Map(posts.map(p => [p.id, p]));
  const roots = new Map<string, string | null>();
  const rootOf = (post: ChannelPost) => {
    if (!roots.has(post.id)) roots.set(post.id, threadRootId(post, byId));
    return roots.get(post.id)!;
  };
  const main: ChannelPost[] = [];
  const threads = new Map<string, Thread>();
  for (const post of posts) {
    const rootId = rootOf(post);
    const root = rootId === null ? undefined : byId.get(rootId);
    // Only a loaded, top-level root that is not an event can hold a thread; anything else stays visible in the main list.
    if (!root || root.kind === 'event' || rootOf(root) !== null) {
      main.push(post);
      continue;
    }
    let thread = threads.get(root.id);
    if (!thread) threads.set(root.id, thread = { rootId: root.id, replies: [], participants: [], lastReplyAt: 0 });
    thread.replies.push(post);
    thread.lastReplyAt = Math.max(thread.lastReplyAt, post.ts);
    if (post.kind === 'event') continue;
    const key = post.from === 'agent' ? `a:${post.agentId ?? post.fromName}` : post.from;
    if (!thread.participants.some(p => p.key === key)) {
      thread.participants.push({ key, from: post.from, agentId: post.agentId, name: post.fromName });
    }
  }
  return { main, threads };
}

/** Posts whose header carries no status label, so they can share the previous header. */
const PLAIN = new Set<ChannelPost['kind']>(['post', 'reply']);

/**
 * Whether `post` continues `prev` under one header: same author, same day, within five
 * minutes, and neither is an event or a labelled post (a problem or an approval request).
 */
export function continuesGroup(prev: ChannelPost | undefined, post: ChannelPost): boolean {
  if (!prev || !PLAIN.has(prev.kind) || !PLAIN.has(post.kind)) return false;
  if (prev.from !== post.from || prev.agentId !== post.agentId || prev.fromName !== post.fromName) return false;
  if (post.ts < prev.ts || post.ts - prev.ts > GROUP_WINDOW_MS) return false;
  return new Date(prev.ts).toDateString() === new Date(post.ts).toDateString();
}

/** How a thread participant is drawn: an agent by its engine, you, or an agent since removed. */
export type ParticipantMark = { key: string; name: string } & (
  | { kind: 'agent'; engine: EngineKind }
  | { kind: 'user' }
  | { kind: 'removed' }
);

/** Every participant gets a mark; agents no longer in Podcode keep the name they posted under. */
export function participantMarks(participants: readonly ThreadParticipant[], agents: readonly Pick<Agent, 'id' | 'name' | 'engine'>[]): ParticipantMark[] {
  return participants.map(p => {
    if (p.from !== 'agent') return { key: p.key, name: p.name, kind: 'user' };
    const agent = p.agentId ? agents.find(a => a.id === p.agentId) : undefined;
    return agent ? { key: p.key, name: agent.name, kind: 'agent', engine: agent.engine } : { key: p.key, name: p.name, kind: 'removed' };
  });
}

/**
 * What stays in a composer after `sent` was posted: whatever was typed after it while the
 * post was in flight. If the sent text itself was edited meanwhile, everything stays.
 */
export function remainingDraft(current: string, sent: string): string {
  if (current === sent) return '';
  if (current.startsWith(sent)) return current.slice(sent.length).replace(/^\s+/, '');
  return current;
}

/**
 * After `sent` was posted from the composer saved under `key`, drop it from the shared draft,
 * keeping whatever was typed since by any composer on that key, including one that opened
 * after the post went out. Deletes the draft when nothing is left. Returns what is left.
 */
export function settleDraft(drafts: Map<string, string>, key: string, sent: string): string {
  const rest = remainingDraft(drafts.get(key) ?? '', sent);
  if (rest) drafts.set(key, rest);
  else drafts.delete(key);
  return rest;
}

/**
 * How many of a list's posts count as seen. At the bottom, all of them. A list that shrank
 * (a reconnect or reload returned a shorter window) rebases to its new length, so the next
 * post that arrives while you are scrolled up is still announced.
 */
export function seenBaseline(seen: number, count: number, atBottom: boolean): number {
  return atBottom || count < seen ? count : seen;
}
