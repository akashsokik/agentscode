import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.ts';
import { looksSecret } from './agentHome.ts';

// Project notes and decisions, shared by every agent: <dataDir>/projects/<CODE>/decisions.md and
// notes.md, plain Markdown a person can read and edit. Each project has a short permanent code (ACH);
// ALL holds what applies across projects. Ids (ACH-D7, ACH-N3) are assigned here only, per project
// and per kind, always increasing and never reused: a counter file remembers the highest id ever
// given, so an entry deleted by hand does not free its number. Tools only add; replacing a decision
// adds a new one and marks the old one "replaced by". The server is one process and every change is
// synchronous (read, assign, write), so two adds can never interleave.

export type RefKind = 'D' | 'N';

export interface RefEntry {
  /** ACH-D7 */
  id: string;
  code: string;
  kind: RefKind;
  num: number;
  title: string;
  /** "decided by" for a decision, "author" for a note. */
  by: string;
  date: string;
  why: string;
  /** "active", "replaced by ACH-D9", or whatever a hand edit wrote. */
  status: string;
  /** The id that replaced this decision, when status says so. */
  replacedBy?: string;
  /**
   * Who actually wrote it, recorded by the server from the caller's identity (an agent's name, or
   * "seed file"), so "decided by: You" is visibly an agent's claim. Absent on hand-written entries.
   */
  addedBy?: string;
  links: string[];
  /** The decision itself, or the note's text. */
  body: string;
}

export const ALL_CODE = 'ALL';
const CODE = /^[A-Z][A-Z0-9]{1,5}$/;

export const REF_TITLE_LIMIT = 120;
export const REF_BODY_LIMIT = 4000;
export const REF_WHY_LIMIT = 1000;
export const REF_BY_LIMIT = 80;
export const REF_LINK_LIMIT = 300;
export const REF_LINKS_MAX = 10;
/** The most one project's index takes in an agent's instructions. */
export const INDEX_LIMIT = 2500;
/** The most all the indexes together take (the SuperAgent's). */
export const ALL_INDEXES_LIMIT = 12000;
export const SEARCH_LIMIT = 20;

const FILE: Record<RefKind, string> = { D: 'decisions.md', N: 'notes.md' };
const COUNTERS = '.ids.json';
const PROJECT_INFO = 'project.json';
const SEED = 'seed.json';
/** What "added by" says on entries from seed.json. */
export const SEED_AUTHOR = 'seed file';
const SEEDED = '.seeded.json';
/** Codes the user chose, by folder or project name ({"acme-web": "ACM"}); kept in the data folder, not the repo. */
const PREFERRED_CODES = 'codes.json';

const HEADING = /^##\s+([A-Z][A-Z0-9]{1,5})-([DN])(\d{1,6})\s+(\S.*?)\s*$/;
const FIELD = /^-\s*(decided by|author|added by|date|why|status|links)\s*:\s*(.*?)\s*$/i;
/** "replaced by ACH-D9" on a decision, "outdated by ACH-N4" on a note. */
const REPLACED = /^(?:replaced|outdated) by\s+([A-Za-z][A-Za-z0-9]{1,5}-[DN]\d{1,6})\b/i;

