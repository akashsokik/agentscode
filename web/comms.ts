/**
 * The Comms page's model: direct agent-to-agent messages grouped into conversations, with what
 * MonoCode's Inbox shows for each item (a title, a status, whether it is new to you) and the
 * stops of its activity timeline. Pure functions only (no React or DOM), so node --test runs
 * them directly.
 */
import type { Conversation, PeerMessage } from '../shared/types.ts';
import { reportKind } from './peerText.ts';

export interface CommsThread {
  id: string;
  conversation: Conversation | undefined;
  /** Oldest first. */
  messages: PeerMessage[];
  /** Agent ids, in order of first appearance. */
  participants: string[];
  lastTs: number;
  /** Something is queued or being worked on, and the conversation has not been stopped. */
  active: boolean;
}

/** Group direct peer messages into conversations, newest activity first. Channel mentions live in their channel. */
export function commsThreads(messages: readonly PeerMessage[], conversations: readonly Conversation[]): CommsThread[] {
  const byId = new Map<string, PeerMessage[]>();
  for (const m of messages) {
    if (m.channelId) continue;
    const list = byId.get(m.conversationId);
    if (list) list.push(m);
    else byId.set(m.conversationId, [m]);
  }
  return [...byId.entries()].map(([id, unsorted]) => {
    const list = [...unsorted].sort((a, b) => a.ts - b.ts);
    const conversation = conversations.find(c => c.id === id);
    return {
      id,
      conversation,
      messages: list,
      participants: [...new Set(list.flatMap(m => [m.fromAgentId, m.toAgentId]))],
      lastTs: list[list.length - 1].ts,
      active: !conversation?.stopped && list.some(m => m.status === 'queued' || m.status === 'delivering'),
    };
  }).sort((a, b) => b.lastTs - a.lastTs);
}

/**
 * Where a conversation stands, most urgent first: stopped by you, someone working, something
 * waiting, a failure, a blocked or finished report, or every message handled.
 */
export type ThreadState = 'stopped' | 'working' | 'queued' | 'failed' | 'changes' | 'blocked' | 'approved' | 'done' | 'handled';

export function threadState(thread: Pick<CommsThread, 'conversation' | 'messages'>): ThreadState {
  if (thread.conversation?.stopped) return 'stopped';
  if (thread.messages.some(m => m.status === 'delivering')) return 'working';
  if (thread.messages.some(m => m.status === 'queued')) return 'queued';
  if (thread.messages[thread.messages.length - 1]?.status === 'failed') return 'failed';
  const last = thread.messages.findLast(m => m.report);
  const report = last?.report;
  // A review reads as the work it answers: changes needed, or approved (web/peerText.ts).
  const review = last ? reportKind(last, thread.messages.find(m => m.id === last.replyTo)) === 'review' : false;
  if (report?.outcome === 'failed') return review ? 'changes' : 'failed';
  if (report?.outcome === 'blocked') return 'blocked';
  if (report?.outcome === 'passed' && review) return 'approved';
  if (report) return 'done';
  return 'handled';
}

export const STATE_LABEL: Record<ThreadState, string> = {
  stopped: 'Stopped',
  working: 'Working',
  queued: 'Queued',
  failed: 'Failed',
  changes: 'Changes needed',
  blocked: 'Blocked',
  approved: 'Approved',
  done: 'Done',
  handled: 'Handled',
};

export type CommsFilter = 'all' | 'active' | 'attention';

/** Active: someone is on it or it is waiting. Attention: it failed or was reported blocked. */
export function inFilter(state: ThreadState, filter: CommsFilter): boolean {
  if (filter === 'active') return state === 'working' || state === 'queued';
  if (filter === 'attention') return state === 'failed' || state === 'changes' || state === 'blocked';
  return true;
}

/** One line of plain text from markdown-ish agent prose: the first non-empty line, unmarked. */
export function plainLine(text: string, max = 140): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  const plain = line
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** The gist of one message: a report's summary, a delegation's task, or the message itself. */
export function messageGist(message: PeerMessage): string {
  return plainLine(message.report?.summary ?? message.delegation?.task ?? message.text);
}

