import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryEntry, ProfileEntry, ProfileProposal, UserProfile } from '../shared/types.ts';
import { checkEntry } from './agentHome.ts';
import { distinctive } from './dream.ts';
import { HttpError } from './errors.ts';

// The user profile: what AgentsCode learned about the user, shared by every agent. Memory is one
// agent's; this is about the person (style, taste, how they like to work) and holds across projects.
// It lives in the data dir, beside the agents' homes and outside every agent's cwd:
//   user.md             the entries, in a form a person can read and edit
//   user.proposals.json what waits for approval, and what the user rejected (never proposed again)
// Agents add entries with remember scope "user" and may forget only their own; a dream adds what the
// user said outright and proposes what it inferred; promotion proposes what two agents both remember.

/** About how long user.md may grow; it is given to every agent, so it stays short. */
export const PROFILE_LIMIT = 6000;
/** Proposals waiting at once; past this, new ones are refused until the user decides. */
export const PROPOSALS_MAX = 20;
/** Rejected texts kept, newest last, so nothing rejected comes back. */
const REJECTED_MAX = 200;

const PROFILE = 'user.md';
const PROPOSALS = 'user.proposals.json';
const HEADING = /^## ([0-9a-f]{8}) \(([^)]+)\)((?: \[(?:agent|dream) [\w.-]+\])*)\s*$/;
const TAG = /\[(agent|dream) ([\w.-]+)\]/g;