function flat(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function isCode(code: string): boolean {
  return CODE.test(code);
}

/** "ach-d7" -> { code: ACH, kind: D, num: 7 }; null for anything else. */
export function parseRefId(raw: unknown): { id: string; code: string; kind: RefKind; num: number } | null {
  const match = /^\s*([A-Za-z][A-Za-z0-9]{1,5})-([DNdn])(\d{1,6})\s*$/.exec(String(raw ?? ''));
  if (!match) return null;
  const code = match[1].toUpperCase();
  const kind = match[2].toUpperCase() as RefKind;
  const num = Number(match[3]);
  if (!isCode(code) || num < 1) return null;
  return { id: `${code}-${kind}${num}`, code, kind, num };
}

/**
 * Entries in a decisions.md or notes.md, in file order. A block whose heading is not a valid id and
 * title, names another project or kind, or repeats an id already read is skipped whole; a missing
 * field reads as empty. Lines before the first heading are the file's own header.
 */
export function parseRefs(text: string, code: string, kind: RefKind): RefEntry[] {
  const entries: RefEntry[] = [];
  const ids = new Set<string>();
  let current: RefEntry | null = null;
  let inFields = false;
  let body: string[] = [];
  const close = () => {
    if (current) {
      current.body = body.join('\n').trim();
      entries.push(current);
      ids.add(current.id);
    }
    current = null;
    body = [];
  };
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^##(?!#)/.test(raw)) {
      close();
      const heading = HEADING.exec(raw);
      if (!heading) continue; // malformed heading: its block is skipped
      const id = `${heading[1]}-${heading[2]}${Number(heading[3])}`;
      if (heading[1] !== code || heading[2] !== kind || Number(heading[3]) < 1 || ids.has(id)) continue;
      current = { id, code, kind, num: Number(heading[3]), title: flat(heading[4]).slice(0, REF_TITLE_LIMIT), by: '', date: '', why: '', status: kind === 'D' ? 'active' : '', links: [], body: '' };
      inFields = true;
      continue;
    }
    if (/^#(?!#)/.test(raw)) { close(); continue; } // a top-level heading ends any block
    if (!current) continue;
    const entry: RefEntry = current;
    if (inFields) {
      if (!raw.trim() && !body.length && !hasFields(entry)) continue;
      const field = FIELD.exec(raw.trim());
      if (field) {
        const value = flat(field[2]);
        const name = field[1].toLowerCase();
        if (name === 'decided by' || name === 'author') entry.by = value;
        else if (name === 'added by') { if (value) entry.addedBy = value; }
        else if (name === 'date') entry.date = value;
        else if (name === 'why') entry.why = value;
        else if (name === 'links') entry.links = value.split(/\s*,\s*/).filter(Boolean);
        else if (name === 'status') {
          entry.status = value || entry.status;
          const replaced = REPLACED.exec(value);
          if (replaced) entry.replacedBy = replaced[1].toUpperCase();
        }
        continue;
      }
      inFields = false;
    }
    body.push(raw.startsWith('\\') ? raw.slice(1) : raw);
  }
  close();
  return entries;
}

function hasFields(entry: RefEntry): boolean {
  return Boolean(entry.by || entry.date || entry.why || entry.links.length);
}

