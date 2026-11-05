import type { ComposerCommand } from '../../shared/composer.ts';

/*
 * The composer's `/` and `@` tokens and how their pickers rank what they offer, after MonoCode's
 * slashCommands.ts, fileMentions.ts, fileIndex.ts and shared/lib/fuzzy.ts. No DOM, so it is tested
 * directly.
 */

// ---- AgentsCode's own commands ------------------------------------------------

/** Commands AgentsCode runs itself. They run only when they are the whole message. */
export const BUILTIN_COMMANDS: ComposerCommand[] = [
  {
    name: 'clear',
    description: 'Clear the conversation and start a fresh session',
    scope: 'agentscode',
    source: 'agentscode',
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

/** The `@path` the caret is in, if the user is mentioning a file. */
export function mentionTokenAt(text: string, cursor: number): Token | null {
  const { start, end, caret } = wordAround(text, cursor);
  if (text[start] !== '@') return null;
  const typed = text.slice(start + 1, caret);
  if (typed.includes('@') || typed.length > 120) return null;
  return { start, end, query: typed };
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
  if (command.scope === 'agentscode') return 0;
  if (command.scope === 'project') return 1;
  if (command.scope === 'user') return 2;
  return 3;
}

/** Commands for the `/` picker: AgentsCode's first, then project, personal and plugin ones; fuzzy once typed. */
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