/** A conversation's title, standing in for an issue's: what its first message asked for. */
export function threadTitle(thread: Pick<CommsThread, 'messages'>): string {
  for (const message of thread.messages) {
    const gist = messageGist(message);
    if (gist) return gist;
  }
  return 'Untitled conversation';
}

export type MessageKind = 'Report' | 'Delegation' | 'Reply' | 'Request' | 'Note';

export function messageKind(message: PeerMessage): MessageKind {
  if (message.report) return 'Report';
  if (message.delegation) return 'Delegation';
  if (message.replyTo) return 'Reply';
  return message.expectsReply ? 'Request' : 'Note';
}

/**
 * Whether a conversation matches what was typed in the filter box: every word has to appear
 * somewhere in its participants' names or its messages.
 */
export function matchesQuery(thread: Pick<CommsThread, 'messages'>, names: readonly string[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    ...names,
    ...thread.messages.flatMap(m => [
      m.fromName,
      m.toName,
      m.text,
      m.delegation?.task ?? '',
      m.delegation?.acceptanceCriteria ?? '',
      m.delegation?.context ?? '',
      m.report?.summary ?? '',
      m.report?.evidence ?? '',
    ]),
  ].join('\n').toLowerCase();
  return words.every(word => haystack.includes(word));
}

/** What the timeline shows after the messages, when anything. */
export type TimelineTail =
  | { kind: 'working'; agentId: string; name: string; forName: string }
  | { kind: 'budget'; used: number; limit: number }
  | { kind: 'stopped' };

export function timelineTail(thread: Pick<CommsThread, 'conversation' | 'messages'>): TimelineTail[] {
  const tail: TimelineTail[] = [];
  const stopped = !!thread.conversation?.stopped;
  if (!stopped) {
    const seen = new Set<string>();
    for (const m of thread.messages) {
      if (m.status !== 'delivering' || seen.has(m.toAgentId)) continue;
      seen.add(m.toAgentId);
      tail.push({ kind: 'working', agentId: m.toAgentId, name: m.toName, forName: m.fromName });
    }
  }
  const limit = thread.conversation?.messageLimit ?? 0;
  if (limit && thread.messages.length >= limit) tail.push({ kind: 'budget', used: thread.messages.length, limit });
  if (stopped) tail.push({ kind: 'stopped' });
  return tail;
}

/**
 * What you have looked at, MonoCode's inboxSeen: the newest message time you saw per
 * conversation. Conversations you never opened count as seen up to `since`, the moment the
 * store was first made, so everything from before then starts out read.
 */
export interface SeenStore {
  since: number;
  items: Record<string, number>;
}

export function isUnseen(thread: Pick<CommsThread, 'id' | 'lastTs'>, store: SeenStore): boolean {
  return thread.lastTs > (store.items[thread.id] ?? store.since);
}

/** The store with `threads` marked read up to their latest message. Returns `store` itself when nothing changes. */
export function markSeen(store: SeenStore, threads: readonly Pick<CommsThread, 'id' | 'lastTs'>[]): SeenStore {
  const unseen = threads.filter(t => isUnseen(t, store));
  if (!unseen.length) return store;
  const items = { ...store.items };
  for (const t of unseen) items[t.id] = t.lastTs;
  return { ...store, items };
}

/** Reads a stored SeenStore, or starts one at `now` when there is none or it is unreadable. */
export function parseSeen(raw: string | null, now: number): SeenStore {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const { since, items } = value as { since?: unknown; items?: unknown };
      if (typeof since === 'number' && Number.isFinite(since) && items && typeof items === 'object' && !Array.isArray(items)) {
        const clean: Record<string, number> = {};
        for (const [id, ts] of Object.entries(items)) if (typeof ts === 'number' && Number.isFinite(ts)) clean[id] = ts;
        return { since, items: clean };
      }
    }
  } catch {
    // Unreadable: start over.
  }
  return { since: now, items: {} };
}