/** One entry as Markdown, ending in a blank line; parseRefs reads it back. */
export function renderRef(entry: RefEntry): string {
  const lines = [`## ${entry.id}  ${entry.title}`];
  lines.push(`- ${entry.kind === 'D' ? 'decided by' : 'author'}: ${entry.by}`);
  lines.push(`- date: ${entry.date}`);
  if (entry.addedBy) lines.push(`- added by: ${entry.addedBy}`);
  if (entry.kind === 'D') {
    lines.push(`- why: ${entry.why}`);
    lines.push(`- status: ${entry.status}`);
  } else {
    if (entry.why) lines.push(`- why: ${entry.why}`);
    // A note has a status only once a newer one outdates it.
    if (entry.status) lines.push(`- status: ${entry.status}`);
  }
  lines.push(`- links:${entry.links.length ? ` ${entry.links.join(', ')}` : ''}`);
  for (let i = 1; i < lines.length; i++) lines[i] = lines[i].trimEnd();
  if (entry.body) {
    // A body line that could read as a heading is escaped with a backslash.
    lines.push('', ...entry.body.split('\n').map(line => (/^(#|\\)/.test(line) ? `\\${line}` : line)));
  }
  return `${lines.join('\n')}\n`;
}

function header(code: string, kind: RefKind): string {
  const what = kind === 'D' ? 'Decisions' : 'Notes';
  const tool = kind === 'D' ? 'decision_add' : 'note_add';
  return `# ${what} (${code})\n\nAgentsCode keeps this file. Agents add entries with ${tool}; ids are assigned by AgentsCode and never reused. You can edit it by hand: keep each entry's "## ${code}-${kind}<n>  Title" heading.\n`;
}

/** addedBy is the caller's identity, set by the server, never taken from tool input. */
export interface NoteInput { title: unknown; body: unknown; author: unknown; addedBy: string; links?: unknown; date?: string; /** A note in the same project this one corrects. */ replaces?: unknown }
export interface DecisionInput { title: unknown; decision: unknown; why: unknown; decidedBy: unknown; addedBy: string; replaces?: unknown; links?: unknown; date?: string }

function checkText(value: unknown, limit: number, what: string, required: boolean, multiline = false): string {
  const text = multiline ? String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim() : flat(value);
  if (required && !text) throw new HttpError(400, `Give ${what}.`);
  if (text.length > limit) throw new HttpError(400, `Keep ${what} under ${limit} characters.`);
  if (looksSecret(text)) throw new HttpError(400, 'That looks like a password, key or token. Never store secrets in project notes; note where the secret lives instead.');
  return text;
}

function checkLinks(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.length > REF_LINKS_MAX) throw new HttpError(400, `Give at most ${REF_LINKS_MAX} links.`);
  // A comma separates links on the links line, so it cannot be inside one.
  return list.map(link => checkText(link, REF_LINK_LIMIT, 'each link', false).replace(/,/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function checkDate(date: string | undefined): string {
  if (date === undefined) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'A date is YYYY-MM-DD.');
  return date;
}

/** Who decided or wrote something: a name, never text posing as the server's "added by". */
function checkBy(value: unknown, what: string): string {
  const by = checkText(value, REF_BY_LIMIT, what, true);
  if (/added\s*by/i.test(by)) throw new HttpError(400, `Give just a name for ${what}; "added by" is recorded by AgentsCode.`);
  return by;
}

function noteMaker(code: string, input: NoteInput): (id: string, num: number) => RefEntry {
  const title = checkText(input.title, REF_TITLE_LIMIT, 'a title', true);
  const body = checkText(input.body, REF_BODY_LIMIT, 'the note', true, true);
  const by = checkBy(input.author, 'the author');
  const links = checkLinks(input.links);
  const date = checkDate(input.date);
  const addedBy = checkText(input.addedBy, REF_BY_LIMIT, 'who added it', true);
  if (!isCode(code)) throw new HttpError(400, `Not a project code: ${JSON.stringify(code)}.`);
  return (id, num) => ({ id, code, kind: 'N', num, title, by, date, why: '', status: '', links, body, addedBy });
}

export interface SeedEntry {
  key: string;
  project: string;
  type: 'decision' | 'note';
  title: string;
  decision?: string;
  body?: string;
  why?: string;
  decided_by?: string;
  author?: string;
  date?: string;
  /** The seed key (or the id) of a decision this one replaces. */
  replaces?: string;
  links?: string[];
}

export class ProjectRefs {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  dir(code: string): string {
    if (!isCode(code)) throw new HttpError(400, `Not a project code: ${JSON.stringify(code)}.`);
    return path.join(this.root, code);
  }

  private file(code: string, kind: RefKind): string {
    return path.join(this.dir(code), FILE[kind]);
  }

  private read(code: string, kind: RefKind): string {
    try {
      return fs.readFileSync(this.file(code, kind), 'utf8');
    } catch {
      return '';
    }
  }

  /** Every entry of one kind in one project, in file order. Never throws on a bad file. */
  entries(code: string, kind: RefKind): RefEntry[] {
    try {
      return parseRefs(this.read(code, kind), code, kind);
    } catch (err) {
      console.error(`[refs] could not read ${code} ${FILE[kind]}:`, (err as Error).message);
      return [];
    }
  }

  /** The codes that have a folder, ALL included when it has one. */
  codes(): string[] {
    try {
      return fs.readdirSync(this.root, { withFileTypes: true }).filter(e => e.isDirectory() && isCode(e.name)).map(e => e.name).sort();
    } catch {
      return [];
    }
  }

  /** The project a code's folder was made for, if it recorded one. */
  projectInfo(code: string): { name?: string; path?: string } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir(code), PROJECT_INFO), 'utf8')) as unknown;
      return raw && typeof raw === 'object' ? raw as { name?: string; path?: string } : null;
    } catch {
      return null;
    }
  }

  /** The user's own codes from <root>/codes.json, by lower-case folder or project name; {} when there is none. */
  preferredCodes(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.root, PREFERRED_CODES), 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out: Record<string, string> = Object.create(null);
      for (const [name, code] of Object.entries(raw)) if (typeof code === 'string' && isCode(code.toUpperCase())) out[name.toLowerCase()] = code.toUpperCase();
      return out;
    } catch {
      return {};
    }
  }

  recordProject(code: string, info: { name: string; path: string }): void {
    const dir = this.dir(code);
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, PROJECT_INFO), `${JSON.stringify({ name: info.name, path: info.path }, null, 2)}\n`);
  }

  /**
   * The next number for a kind: past the counter and past every id-shaped heading in the file,
   * including malformed blocks the parser skips, so no number is ever given twice.
   */
  private nextNumber(code: string, kind: RefKind, text: string): number {
    let top = this.counters(code)[kind] ?? 0;
    const loose = new RegExp(`^##\\s+${code}-${kind}(\\d{1,6})(?!\\d)`, 'gm');
    for (const match of text.matchAll(loose)) top = Math.max(top, Number(match[1]));
    return top + 1;
  }

  private counters(code: string): Partial<Record<RefKind, number>> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir(code), COUNTERS), 'utf8')) as Record<string, unknown>;
      const out: Partial<Record<RefKind, number>> = {};
      for (const kind of ['D', 'N'] as RefKind[]) if (Number.isInteger(raw[kind]) && (raw[kind] as number) > 0) out[kind] = raw[kind] as number;
      return out;
    } catch {
      return {};
    }
  }

  /** Append a new entry, and mark a replaced decision; one synchronous step from read to write. */
  private append(code: string, kind: RefKind, make: (id: string, num: number) => RefEntry, replaces?: string): RefEntry {
    const dir = this.dir(code);
    fs.mkdirSync(dir, { recursive: true });
    let text = this.read(code, kind);
    const existing = parseRefs(text, code, kind);
    let target: RefEntry | undefined;
    const what = kind === 'D' ? 'decision' : 'note';
    if (replaces !== undefined) {
      // A decision replaces a decision, a note outdates a note, always in the same project.
      const ref = parseRefId(replaces);
      if (!ref) throw new HttpError(400, `replaces takes a ${what} id such as ${code}-${kind}7.`);
      if (ref.kind !== kind) throw new HttpError(400, `${ref.id} is a ${ref.kind === 'D' ? 'decision' : 'note'}; a ${what} can only replace a ${what}.`);
      if (ref.code !== code) throw new HttpError(400, `${ref.id} belongs to ${ref.code}; a ${what} can only replace one in the same project.`);
      target = existing.find(e => e.id === ref.id);
      if (!target) throw new HttpError(404, `There is no ${what} ${ref.id}.`);
      if (!isCurrent(target)) throw new HttpError(409, `${ref.id} is already ${target.status}.`);
    }
    const num = this.nextNumber(code, kind, text);
    const entry = make(`${code}-${kind}${num}`, num);
    if (target) text = markReplaced(text, target.id, `${kind === 'D' ? 'replaced' : 'outdated'} by ${entry.id}`);
    if (!text.trim()) text = header(code, kind);
    text = `${text.replace(/\n*$/, '\n')}\n${renderRef(entry)}`;
    // The counter first: a crash between the two writes leaves a gap, never a reused id.
    writeAtomic(path.join(dir, COUNTERS), `${JSON.stringify({ ...this.counters(code), [kind]: num })}\n`);
    writeAtomic(this.file(code, kind), text);
    return entry;
  }

  addNote(code: string, input: NoteInput): RefEntry {
    const make = noteMaker(code, input);
    const replaces = input.replaces === undefined || input.replaces === null || input.replaces === '' ? undefined : String(input.replaces);
    return this.append(code, 'N', make, replaces);
  }

  /**
   * Check a note and tell the id it will get, without writing anything: commit() writes it. For a
   * note that may only exist once something else succeeded (a lesson, once its message is sent).
   * Call commit() in the same synchronous run, so no other add can take the id in between; if one
   * did, commit() refuses rather than write a note under an id nobody was told.
   */
  prepareNote(code: string, input: NoteInput): { id: string; commit: () => RefEntry } {
    const make = noteMaker(code, input);
    const id = `${code}-N${this.nextNumber(code, 'N', this.read(code, 'N'))}`;
    return {
      id,
      commit: () => {
        if (`${code}-N${this.nextNumber(code, 'N', this.read(code, 'N'))}` !== id) throw new Error(`${id} was taken before the note was written.`);
        return this.append(code, 'N', make);
      },
    };
  }

  addDecision(code: string, input: DecisionInput): RefEntry {
    const title = checkText(input.title, REF_TITLE_LIMIT, 'a title', true);
    const body = checkText(input.decision, REF_BODY_LIMIT, 'the decision', true, true);
    const why = checkText(input.why, REF_WHY_LIMIT, 'why', false);
    const by = checkBy(input.decidedBy, 'who decided');
    const links = checkLinks(input.links);
    const date = checkDate(input.date);
    const addedBy = checkText(input.addedBy, REF_BY_LIMIT, 'who added it', true);
    const replaces = input.replaces === undefined || input.replaces === null || input.replaces === '' ? undefined : String(input.replaces);
    return this.append(code, 'D', (id, num) => ({ id, code, kind: 'D', num, title, by, date, why, status: 'active', links, body, addedBy }), replaces);
  }

  get(rawId: unknown): RefEntry | null {
    const ref = parseRefId(rawId);
    if (!ref) return null;
    return this.entries(ref.code, ref.kind).find(e => e.id === ref.id) ?? null;
  }

  /** Entries with every word of the query in their id, title, text, reason, author or links; newest first. */
  search(query: unknown, codes?: string[], limit = SEARCH_LIMIT): RefEntry[] {
    const words = flat(query).toLowerCase().split(' ').filter(Boolean);
    if (!words.length) throw new HttpError(400, 'Give words to search for.');
    const found: RefEntry[] = [];
    for (const code of codes ?? this.codes()) {
      for (const kind of ['D', 'N'] as RefKind[]) {
        for (const entry of this.entries(code, kind)) {
          const hay = [entry.id, entry.title, entry.body, entry.why, entry.by, entry.status, ...entry.links].join('\n').toLowerCase();
          if (words.every(word => hay.includes(word))) found.push(entry);
        }
      }
    }
    return found.sort((a, b) => (b.date.localeCompare(a.date)) || (b.num - a.num)).slice(0, limit);
  }

  counts(code: string): { decisions: number; active: number; notes: number } {
    const decisions = this.entries(code, 'D');
    return { decisions: decisions.length, active: decisions.filter(d => isActive(d)).length, notes: this.entries(code, 'N').filter(isCurrent).length };
  }

  /** The compact index of one project: active decisions, then notes, then replaced ones; newest first in each. */
  index(code: string, limit = INDEX_LIMIT): string {
    return refIndex([...this.entries(code, 'D'), ...this.entries(code, 'N')], limit);
  }

  /**
   * Apply <root>/seed.json once: each entry, by its key, is added the first time and never again
   * (.seeded.json records the key and the id it got). An entry whose title is already in its project
   * is recorded and not added again, in case the record was lost. A bad entry is reported and skipped.
   */
  seed(file = path.join(this.root, SEED)): { added: RefEntry[]; skipped: string[] } {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[refs] could not read ${file}:`, (err as Error).message);
      return { added: [], skipped: [] };
    }
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { entries?: unknown })?.entries) ? (raw as { entries: unknown[] }).entries : [];
    const seededFile = path.join(this.root, SEEDED);
    let seeded: Record<string, string> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(seededFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) seeded = parsed as Record<string, string>;
    } catch { /* none yet */ }
    const added: RefEntry[] = [];
    const skipped: string[] = [];
    for (const item of list as SeedEntry[]) {
      const key = String(item?.key ?? '');
      if (!key || Object.hasOwn(seeded, key)) continue;
      try {
        const code = String(item.project ?? '').toUpperCase();
        if (!isCode(code)) throw new Error(`bad project ${JSON.stringify(item.project)}`);
        const kind: RefKind = item.type === 'note' ? 'N' : 'D';
        const same = this.entries(code, kind).find(e => e.title === flat(item.title));
        if (same) {
          seeded[key] = same.id;
          writeAtomic(seededFile, `${JSON.stringify(seeded, null, 2)}\n`);
          continue;
        }
        const replaces = item.replaces ? (Object.hasOwn(seeded, item.replaces) ? seeded[item.replaces] : item.replaces) : undefined;
        const entry = kind === 'D'
          ? this.addDecision(code, { title: item.title, decision: item.decision ?? item.title, why: item.why ?? '', decidedBy: item.decided_by ?? 'You', addedBy: SEED_AUTHOR, replaces, links: item.links, date: item.date })
          : this.addNote(code, { title: item.title, body: item.body ?? item.title, author: item.author ?? 'You', addedBy: SEED_AUTHOR, links: item.links, date: item.date });
        seeded[key] = entry.id;
        added.push(entry);
      } catch (err) {
        console.error(`[refs] seed ${key} skipped:`, (err as Error).message);
        skipped.push(key);
        continue;
      }
      writeAtomic(seededFile, `${JSON.stringify(seeded, null, 2)}\n`);
    }
    return { added, skipped };
  }
}

export function isActive(entry: RefEntry): boolean {
  return entry.kind === 'D' && !entry.replacedBy && /^active$/i.test(entry.status);
}

/** A decision in force, or a note nothing has outdated (a note's status is set only when one has). */
export function isCurrent(entry: RefEntry): boolean {
  return entry.kind === 'D' ? isActive(entry) : !entry.replacedBy && !entry.status;
}

/** Index lines for entries, capped at `limit` characters with a note of how many were left out. */
export function refIndex(entries: RefEntry[], limit = INDEX_LIMIT): string {
  const newest = (a: RefEntry, b: RefEntry) => b.num - a.num;
  const ordered = [
    ...entries.filter(e => e.kind === 'D' && isActive(e)).sort(newest),
    ...entries.filter(e => e.kind === 'N' && isCurrent(e)).sort(newest),
    // Replaced decisions and outdated notes last.
    ...entries.filter(e => !isCurrent(e)).sort(newest),
  ];
  const line = (e: RefEntry) => {
    const title = e.title.length > 100 ? `${e.title.slice(0, 99)}...` : e.title;
    const status = isCurrent(e) ? (e.kind === 'N' ? 'note' : 'active') : e.status;
    // Who decided is a claim; who added it is recorded by the server.
    const who = [e.kind === 'D' && e.by ? `decided by ${e.by}` : '', e.addedBy ? `added by ${e.addedBy}` : ''].filter(Boolean).join(', ');
    return `- ${e.id} ${title} (${status}${who ? `; ${who}` : ''})`;
  };
  const lines: string[] = [];
  let used = 0;
  for (const entry of ordered) {
    const next = line(entry);
    // Room is kept for the note on what was left out.
    if (used + next.length + 1 > limit - 60) break;
    lines.push(next);
    used += next.length + 1;
  }
  const omitted = ordered.length - lines.length;
  if (omitted) lines.push(`(${omitted} more left out; find them with ref_search)`);
  return lines.join('\n');
}

/** Set the status line of one block ("replaced by ..." or "outdated by ..."), adding the line if there is none. */
function markReplaced(text: string, oldId: string, status: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex(line => {
    const heading = HEADING.exec(line);
    return heading && `${heading[1]}-${heading[2]}${Number(heading[3])}` === oldId;
  });
  if (start < 0) return text;
  let end = lines.findIndex((line, i) => i > start && /^#/.test(line));
  if (end < 0) end = lines.length;
  let lastField = start;
  for (let i = start + 1; i < end; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed && lastField === start) continue;
    if (!FIELD.test(trimmed)) break;
    lastField = i;
    if (/^-\s*status\s*:/i.test(trimmed)) {
      lines[i] = `- status: ${status}`;
      return lines.join('\n');
    }
  }
  lines.splice(lastField + 1, 0, `- status: ${status}`);
  return lines.join('\n');
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * A permanent code for a project: the user's choice in codes.json (by folder or name), the code of a
 * folder made for the same path before, or one derived from its name; never ALL and never one taken.
 */
export function deriveCode(project: { name: string; path: string }, taken: Set<string>, refs?: ProjectRefs): string {
  const free = (code: string) => isCode(code) && code !== ALL_CODE && !taken.has(code);
  const preferred = refs?.preferredCodes() ?? {};
  const pick = (name: string) => (Object.hasOwn(preferred, name) ? preferred[name] : undefined);
  const known = pick(path.basename(project.path).toLowerCase()) ?? pick(project.name.toLowerCase());
  if (known && free(known)) return known;
  const folders = refs?.codes() ?? [];
  const mine = folders.find(code => free(code) && refs?.projectInfo(code)?.path === project.path);
  if (mine) return mine;
  const blocked = (code: string) => !free(code) || (folders.includes(code) && refs?.projectInfo(code)?.path !== project.path);
  const words = project.name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(w => /^[A-Z]/.test(w));
  const letters = words.join('');
  const candidates: string[] = [];
  if (words.length >= 3) candidates.push(words.slice(0, 3).map(w => w[0]).join(''));
  if (words.length === 2) candidates.push(`${words[0][0]}${words[1].slice(0, 2)}`.padEnd(3, 'X'));
  if (letters.length >= 3) candidates.push(letters.slice(0, 3));
  const base = letters ? (candidates[0] ?? letters.padEnd(3, 'X')).slice(0, 3) : 'PRJ';
  candidates.push(base);
  for (let i = 2; i < letters.length; i++) candidates.push(`${base.slice(0, 2)}${letters[i]}`);
  for (const code of candidates) if (!blocked(code)) return code;
  for (let n = 2; n < 1000; n++) if (!blocked(`${base}${n}`)) return `${base}${n}`;
  throw new Error('No free project code.');
}

/** Words too common to say what a task is about. */
const STOP = new Set(('the and for with that this from into onto when then than what which while where have has had will would should could '
  + 'must make made keep only once every each them they their there here your yours about after before also just more most some such '
  + 'over under very does done doing using used task work agent agents please need needs want wants like file files code change changes').split(' '));

/** The words that say what a text is about: four letters or more, lower case, a plural "s" dropped. */
export function topicWords(text: string): Set<string> {
  const words = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w));
  return new Set(words.map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
}

export const HINT_MAX = 5;

/**
 * Decisions in force whose titles share words with a task: at least two words, or the one word
 * of a one-word title. Best match first, then newest; ids the text already names are left
 * out. A cheap word match, not a search: it only points the receiver at what to check.
 */
export function matchDecisions(decisions: RefEntry[], text: string, max = HINT_MAX): RefEntry[] {
  const words = topicWords(text);
  const named = new Set((String(text ?? '').toUpperCase().match(/\b[A-Z][A-Z0-9]{1,5}-D\d{1,6}\b/g) ?? []));
  const scored = decisions.flatMap(d => {
    if (!isActive(d) || named.has(d.id)) return [];
    const title = topicWords(d.title);
    const score = [...title].filter(w => words.has(w)).length;
    return score >= 2 || (score === 1 && title.size === 1) ? [{ d, score }] : [];
  });
  return scored.sort((a, b) => b.score - a.score || b.d.num - a.d.num).slice(0, max).map(s => s.d);
}

/** The line added to a task or message: which decisions in force to check, or '' when none match. */
export function decisionHint(matches: RefEntry[]): string {
  if (!matches.length) return '';
  const clipTitle = (t: string) => (t.length > 50 ? `${t.slice(0, 49)}...` : t);
  return `Decisions in force that may apply (check with ref_get): ${matches.map(d => `${d.id} ${clipTitle(d.title)}`).join('; ')}.`;
}
