import { inCode } from './mentions.ts';

// Note and decision ids (ACH-D7, XYZ-N2) as they appear in text, and the read-only views the Notes
// tab and the id chips use. The store itself is server/projectRefs.ts; this file has no Node in it,
// so the app and the server parse text the same way.

export type RefKind = 'D' | 'N';

/** An id as written: an upper-case project code, D or N, and a number with no leading zero. */
const REF_ID = /([A-Z][A-Z0-9]{1,5})-([DN])([1-9]\d{0,5})/g;

/** Characters that, right before an id, make it part of something else (a word, path, anchor, handle, flag). */
const BEFORE = /[\w/.#@\\-]/;
/** Characters that, right after an id, make it part of something else (ACH-D70, ACH-D7-x, ACH-D7_b). */
const AFTER = /[\w-]/;

export interface RefMatch {
  id: string;
  start: number;
  end: number;
}

/** Whether `index` is inside a URL or a domain-like token (https://x/ACH-D7, www.x.com?ACH-D7). */
function inUrl(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start, index);
  return /:\/\/|^www\.|\]\(/i.test(token) || /^[a-z][a-z0-9+.-]*:/i.test(token);
}

/**
 * The note and decision ids cited in plain text, in order. Only ids `known` accepts count, and never
 * inside code (inline or fenced), a URL, a path or a longer word. Lower case (ach-d7) is not an id
 * here: people write ids the way the app shows them, and this keeps prose like "x-d1" out.
 */
export function findRefIds(text: string, known: (id: string) => boolean): RefMatch[] {
  const out: RefMatch[] = [];
  if (!text) return out;
  for (const match of text.matchAll(REF_ID)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > 0 && BEFORE.test(text[start - 1])) continue;
    if (end < text.length && AFTER.test(text[end])) continue;
    // "ACH-D7.md" is a file name; "ACH-D7." ends a sentence.
    if (text[end] === '.' && end + 1 < text.length && /\w/.test(text[end + 1])) continue;
    if (!known(match[0])) continue;
    if (inUrl(text, start) || inCode(text, start)) continue;
    out.push({ id: match[0], start, end });
  }
  return out;
}

/** The kind of an id: D for a decision, N for a note. */
export function refKind(id: string): RefKind {
  return /-D\d+$/.test(id) ? 'D' : 'N';
}

/** The project code of an id: ACH for ACH-D7. */
export function refCode(id: string): string {
  return id.slice(0, id.lastIndexOf('-'));
}

/** In force, replaced, or a note; a hand-edited status that is neither reads as replaced (no longer in force). */
export type RefState = 'active' | 'replaced' | 'note';

/** One entry as the list and the chip popover show it. */
export interface RefSummary {
  id: string;
  code: string;
  kind: RefKind;
  num: number;
  title: string;
  state: RefState;
  /** The status line as written, for a hand-edited one ("superseded"). */
  status: string;
  /** The decision that replaced this one. */
  replacedBy?: string;
  /** The decision this one replaced (the one whose status names this id). */
  replaces?: string;
  /** Who decided (a decision) or wrote it (a note). */
  by: string;
  /** Who added it, recorded by Podcode; absent on older and hand-written entries. */
  addedBy?: string;
  /** YYYY-MM-DD as recorded. */
  date: string;
  /** The first words of the decision or note. */
  gist: string;
  /** How many places cite it (chats, channel posts, messages and handoffs). */
  mentions: number;
}

/** One place an id is cited. */
export interface RefCitation {
  key: string;
  ts: number;
  source: 'chat' | 'channel' | 'message';
  /** Who wrote it: an agent's id, or absent for the user. */
  agentId?: string;
  who: string;
  /** Where, after the name: "in your chat", "to Rhea, handoff", "in #release". */
  where: string;
  /** What to open: an agent's chat, a channel, or a conversation in Comms. */
  open: { kind: 'agent'; agentId: string } | { kind: 'channel'; channelId: string } | { kind: 'comms'; conversationId: string };
}

export interface RefDetail extends RefSummary {
  /** The decision itself, or the note's text. */
  body: string;
  why: string;
  links: string[];
  /** Links that are commit hashes. */
  commits: string[];
  /** Links that are other note or decision ids. */
  related: string[];
  /** Every other link, as written. */
  otherLinks: string[];
  citations: RefCitation[];
}

export interface RefProject {
  code: string;
  /** The project's name, "All projects" for ALL, or the code when nothing else is known. */
  name: string;
  /** The live project with this code, if there is one. */
  projectId?: string;
  decisions: number;
  notes: number;
  replaced: number;
}

export interface RefsIndex {
  projects: RefProject[];
  entries: RefSummary[];
}

export interface RefSearchHit {
  entry: RefSummary;
  /** Where the words were found; "body" and "why" come with the line they were found on. */
  field: 'title' | 'body' | 'why' | 'other';
  line?: string;
}

/** A commit hash link: 7 to 40 hex digits with at least one digit and one letter a-f, or a full hash. */
export function isCommit(link: string): boolean {
  return /^[0-9a-f]{7,40}$/.test(link) && /\d/.test(link) && (/[a-f]/.test(link) || link.length === 40);
}

const ANY_ID = /^[A-Z][A-Z0-9]{1,5}-[DN][1-9]\d{0,5}$/;

/** Split an entry's links into commits, other ids, and the rest. */
export function splitLinks(links: readonly string[]): { commits: string[]; related: string[]; other: string[] } {
  const commits: string[] = [];
  const related: string[] = [];
  const other: string[] = [];
  for (const raw of links) {
    const link = raw.trim();
    if (!link) continue;
    if (isCommit(link)) commits.push(link);
    else if (ANY_ID.test(link.toUpperCase())) related.push(link.toUpperCase());
    else other.push(link);
  }
  return { commits, related, other };
}

/**
 * The line of `text` where the first of `words` appears, cut to about `width` characters around it
 * with ellipses where it was cut. Null when no word is in the text.
 */
export function sourceLine(text: string, words: readonly string[], width = 90): string | null {
  const lower = text.toLowerCase();
  let at = -1;
  for (const word of words) {
    const i = lower.indexOf(word);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const lineEndRaw = text.indexOf('\n', at);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  let start = lineStart;
  let end = lineEnd;
  if (end - start > width) {
    start = Math.max(lineStart, at - Math.floor(width / 3));
    end = Math.min(lineEnd, start + width);
    // Do not cut a word in half.
    if (start > lineStart) { const space = text.indexOf(' ', start); if (space >= 0 && space < at) start = space + 1; }
    if (end < lineEnd) { const space = text.lastIndexOf(' ', end); if (space > at) end = space; }
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > lineStart ? '...' : ''}${body}${end < lineEnd ? '...' : ''}`;
}

/** The query's words, lower case, as the search and its highlight use them. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 12);
}
