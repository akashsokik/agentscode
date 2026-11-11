import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChannelPost, Entry, PeerMessage } from '../shared/types.ts';
import { findRefIds, type RefCitation } from '../shared/refs.ts';
import type { Store } from './store.ts';

// Where each note and decision id is cited: the user's and agents' own words in chats, channel
// posts, and messages between agents (handoffs and reports included). Read only; it never changes
// anything it reads.
//
// What counts, so a citation is counted once:
// - a chat entry the user typed or an agent wrote (kind user or agent). Not tool calls: their output
//   (ref_get, ref_search, note_add) repeats ids without anyone citing them. Not a user prompt posted
//   from a channel: the channel post is that citation;
// - a channel post by the user or an agent;
// - a message between agents, with its handoff or report; a message older than state.json keeps is
//   read from the copy in its recipient's chat;
// - the same author writing the same text twice (an agent's reply that is also posted in a channel
//   thread) counts once.
//
// Transcripts are append-only JSONL where a later line with the same entry id replaces the earlier
// one (streaming rewrites a reply many times). Each file is read once, then only the bytes added
// since; each entry's ids are replaced, never added to. Ids are kept whether or not they exist yet,
// so an id cited before it was recorded counts once it is.

interface Cited {
  ids: string[];
  ts: number;
  /** The author: an agent id, or "user". */
  author: string;
  hash: string;
  citation: Omit<RefCitation, 'key' | 'ts'>;
  /** For a peer entry: the message it copies. */
  messageId?: string;
}

interface FileState {
  offset: number;
  /** Bytes after the last newline read, waiting for the rest of their line. */
  partial: string;
  /** Entries that cite at least one id, by entry id. */
  cited: Map<string, Cited>;
  /** Each entry's kind and flags, by entry id, for later lines that leave them out. */
  kinds: Map<string, { kind: Entry['kind']; fromChannel: boolean }>;
}

const anyId = () => true;
/** Something shaped like an id somewhere in a line, before it is parsed. */
const CANDIDATE = /[A-Z][A-Z0-9]{1,5}-[DN][1-9]/;
/** The entry id a transcript line starts with (entries are written id first). */
const LINE_ID = /^\{"id":"([^"\\]*)"/;

