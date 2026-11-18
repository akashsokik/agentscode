import type { ComposerCommand } from '../../shared/composer.ts';
import { mentionStart } from '../../shared/mentions.ts';

/*
 * The composer's `/` and `@` tokens and how their pickers rank what they offer, after MonoCode's
 * slashCommands.ts, fileMentions.ts, fileIndex.ts and shared/lib/fuzzy.ts. No DOM, so it is tested
 * directly.
 */

// ---- PodCode's own commands ------------------------------------------------

/** Commands PodCode runs itself. They run only when they are the whole message. */
export const BUILTIN_COMMANDS: ComposerCommand[] = [
  {
    name: 'clear',
    description: 'Clear the conversation and start a fresh session',
    scope: 'podcode',
    source: 'podcode',
    // The server refuses these as messages (shared/commands.ts), so they run here too.
    aliases: ['new', 'reset'],
  },
];

/** The built-in command `text` is, alone, if any: "/clear" or "  /New  ". */
export function builtinCommand(text: string): ComposerCommand | undefined {
  const match = text.trim().match(/^\/([\w:.-]+)$/);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  return BUILTIN_COMMANDS.find(command => command.name === name || command.aliases?.includes(name));
}

// ---- fuzzy matching (MonoCode's shared/lib/fuzzy.ts) ----------------------------

export interface FuzzyHit {
  score: number;
  positions: number[];
}

/** Sequential fuzzy match: every query character in order, with bonuses for runs and word starts. */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, positions: [] };
  if (tokens.length === 1) return matchToken(tokens[0], text);
  const positions: number[] = [];
  let score = 0;
  for (const token of tokens) {
    const hit = matchToken(token, text);
    if (!hit) return null;
    score += hit.score;
    positions.push(...hit.positions);
  }
  positions.sort((a, b) => a - b);
  return { score, positions };
}

function matchToken(query: string, text: string): FuzzyHit | null {
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let consecutive = 0;
  let qi = 0;
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) {
      consecutive = 0;
      continue;
    }
    positions.push(i);
    consecutive += 1;
    score += 1 + consecutive * 4;
    if (i === 0 || isBreak(text[i - 1])) score += 14;
    else if (isUpper(text[i]) && !isUpper(text[i - 1])) score += 10;
    qi += 1;
  }
  if (qi !== needle.length) return null;
  score -= hay.length - needle.length;
  return { score, positions };
}

function isBreak(ch: string): boolean {
  return ch === '/' || ch === '\\' || ch === '-' || ch === '_' || ch === '.' || ch === ' ' || ch === ':';
}

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}

/** Prefer a hit in the file's name over one only in its folders. Positions index `relative`. */
export function scorePath(query: string, relative: string, name: string): FuzzyHit | null {
  const needle = query.trim();
  if (!needle) return { score: 0, positions: [] };
  const offset = Math.max(0, relative.length - name.length);
  const nameHit = fuzzyMatch(needle, name);
  if (nameHit) return { score: nameHit.score + 400, positions: nameHit.positions.map(index => index + offset) };
  return fuzzyMatch(needle, relative);
}

// ---- tokens --------------------------------------------------------------------

export interface Token {
  start: number;
  end: number;
  /** What has been typed after the `/` or `@`, up to the caret. */
  query: string;
}

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r';
}

function wordAround(text: string, cursor: number): { start: number; end: number; caret: number } {
  const caret = Math.min(text.length, Math.max(0, cursor));
  let start = caret;
  while (start > 0 && !isSpace(text[start - 1])) start -= 1;
  let end = start;
  while (end < text.length && !isSpace(text[end])) end += 1;
  return { start, end: Math.max(end, caret), caret };
}

/** The `/command` the caret is in, if the user is typing one. Paths like /Users/me are not. */
export function slashTokenAt(text: string, cursor: number): Token | null {
  const { start, end, caret } = wordAround(text, cursor);
  if (text[start] !== '/') return null;
  const typed = text.slice(start + 1, caret);
  if (!/^[a-zA-Z0-9_.:-]*$/.test(typed)) return null;
  return { start, end, query: typed };
}

/** Whether a token starts the message: the only place Claude Code runs a command. */
export function isLeading(text: string, token: Token): boolean {
  return text.slice(0, token.start).trim() === '';
}

/**
 * The `@mention` the caret is in, if the user is mentioning an agent, project or file. An @ inside
 * code, an email or a path is not one (mentionStart).
 */