function flat(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** user.md as a person reads it; parseProfile reads it back. */
export function renderProfile(entries: ProfileEntry[]): string {
  const lines = [
    '# About the user',
    '',
    'AgentsCode keeps this file and gives it to every agent. Agents add what they learn about you; edit or delete entries in the app (About you, in the sidebar). A hand edit here must keep each entry under its "## <id> (<time>)" heading: lines outside an entry are dropped on the next write.',
  ];
  for (const entry of entries) {
    const when = new Date(entry.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const tags = `${entry.agentId ? ` [agent ${entry.agentId}]` : ''}${entry.dreamId ? ` [dream ${entry.dreamId}]` : ''}`;
    // A text line that could read as a heading or a field is escaped with a backslash.
    lines.push('', `## ${entry.id} (${when})${tags}`, /^(#|Why:|From:|\\)/.test(entry.text) ? `\\${entry.text}` : entry.text);
    if (entry.why) lines.push(`Why: ${entry.why}`);
    if (entry.from) lines.push(`From: ${entry.from}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Entries from user.md, oldest first. Anything that is not an entry is ignored. */
export function parseProfile(text: string): ProfileEntry[] {
  const entries: ProfileEntry[] = [];
  let current: (Omit<ProfileEntry, 'text'> & { text: string[] }) | null = null;
  const close = () => {
    if (current && current.text.length) {
      const { text: lines, ...rest } = current;
      entries.push({ ...rest, text: flat(lines.join(' ')) });
    }
    current = null;
  };
  for (const raw of text.split('\n')) {
    const heading = HEADING.exec(raw);
    if (heading) {
      close();
      const at = Date.parse(heading[2]);
      current = { id: heading[1], createdAt: Number.isNaN(at) ? 0 : at, text: [] };
      for (const [, kind, value] of heading[3].matchAll(TAG)) {
        if (kind === 'agent') current.agentId = value;
        else current.dreamId = value;
      }
      continue;
    }
    if (raw.startsWith('#')) { close(); continue; }
    const line = raw.trim();
    if (!current || !line) continue;
    if (line.startsWith('Why:')) current.why = flat(line.slice(4));
    else if (line.startsWith('From:')) current.from = flat(line.slice(5));
    else current.text.push(line.startsWith('\\') ? line.slice(1) : line);
  }
  close();
  // Field order as the server builds them, so a parsed entry compares equal to the one written.
  return entries.map(e => ({
    id: e.id, text: e.text, ...(e.why ? { why: e.why } : {}), createdAt: e.createdAt,
    ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.from ? { from: e.from } : {}), ...(e.dreamId ? { dreamId: e.dreamId } : {}),
  }));
}

/** The entries every agent is given: the oldest first, up to PROFILE_LIMIT characters of user.md. */
export function capProfile(entries: ProfileEntry[]): { entries: ProfileEntry[]; omitted: number } {
  let kept = entries.length;
  while (kept > 0 && renderProfile(entries.slice(0, kept)).length > PROFILE_LIMIT) kept--;
  return { entries: entries.slice(0, kept), omitted: entries.length - kept };
}

/** Whether a text says not to do something: never, not, no, don't, avoid, without. */
function negative(text: string): boolean {
  return /\b(?:never|not|no|none|nothing|don'?t|doesn'?t|won'?t|shouldn'?t|avoid|without|stop)\b|n't\b/i.test(text.replace(/[\u2018\u2019]/g, "'"));
}

/**
 * Whether two short texts state the same fact, by their distinctive words (see distinctive): they
 * share at least two (one when either has only one), covering most of the shorter text and a fair
 * part of the longer, and both say to do it or both say not to. Plain code, so promotion and the duplicate checks never call a model.
 */
export function sameFact(a: string, b: string): boolean {
  // distinctive drops "never", "not" and "always", so "Always use tabs" and "Never use tabs" share
  // every word: a fact and its reversal are never the same.
  if (negative(a) !== negative(b)) return false;
  const wa = distinctive(a);
  const wb = distinctive(b);
  if (!wa.length || !wb.length) return false;
  const shared = wa.filter(w => wb.some(v => [...w.forms].some(f => v.forms.has(f)))).length;
  const small = Math.min(wa.length, wb.length);
  const large = Math.max(wa.length, wb.length);
  return shared >= Math.min(2, small) && shared / small >= 0.6 && shared / large >= 0.4;
}

interface StoredProposals {
  pending: ProfileProposal[];
  rejected: { text: string; at: number }[];
}

const newId = (taken: Set<string>) => {
  let id = randomUUID().slice(0, 8);
  while (taken.has(id)) id = randomUUID().slice(0, 8);
  return id;
};

/** Whole seconds, as user.md records them, so an entry reads back the same. */
const second = (ms: number) => Math.floor(ms / 1000) * 1000;

export class ProfileStore {
  private dir: string;
  constructor(dataDir: string) { this.dir = dataDir; }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  /** Every entry in user.md, oldest first. capProfile trims what agents are given. */
  entries(): ProfileEntry[] {
    try {
      return parseProfile(fs.readFileSync(this.file(PROFILE), 'utf8'));
    } catch {
      return [];
    }
  }

  view(): UserProfile {
    return { entries: this.entries(), proposals: this.proposals(), file: this.file(PROFILE) };
  }

  /**
   * Save something about the user. An entry that says exactly the same thing already is returned as
   * it is, with `added: false`. Refused when it would take user.md over PROFILE_LIMIT.
   */
  add(rawText: unknown, rawWhy: unknown, meta: { agentId?: string; from?: string; dreamId?: string } = {}): { entry: ProfileEntry; added: boolean; entries: ProfileEntry[] } {
    const { text, why } = checkEntry(rawText, rawWhy);
    const entries = this.entries();
    const same = entries.find(e => e.text === text);
    if (same) return { entry: same, added: false, entries };
    const from = flat(meta.from);
    const entry: ProfileEntry = {
      id: newId(new Set(entries.map(e => e.id))), text, ...(why ? { why } : {}), createdAt: second(Date.now()),
      ...(meta.agentId ? { agentId: meta.agentId } : {}), ...(from ? { from } : {}), ...(meta.dreamId ? { dreamId: meta.dreamId } : {}),
    };
    const next = [...entries, entry];
    this.write(next, 'The user profile is full');
    return { entry, added: true, entries: next };
  }

  /**
   * Save something an agent or a dream learned, not the user: like add, but refused (409) when the
   * profile already says it in other words or the user rejected it before, and a waiting proposal
   * that says the same thing is resolved by it, so accepting that later adds no near-duplicate.
   */
  learn(rawText: unknown, rawWhy: unknown, meta: { agentId?: string; from?: string; dreamId?: string } = {}): { entry: ProfileEntry; added: boolean; entries: ProfileEntry[] } {
    const { text } = checkEntry(rawText, rawWhy);
    const same = this.entries().find(e => e.text === text);
    if (same) return { entry: same, added: false, entries: this.entries() };
    const problem = this.proposalProblem(text);
    if (problem === 'the profile already says it' || problem === 'the user rejected it before') throw new HttpError(409, `Not saved: ${problem}.`);
    const result = this.add(rawText, rawWhy, meta);
    const stored = this.stored();
    const pending = stored.pending.filter(p => p.text !== text && !sameFact(p.text, text));
    if (pending.length !== stored.pending.length) this.save({ ...stored, pending });
    return result;
  }

  /** Rewrite an entry (the user, in the app). Leaving `why` out keeps the old reason; an empty one clears it. */
  update(entryId: string, rawText: unknown, rawWhy?: unknown): { entry: ProfileEntry; entries: ProfileEntry[] } {
    const entries = this.entries();
    const old = entries.find(e => e.id === entryId);
    if (!old) throw new HttpError(404, 'That profile entry is gone.');
    const { text, why } = checkEntry(rawText, rawWhy === undefined ? old.why : rawWhy);
    if (entries.some(e => e.id !== entryId && e.text === text)) throw new HttpError(409, 'Another profile entry already says that.');
    const { why: _why, ...rest } = old;
    const entry: ProfileEntry = { ...rest, text, ...(why ? { why } : {}) };
    const next = entries.map(e => (e.id === entryId ? entry : e));
    this.write(next, 'That would make the user profile too long');
    return { entry, entries: next };
  }

  forget(entryId: string): { entry: ProfileEntry; entries: ProfileEntry[] } {
    const entries = this.entries();
    const entry = entries.find(e => e.id === String(entryId ?? '').trim());
    if (!entry) throw new HttpError(404, 'No profile entry with that id.');
    const next = entries.filter(e => e !== entry);
    this.write(next);
    return { entry, entries: next };
  }

  // ---- proposals --------------------------------------------------------------------------

  private stored(): StoredProposals {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(PROPOSALS), 'utf8')) as Partial<StoredProposals>;
      return { pending: Array.isArray(raw.pending) ? raw.pending : [], rejected: Array.isArray(raw.rejected) ? raw.rejected : [] };
    } catch {
      return { pending: [], rejected: [] };
    }
  }

  private save(stored: StoredProposals): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(PROPOSALS);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(stored)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  }

  /** What waits for approval, oldest first. */
  proposals(): ProfileProposal[] {
    return this.stored().pending;
  }

  /** Texts the user rejected, so a dream or promotion does not offer them again. */
  rejected(): string[] {
    return this.stored().rejected.map(r => r.text);
  }

  /**
   * Why this cannot be offered, or null: user.md or a waiting proposal already says it, the user
   * rejected it before, or too many wait already. Duplicates are judged by sameFact, not exact text.
   */
  proposalProblem(text: string): string | null {
    const stored = this.stored();
    if (this.entries().some(e => e.text === text || sameFact(e.text, text))) return 'the profile already says it';
    if (stored.pending.some(p => p.text === text || sameFact(p.text, text))) return 'already waiting for approval';
    if (stored.rejected.some(r => r.text === text || sameFact(r.text, text))) return 'the user rejected it before';
    if (stored.pending.length >= PROPOSALS_MAX) return `${PROPOSALS_MAX} proposals are already waiting`;
    return null;
  }

  /** Add a proposal after the entry checks (length, secrets) and proposalProblem. Throws HttpError(400 or 409) when refused. */
  propose(draft: Omit<ProfileProposal, 'id' | 'at' | 'text' | 'why'> & { text: unknown; why?: unknown }): ProfileProposal {
    const { text, why } = checkEntry(draft.text, draft.why);
    const problem = this.proposalProblem(text);
    if (problem) throw new HttpError(409, `Not proposed: ${problem}.`);
    const stored = this.stored();
    const from = flat(draft.from);
    const proposal: ProfileProposal = {
      id: newId(new Set(stored.pending.map(p => p.id))), kind: draft.kind, text, ...(why ? { why } : {}), at: second(Date.now()),
      ...(draft.agentId ? { agentId: draft.agentId } : {}), ...(from ? { from } : {}), ...(draft.dreamId ? { dreamId: draft.dreamId } : {}),
      ...(draft.sources?.length ? { sources: draft.sources } : {}),
    };
    this.save({ ...stored, pending: [...stored.pending, proposal] });
    return proposal;
  }

  /**
   * Accept a proposal: it becomes a user.md entry (refused, and left waiting, when user.md is full).
   * Reject one: it goes, and its text is kept so it is not proposed again.
   */
  decide(proposalId: string, action: 'accept' | 'reject'): { proposal: ProfileProposal; entry?: ProfileEntry } {
    const stored = this.stored();
    const proposal = stored.pending.find(p => p.id === proposalId);
    if (!proposal) throw new HttpError(404, 'That proposal is gone.');
    let entry: ProfileEntry | undefined;
    if (action === 'accept') {
      entry = this.add(proposal.text, proposal.why ?? '', { agentId: proposal.agentId, from: proposal.from, dreamId: proposal.dreamId }).entry;
    }
    const rejected = action === 'reject' ? [...stored.rejected, { text: proposal.text, at: Date.now() }].slice(-REJECTED_MAX) : stored.rejected;
    this.save({ pending: stored.pending.filter(p => p.id !== proposalId), rejected });
    return { proposal, ...(entry ? { entry } : {}) };
  }

  /** Drop the proposals a dream made (the dream was undone). Returns how many went. */
  dropFromDream(dreamId: string): number {
    const stored = this.stored();
    const pending = stored.pending.filter(p => p.dreamId !== dreamId);
    if (pending.length !== stored.pending.length) this.save({ ...stored, pending });
    return stored.pending.length - pending.length;
  }

  /**
   * Write user.md. With `over`, a change that leaves it over PROFILE_LIMIT and longer than it was is
   * refused, so an edit that shrinks an overgrown profile still goes through.
   */
  private write(entries: ProfileEntry[], over?: string): void {
    const text = renderProfile(entries);
    if (over && text.length > PROFILE_LIMIT && text.length > renderProfile(this.entries()).length) {
      throw new HttpError(400, `${over} (about ${PROFILE_LIMIT} characters). Delete or shorten entries in About you, in the sidebar, then try again.`);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(PROFILE);
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
  }
}

// ---- promotion: what several agents remember about the user ----------------------------------

export interface AgentMemory {
  agentId: string;
  agentName: string;
  entries: MemoryEntry[];
}

export type PromotionDraft = Omit<ProfileProposal, 'id' | 'at'> & { sources: NonNullable<ProfileProposal['sources']> };

/**
 * Facts two or more agents both remember, found by sameFact with no model call: each is offered once
 * as a proposal (never applied directly), worded as the shortest of its sources. A fact the profile,
 * a waiting proposal or a rejection already covers is skipped, and each memory entry joins at most one.
 */
export function findPromotions(memories: AgentMemory[], profile: ProfileStore): PromotionDraft[] {
  const used = new Set<string>();
  const drafts: PromotionDraft[] = [];
  const key = (agentId: string, entryId: string) => `${agentId}:${entryId}`;
  for (const [i, mine] of memories.entries()) {
    for (const entry of mine.entries) {
      if (used.has(key(mine.agentId, entry.id))) continue;
      const group = [{ owner: mine, entry }];
      for (const other of memories.slice(i + 1)) {
        if (other.agentId === mine.agentId) continue;
        const match = other.entries.find(e => !used.has(key(other.agentId, e.id)) && sameFact(entry.text, e.text));
        if (match) group.push({ owner: other, entry: match });
      }
      if (group.length < 2) continue;
      const text = group.map(g => g.entry.text).sort((a, b) => a.length - b.length)[0];
      if (profile.proposalProblem(text)) continue;
      for (const g of group) used.add(key(g.owner.agentId, g.entry.id));
      const names = group.map(g => g.owner.agentName);
      drafts.push({
        kind: 'promotion', text, why: `${names.slice(0, -1).join(', ')} and ${names.at(-1)} each remembered this.`, from: names.join(', '),
        sources: group.map(g => ({ agentId: g.owner.agentId, agentName: g.owner.agentName, entryId: g.entry.id, text: g.entry.text })),
      });
    }
  }
  return drafts;
}