function hashText(text: string): string {
  return createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** The words of a message an agent wrote, with its handoff or report. */
export function messageText(message: PeerMessage): string {
  const parts = [message.text];
  if (message.delegation) parts.push(message.delegation.task, message.delegation.acceptanceCriteria, message.delegation.context ?? '');
  if (message.report) parts.push(message.report.summary, message.report.evidence);
  return parts.filter(Boolean).join('\n');
}

/** "to Rhea", "to Rhea, handoff", "to Rhea, report". */
function messageWhere(message: PeerMessage): string {
  const what = message.delegation ? ', handoff' : message.report ? ', report' : '';
  return `to ${message.toName}${what}`;
}

export class RefMentions {
  private files = new Map<string, FileState>();
  private readonly dir: string;
  private store: Store;

  constructor(store: Store, transcriptsDir = path.join(store.dataDir, 'transcripts')) {
    this.store = store;
    this.dir = transcriptsDir;
  }

  private agentName(agentId: string): string {
    return this.store.agents.get(agentId)?.name ?? 'A removed agent';
  }

  /** Read what was added to every transcript since the last call. */
  private refresh(): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir).filter(n => n.endsWith('.jsonl')); } catch { names = []; }
    const live = new Set(names);
    for (const name of this.files.keys()) if (!live.has(name)) this.files.delete(name);
    for (const name of names) this.readFile(name);
  }

  private readFile(name: string): void {
    const file = path.join(this.dir, name);
    let size: number;
    try { size = fs.statSync(file).size; } catch { return; }
    let state = this.files.get(name);
    // Smaller than what was read: rewritten, so read it again from the start.
    if (!state || size < state.offset) {
      state = { offset: 0, partial: '', cited: new Map(), kinds: new Map() };
      this.files.set(name, state);
    }
    if (size === state.offset) return;
    const fd = fs.openSync(file, 'r');
    let chunk: string;
    try {
      const buffer = Buffer.alloc(size - state.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, state.offset);
      chunk = buffer.subarray(0, read).toString('utf8');
      state.offset += read;
    } finally {
      fs.closeSync(fd);
    }
    const text = state.partial + chunk;
    const lines = text.split('\n');
    state.partial = lines.pop() ?? '';
    const agentId = name.slice(0, -'.jsonl'.length);
    for (const line of lines) {
      if (!line) continue;
      // Most lines cite nothing: parse only those that could, and rewrites of an entry that did.
      if (!CANDIDATE.test(line)) {
        const head = LINE_ID.exec(line);
        if (!head || !state.cited.has(head[1])) continue;
      }
      let entry: Partial<Entry>;
      try { entry = JSON.parse(line) as Partial<Entry>; } catch { continue; }
      if (typeof entry.id !== 'string') continue;
      this.readEntry(state, agentId, entry);
    }
  }

  private readEntry(state: FileState, agentId: string, entry: Partial<Entry>): void {
    const id = entry.id!;
    const known = state.kinds.get(id);
    const kind = entry.kind ?? known?.kind;
    if (!kind) return;
    const fromChannel = entry.channel !== undefined ? Boolean(entry.channel) : known?.fromChannel ?? false;
    state.kinds.set(id, { kind, fromChannel });
    // A line without text (a meta update) leaves what the entry cites as it was.
    if (typeof entry.text !== 'string' && !entry.peer) return;
    const before = state.cited.get(id);
    let cited: Cited | null = null;
    if (kind === 'user' && !fromChannel) {
      const ids = this.ids(entry.text ?? '');
      if (ids.length) cited = { ids, ts: entry.ts ?? before?.ts ?? 0, author: 'user', hash: hashText(entry.text ?? ''), citation: { source: 'chat', who: 'You', where: `to ${this.agentName(agentId)}`, open: { kind: 'agent', agentId } } };
    } else if (kind === 'agent') {
      const ids = this.ids(entry.text ?? '');
      if (ids.length) cited = { ids, ts: entry.ts ?? before?.ts ?? 0, author: agentId, hash: hashText(entry.text ?? ''), citation: { source: 'chat', agentId, who: this.agentName(agentId), where: 'in your chat', open: { kind: 'agent', agentId } } };
    } else if (kind === 'peer' && entry.peer && !entry.peer.channelId) {
      const message = entry.peer;
      const text = messageText(message);
      const ids = this.ids(text);
      if (ids.length) cited = { ids, ts: message.ts, author: message.fromAgentId, hash: hashText(text), messageId: message.id, citation: { source: 'message', agentId: message.fromAgentId, who: message.fromName, where: messageWhere(message), open: { kind: 'comms', conversationId: message.conversationId } } };
    }
    if (cited) state.cited.set(id, cited);
    else state.cited.delete(id);
  }

  private ids(text: string): string[] {
    return [...new Set(findRefIds(text, anyId).map(m => m.id))];
  }

  /** Every citation of any id, deduplicated, newest first. */
  private all(): (Cited & { key: string })[] {
    this.refresh();
    const out: (Cited & { key: string })[] = [];
    const seen = new Set<string>();
    const add = (key: string, cited: Cited) => {
      const same = `${cited.author}|${cited.hash}`;
      if (seen.has(same)) return;
      seen.add(same);
      out.push({ ...cited, key });
    };
    const liveMessages = new Set<string>();
    for (const message of this.store.messages) {
      liveMessages.add(message.id);
      // A message in a channel shows there as a post; the post is the citation.
      if (message.channelId) continue;
      const text = messageText(message);
      const ids = this.ids(text);
      if (!ids.length) continue;
      add(`message:${message.id}`, { ids, ts: message.ts, author: message.fromAgentId, hash: hashText(text), citation: { source: 'message', agentId: message.fromAgentId, who: message.fromName, where: messageWhere(message), open: { kind: 'comms', conversationId: message.conversationId } } });
    }
    for (const [channelId, posts] of this.store.posts) {
      const channel = this.store.channels.get(channelId);
      for (const post of posts) this.addPost(post, channel?.name ?? 'deleted-channel', add);
    }
    for (const [name, state] of this.files) {
      for (const [entryId, cited] of state.cited) {
        if (cited.messageId && (liveMessages.has(cited.messageId) || seen.has(`message:${cited.messageId}`))) continue;
        if (cited.messageId) seen.add(`message:${cited.messageId}`);
        add(cited.messageId ? `message:${cited.messageId}` : `chat:${name}:${entryId}`, cited);
      }
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  private addPost(post: ChannelPost, channelName: string, add: (key: string, cited: Cited) => void): void {
    if (post.from === 'system' || (post.kind !== 'post' && post.kind !== 'reply')) return;
    const ids = this.ids(post.text);
    if (!ids.length) return;
    const author = post.from === 'user' ? 'user' : post.agentId ?? post.fromName;
    add(`post:${post.channelId}:${post.id}`, {
      ids,
      ts: post.ts,
      author,
      hash: hashText(post.text),
      citation: { source: 'channel', agentId: post.from === 'agent' ? post.agentId : undefined, who: post.from === 'user' ? 'You' : post.fromName, where: `in #${channelName}`, open: { kind: 'channel', channelId: post.channelId } },
    });
  }

  /** How many places cite each id. */
  counts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const cited of this.all()) for (const id of cited.ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }

  /** The places that cite one id, newest first, and how many there are in all. */
  citations(id: string, limit = 50): { citations: RefCitation[]; count: number } {
    const all = this.all().filter(c => c.ids.includes(id));
    return { count: all.length, citations: all.slice(0, limit).map(c => ({ key: c.key, ts: c.ts, ...c.citation })) };
  }
}