export function mentionTokenAt(text: string, cursor: number, names: readonly string[] = [], phrases: readonly string[] = []): Token | null {
  return spacedMentionAt(text, cursor, names, phrases) ?? wordMentionAt(text, cursor);
}

/** The words of a text, lowercased, with where each starts: issue titles are matched word by word. */
function titleWords(text: string): { at: number; word: string }[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map(m => ({ at: m.index ?? 0, word: m[0].toLowerCase() }));
}

/**
 * Where each typed word starts a word of `title`, in order ("dup hand" in "Duplicate handling:
 * mark…"): the matched positions in the title, or null. A trailing space is a word still to come.
 */
export function titleWordPositions(query: string, title: string): number[] | null {
  const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const words = titleWords(title);
  const positions: number[] = [];
  let from = 0;
  for (const part of parts) {
    const index = words.findIndex((w, i) => i >= from && w.word.startsWith(part));
    if (index < 0) return null;
    for (let k = 0; k < part.length; k++) positions.push(words[index].at + k);
    from = index + 1;
  }
  return positions;
}

function wordMentionAt(text: string, cursor: number): Token | null {
  const { start, end, caret } = wordAround(text, cursor);
  if (!mentionStart(text, start)) return null;
  const typed = text.slice(start + 1, caret);
  if (typed.includes('@') || typed.length > 120) return null;
  return { start, end, query: typed };
}

/**
 * A mention of a name with spaces ("@Ada Lo" on the way to "Ada Lovelace"): the @ is words back, on
 * the same line, and what follows it is the start of such a name. Once a whole name is typed and a
 * space follows ("@Ada " where Ada is a name of its own), it is done, so the picker does not come back.
 */
function spacedMentionAt(text: string, cursor: number, names: readonly string[], phrases: readonly string[] = []): Token | null {
  const spaced = names.filter(n => /\s/.test(n)).map(n => n.toLowerCase());
  if (!spaced.length && !phrases.length) return null;
  const caret = Math.min(text.length, Math.max(0, cursor));
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  for (let at = caret - 1; at >= Math.max(lineStart, caret - 121); at--) {
    if (text[at] !== '@') continue;
    const typed = text.slice(at + 1, caret);
    if (!mentionStart(text, at) || !/\s/.test(typed) || typed.includes('@')) return null;
    const lower = typed.toLowerCase();
    if (/\s$/.test(typed) && names.some(n => n.toLowerCase() === lower.trimEnd())) return null;
    // A name with spaces typed so far, or words that each start a word of an issue title (ACH-62).
    // Not titles once the first word is a whole agent or project name: "@Bo p" stays @Bo, never an
    // issue that has a word starting "bo" (Rhea's M1).
    const named = names.some(n => n.toLowerCase() === lower.split(/\s+/)[0]);
    if (!spaced.some(n => n.startsWith(lower)) && (named || !phrases.some(p => titleWordPositions(typed, p)))) return null;
    return { start: at, end: wordAround(text, caret).end, query: typed };
  }
  return null;
}

/** `text` with the token replaced by `sigil` + `value` and a space after, and where the caret goes. */
export function replaceToken(text: string, token: Token, sigil: '/' | '@', value: string): { text: string; caret: number } {
  const rest = text.slice(token.end);
  const spacer = rest.startsWith(' ') ? '' : ' ';
  const next = `${text.slice(0, token.start)}${sigil}${value}${spacer}${rest}`;
  return { text: next, caret: token.start + 1 + value.length + 1 };
}

// ---- ranking ---------------------------------------------------------------------

const MAX_COMMANDS = 50;
const MAX_FILES = 30;

function scopeRank(command: ComposerCommand): number {
  if (command.scope === 'podcode') return 0;
  if (command.scope === 'project') return 1;
  if (command.scope === 'user') return 2;
  return 3;
}

/** Commands for the `/` picker: PodCode's first, then project, personal and plugin ones; fuzzy once typed. */
export function rankCommands(commands: ComposerCommand[], query: string, limit = MAX_COMMANDS): ComposerCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...commands].sort((a, b) => scopeRank(a) - scopeRank(b) || a.name.localeCompare(b.name)).slice(0, limit);
  }
  const scored: { command: ComposerCommand; score: number }[] = [];
  for (const command of commands) {
    const nameHit = fuzzyMatch(needle, command.name) ?? fuzzyMatch(needle, (command.aliases ?? []).join(' '));
    const hit = nameHit ?? fuzzyMatch(needle, command.description);
    if (!hit) continue;
    // An exact name or alias beats any fuzzy hit, so "/new" lands on /clear.
    const exact = command.name.toLowerCase() === needle || command.aliases?.includes(needle);
    scored.push({ command, score: (exact ? 2000 : 0) + (nameHit ? hit.score + 400 : hit.score) });
  }
  scored.sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name));
  return scored.slice(0, limit).map(row => row.command);
}

export interface RankedFile {
  /** Relative to the workspace; folders end without a slash. */
  relative: string;
  name: string;
  isDir: boolean;
  /** Matched character positions in `relative`. */
  positions: number[];
}

function entry(relative: string, isDir: boolean): RankedFile {
  return { relative, name: relative.slice(relative.lastIndexOf('/') + 1), isDir, positions: [] };
}

/** Every file, plus the folders above them, so a folder can be mentioned too. */
export function withFolders(files: string[]): RankedFile[] {
  const out: RankedFile[] = [];
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    let rel = '';
    for (let i = 0; i < parts.length - 1; i++) {
      rel = rel ? `${rel}/${parts[i]}` : parts[i];
      if (dirs.has(rel)) continue;
      dirs.add(rel);
      out.push(entry(rel, true));
    }
    out.push(entry(file, false));
  }
  return out;
}

function depth(relative: string): number {
  return relative.split('/').length;
}

/** Entries for the `@` picker: the shallowest first, folders before files, without a query; fuzzy after. */
export function rankFiles(entries: RankedFile[], query: string, limit = MAX_FILES): RankedFile[] {
  const needle = query.replace(/\/+$/, '').trim();
  if (!needle) {
    return [...entries]
      .sort((a, b) => depth(a.relative) - depth(b.relative) || Number(b.isDir) - Number(a.isDir) || a.relative.localeCompare(b.relative))
      .slice(0, limit);
  }
  const scored: { file: RankedFile; score: number }[] = [];
  for (const file of entries) {
    const hit = scorePath(needle, file.relative, file.name);
    if (hit) scored.push({ file: { ...file, positions: hit.positions }, score: hit.score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.relative.length - b.file.relative.length || a.file.relative.localeCompare(b.file.relative));
  return scored.slice(0, limit).map(row => row.file);
}

/** What a picked entry writes after the `@`: its path, with a slash for a folder. */
export function mentionValue(file: RankedFile): string {
  return file.isDir ? `${file.relative}/` : file.relative;
}

// ---- one @ picker: agents, projects, issues and files ------------------------------

export interface PickAgent { id: string; name: string }
export interface PickProject { id: string; name: string; path: string }
/** An issue as the picker needs it (a SuperIssue fits). */
export interface PickIssue { id: string; key: string; title: string; status: string; projectId?: string | null; updatedAt?: number }

export type MentionPick = (
  | { kind: 'agent'; agent: PickAgent; positions: number[] }
  | { kind: 'project'; project: PickProject; positions: number[] }
  | { kind: 'everyone'; positions: number[] }
  | { kind: 'issue'; issue: PickIssue; keyPositions: number[]; titlePositions: number[] }
  | { kind: 'file'; file: RankedFile }
) & {
  /** Named exactly as typed: listed first, under its own header. */
  best?: boolean;
};

const MAX_AGENTS = 8;
const MAX_PROJECTS = 6;
const MAX_ISSUES = 6;

/** What a pick writes in place of the @token: a name or path after the @, or an issue's bare key. */
export function pickValue(pick: MentionPick): string {
  if (pick.kind === 'agent') return pick.agent.name;
  if (pick.kind === 'project') return pick.project.name;
  if (pick.kind === 'everyone') return 'all';
  if (pick.kind === 'issue') return pick.issue.key;
  return mentionValue(pick.file);
}

/**
 * The text with a pick in place of the @token, and the caret after it. An issue goes in as its bare
 * key with no @ (ACH-62): the key is how issues are cited everywhere, and a sent message shows it as
 * the issue chip. Everything else keeps its @.
 */
export function applyMention(text: string, token: Token, pick: MentionPick): { text: string; caret: number } {
  if (pick.kind !== 'issue') return replaceToken(text, token, '@', pickValue(pick));
  const rest = text.slice(token.end);
  const spacer = rest.startsWith(' ') ? '' : ' ';
  const key = pick.issue.key;
  return { text: `${text.slice(0, token.start)}${key}${spacer}${rest}`, caret: token.start + key.length + 1 };
}

const CLOSED = new Set(['done', 'canceled']);

/**
 * Issues for the @ picker (ACH-62): none until something is typed. Then open issues whose key starts
 * with the query ("ach-2", "ach2"), or whose title has a word starting with each query word ("filt",
 * "dup hand"), at most six. An exact key lists its issue even when it is closed. Keys first, nearest
 * number first; then titles by how early the match starts, the most recently updated first.
 */
export function rankIssues(issues: readonly PickIssue[], query: string, limit = MAX_ISSUES): { issue: PickIssue; keyPositions: number[]; titlePositions: number[] }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const bare = needle.replace(/-/g, '');
  const scored: { issue: PickIssue; keyPositions: number[]; titlePositions: number[]; score: number }[] = [];
  for (const issue of issues) {
    const key = issue.key.toLowerCase();
    const exact = key === needle;
    if (!exact && CLOSED.has(issue.status)) continue;
    const num = Number(key.slice(key.lastIndexOf('-') + 1)) || 0;
    if (key.startsWith(needle) || key.replace(/-/g, '').startsWith(bare)) {
      const shown = key.startsWith(needle) ? needle.length : Math.min(key.length, bare.length + 1);
      scored.push({ issue, keyPositions: [...Array(shown).keys()], titlePositions: [], score: (exact ? 1e9 : 1e6) - num });
      continue;
    }
    const titlePositions = titleWordPositions(query, issue.title);
    if (titlePositions) scored.push({ issue, keyPositions: [], titlePositions, score: 1e3 - titlePositions[0] + (issue.updatedAt ?? 0) / 1e13 });
  }
  scored.sort((a, b) => b.score - a.score || a.issue.key.localeCompare(b.issue.key));
  return scored.slice(0, limit).map(({ issue, keyPositions, titlePositions }) => ({ issue, keyPositions, titlePositions }));
}

function rankNamed<T extends { name: string }>(items: T[], query: string, limit: number): { item: T; positions: number[]; score: number }[] {
  const needle = query.trim();
  if (!needle) return items.slice(0, limit).map(item => ({ item, positions: [], score: 0 }));
  const out: { item: T; positions: number[]; score: number }[] = [];
  for (const item of items) {
    const hit = fuzzyMatch(needle, item.name);
    if (hit) out.push({ item, positions: hit.positions, score: hit.score });
  }
  out.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  return out.slice(0, limit);
}

/**
 * The @ picker's rows, in groups: agents, then projects, then issues (ACH-62), then files, each ranked by the same fuzzy
 * match as before (rankFiles for files). A name typed exactly ("@ada" for Ada) leads, whatever its
 * group. `everyone` offers @all (channels with more than one member).
 */
export function rankMentions(input: { agents: PickAgent[]; projects: PickProject[]; issues?: readonly PickIssue[]; files: RankedFile[]; query: string; everyone?: boolean }): MentionPick[] {
  const needle = input.query.trim().toLowerCase();
  const agents: MentionPick[] = rankNamed(input.agents, input.query, MAX_AGENTS).map(r => ({ kind: 'agent', agent: r.item, positions: r.positions }));
  const projects: MentionPick[] = rankNamed(input.projects, input.query, MAX_PROJECTS).map(r => ({ kind: 'project', project: r.item, positions: r.positions }));
  const everyone: MentionPick[] = input.everyone && 'all'.startsWith(needle) ? [{ kind: 'everyone', positions: [] }] : [];
  const issues: MentionPick[] = rankIssues(input.issues ?? [], input.query).map(r => ({ kind: 'issue', ...r }));
  const files: MentionPick[] = rankFiles(input.files, input.query).map(file => ({ kind: 'file', file }));
  const all = [...agents, ...everyone, ...projects, ...issues, ...files];
  if (!needle) return all;
  const exact = all.filter(p => pickValue(p).replace(/\/$/, '').toLowerCase() === needle);
  return [...exact.map(p => ({ ...p, best: true })), ...all.filter(p => !exact.includes(p))];
}

/** The group a pick is listed under, for the picker's headers. */
export function pickGroup(pick: MentionPick): 'Best match' | 'Agents' | 'Projects' | 'Issues' | 'Files' {
  if (pick.best) return 'Best match';
  return pick.kind === 'agent' || pick.kind === 'everyone' ? 'Agents' : pick.kind === 'project' ? 'Projects' : pick.kind === 'issue' ? 'Issues' : 'Files';
}
