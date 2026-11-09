import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, MemoryEntry } from '../shared/types.ts';
import { HttpError } from './errors.ts';

// Each agent has a private home, <dataDir>/agents/<id>/, never the user's own home folder:
// - soul.md is its standing instructions. The user writes it (in the app or by hand); Agent.instructions
//   mirrors it so the app can show it.
// - memory.md is what it learned: entries it saved with the remember tool, or that the user edited in
//   the app. AgentsCode writes the file, in a form a person can read.
// - workspace/ is where an agent with no project works. Its cwd is this folder, not the home, so
//   soul.md and memory.md sit outside it: edit tools that are auto-accepted inside the cwd (and Codex's
//   workspace-write sandbox) cannot reach them.

/** The most of soul.md an agent is given. */
export const SOUL_LIMIT = 8000;
/** About how long memory.md may grow before the agent has to consolidate or forget. */
export const MEMORY_LIMIT = 8000;
export const MEMORY_TEXT_LIMIT = 1000;
export const MEMORY_WHY_LIMIT = 500;

const SOUL = 'soul.md';
const MEMORY = 'memory.md';
/** The working folder of an agent with no project, inside its home. */
export const WORKSPACE = 'workspace';

/** Where an agent with no project works: a folder inside its home, so its own files are outside its cwd. */
export function workspacePath(home: string): string {
  return path.join(home, WORKSPACE);
}

/**
 * The files in an agent's home that only AgentsCode (and the user) write, by their top-level name:
 * soul.md, memory.md, a soul proposal, the dream records and state, the prompt bookkeeping and
 * history/. Anything else in the home (notes an agent saved there before it had a workspace) is not
 * reserved. Case-insensitive, as macOS file names are.
 */
const RESERVED = /^(?:soul\.md|memory\.md(?:\.tmp)?|soul\.proposed\.[^/\\]*|dreams?[.-][^/\\]*|dreaming\.[^/\\]*|\.dream[^/\\]*|\.prompt\.json|history)$/i;

/** Whether a path inside a home (relative to it) is, or is inside, one of its reserved files. */
export function reservedHomeFile(relative: string): boolean {
  const first = relative.split(/[/\\]/)[0];
  return Boolean(first) && RESERVED.test(first);
}
/** Which version of each prompt section the agent's current session has seen; server bookkeeping. */
const SEEN = '.prompt.json';
const ENTRY_HEADING = /^## ([0-9a-f]{8}) \(([^)]+)\)(?: \[dream ([\w.-]+)\])?\s*$/;

/** One line, single spaces: memories are short facts. */
function flat(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Not inside a longer name: `_` counts as part of a name, so these work where `\\b` does not. */
const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';

/**
 * A name that holds a secret, in any case or style: password, DB_PASSWORD, OPENAI_API_KEY,
 * MY_SERVICE_TOKEN, aws_secret_access_key, clientSecret.
 */
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key)[A-Za-z0-9_-]*';

/** The end of a value: a reference has to be the whole value, so "$ecr3t@x" is not "$ecr3t". */
const VALUE_END = String.raw`(?=$|[\s"'\`),;\]}])`;

/**
 * Where a secret lives, rather than the secret, as the whole value: an environment variable read
 * (process.env.X, import.meta.env.X, os.environ['X'], os.getenv('X'), ENV['X'], env.X), a shell or
 * template reference ($X, ${X}, ${{ secrets.X }}, {{ x }}, %X%), a secret manager reference
 * (op://..., vault:...), a placeholder (<your-key>), a path with at least two parts (~/..., ./...,
 * /etc/app/...), or a plain-English location ("see the 1Password item", "stored in the keychain").
 * A single character does not make a reference: ".hunter2", "/hunter2" and "{abc123}" are values.
 */
const REFERENCE = [
  String.raw`(?:process|import\.meta|Bun|Deno)\.env(?:\.[A-Za-z_]\w*|\[)`,
  String.raw`os\.(?:environ(?:\[|\.get\()|getenv\()`,
  String.raw`ENV\[`,
  String.raw`env\.[A-Za-z_]\w*${VALUE_END}`,
  String.raw`\$[A-Za-z_]\w*${VALUE_END}`,
  String.raw`\$\{\{?\s*[A-Za-z_][\w.-]*\s*\}\}?`,
  String.raw`\{\{\s*[A-Za-z_][\w.-]*\s*\}\}`,
  String.raw`%[A-Za-z_]\w*%${VALUE_END}`,
  String.raw`secrets\.[A-Za-z_]\w*${VALUE_END}`,
  String.raw`(?:op|vault|aws-sm|gcp-sm|keychain)://`,
  'vault:',
  String.raw`<[a-z][a-z _-]*>`,
  String.raw`(?:~|\.{1,2})/`,
  String.raw`/[\w.-]+/[\w./-]+`,
  String.raw`(?:see|stored|kept|saved|located)\s`,
  String.raw`(?:keychain|1password|bitwarden|lastpass|vault|doppler)(?![\w-]*\d)`,
].map(form => `(?:${form})`).join('|');

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  new RegExp(`${START}sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`), // Anthropic and OpenAI keys
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{30,}`), // GitHub tokens
  new RegExp(`${START}github_pat_[A-Za-z0-9_]{20,}`),
  new RegExp(`${START}npm_[A-Za-z0-9]{30,}`), // npm tokens
  new RegExp(`${START}AKIA[0-9A-Z]{16}${END}`), // AWS access key ids
  new RegExp(`${START}AIza[0-9A-Za-z_-]{35}`), // Google API keys
  new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}`), // Slack tokens
  new RegExp(`${START}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`), // Stripe keys
  new RegExp(`${START}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`), // JWTs
  // A secret's name given a literal value: DB_PASSWORD=..., api_key: "...", aws_secret_access_key = ...
  new RegExp(`${START}${SECRET_NAME}["']?\\s*[:=]\\s*["']?(?!(?:${REFERENCE}))[^\\s"']{6,}`, 'i'),
  // "the password is hunter2": a value with a digit after "password is".
  new RegExp(`${START}(?:password|passwd|passphrase)\\s+is\\s+["']?(?!(?:${REFERENCE}))(?=[^\\s"']*\\d)[^\\s"']{6,}`, 'i'),
  /:\/\/[^\s/:@]+:[^\s/@]{3,}@/, // credentials inside a URL
];

/** Share of a word made of readable parts ("Component", "with"), as in a camelCase name. */
function wordy(word: string): number {
  return (word.match(/[A-Z]?[a-z]{3,}/g) ?? []).join('').length / word.length;
}

/**
 * A long run of mixed letters and digits with no spaces, the shape of a key or token. Paths and
 * branch names (with a slash) and camelCase names (mostly readable parts) are not keys.
 */
function looksLikeKey(word: string): boolean {
  // Base64 image data (PNG, JPEG, GIF, WebP) is a picture, not a key.
  if (/^(?:data:image\/|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(word)) return false;
  // An AWS secret access key: 40 characters of base64, slashes allowed.
  if (/^[A-Za-z0-9/+]{40}$/.test(word) && !word.startsWith('/') && /[a-z]/.test(word) && /[A-Z]/.test(word) && /\d/.test(word) && wordy(word) < 0.5) return true;
  if (word.length < 32 || !/^[A-Za-z0-9+=_-]+$/.test(word)) return false;
  return /[a-z]/.test(word) && /[A-Z]/.test(word) && (word.match(/\d/g)?.length ?? 0) >= 3 && wordy(word) < 0.5;
}

/** Text that looks like it holds a password, key or token, which an agent must never store. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text)) || text.split(/[\s,;()"'`]+/).some(looksLikeKey);
}

/**
 * The entries an agent is given: the oldest first, up to MEMORY_LIMIT characters of memory.md, the
 * way soul.md is cut at SOUL_LIMIT. A file grown past that by hand keeps the rest for the app.
 */
export function capMemory(name: string, entries: MemoryEntry[]): { entries: MemoryEntry[]; omitted: number } {
  let kept = entries.length;
  while (kept > 0 && renderMemory(name, entries.slice(0, kept)).length > MEMORY_LIMIT) kept--;
  return { entries: entries.slice(0, kept), omitted: entries.length - kept };
}

/** memory.md as a person reads it; parseMemory reads it back. */
export function renderMemory(name: string, entries: MemoryEntry[]): string {
  const lines = [
    `# What ${name} remembers`,
    '',
    `AgentsCode keeps this file. ${name} adds entries with the remember tool and removes them with forget; you can edit or delete them in the app.`,
  ];
  for (const entry of entries) {
    const when = new Date(entry.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // A text line that could read as a heading or a reason is escaped with a backslash.
    const dream = entry.dreamId ? ` [dream ${entry.dreamId}]` : '';
    lines.push('', `## ${entry.id} (${when})${dream}`, /^(#|Why:|\\)/.test(entry.text) ? `\\${entry.text}` : entry.text);
    if (entry.why) lines.push(`Why: ${entry.why}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Entries from memory.md, oldest first. Anything that is not an entry is ignored. */
export function parseMemory(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  let current: { id: string; createdAt: number; text: string[]; why?: string; dreamId?: string } | null = null;
  const close = () => {
    if (current && current.text.length) {
      entries.push({
        id: current.id, text: flat(current.text.join(' ')), ...(current.why ? { why: current.why } : {}), createdAt: current.createdAt,
        ...(current.dreamId ? { dreamId: current.dreamId } : {}),
      });
    }
    current = null;
  };
  for (const raw of text.split('\n')) {
    const heading = ENTRY_HEADING.exec(raw);
    if (heading) {
      close();
      const at = Date.parse(heading[2]);
      current = { id: heading[1], createdAt: Number.isNaN(at) ? 0 : at, text: [], ...(heading[3] ? { dreamId: heading[3] } : {}) };
      continue;
    }
    if (raw.startsWith('#')) { close(); continue; }
    const line = raw.trim();
    if (!current || !line) continue;
    if (line.startsWith('Why:')) current.why = flat(line.slice(4));
    else current.text.push(line.startsWith('\\') ? line.slice(1) : line);
  }
  close();
  return entries;
}

export class AgentHomes {
  private root: string;
  constructor(root: string) { this.root = root; }

  /**
   * An agent's home. Ids are generated by the server, but a bad one must never name the root or
   * anything outside it: remove('') would otherwise delete every agent's home.
   */
  path(agentId: string): string {
    const id = String(agentId ?? '');
    if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) throw new Error(`Not an agent id: ${JSON.stringify(id)}.`);
    const root = path.resolve(this.root);
    const home = path.resolve(root, id);
    if (path.dirname(home) !== root) throw new Error(`An agent's home must be directly inside ${root}.`);
    return home;
  }

  /**
   * Make sure the home exists. soul.md starts from the agent's instructions; an existing soul.md
   * is left as it is.
   */
  ensure(agent: Agent): string {
    const home = this.path(agent.id);
    fs.mkdirSync(home, { recursive: true });
    const soul = path.join(home, SOUL);
    if (!fs.existsSync(soul)) fs.writeFileSync(soul, soulText(agent.instructions));
    return home;
  }

  /** The working folder of an agent with no project (see workspacePath), made if it is missing. */
  workspace(agent: Agent): string {
    const dir = workspacePath(this.ensure(agent));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** soul.md exactly as it is on disk, past SOUL_LIMIT too: what a soul proposal is checked against. */
  soulFile(agent: Agent): string {
    this.ensure(agent);
    return fs.readFileSync(path.join(this.path(agent.id), SOUL), 'utf8');
  }

  /** The standing instructions from soul.md, as the agent is given them: cut at SOUL_LIMIT. */
  readSoul(agent: Agent): string {
    return this.soulFile(agent).trim().slice(0, SOUL_LIMIT);
  }

  writeSoul(agent: Agent, text: string): string {
    this.ensure(agent);
    const soul = String(text ?? '').trim().slice(0, SOUL_LIMIT);
    fs.writeFileSync(path.join(this.path(agent.id), SOUL), soulText(soul));
    return soul;
  }

  /** Every entry in memory.md, oldest first. The app lists them all; capMemory trims what the agent is given. */
  memory(agent: Agent): MemoryEntry[] {
    const file = path.join(this.path(agent.id), MEMORY);
    if (!fs.existsSync(file)) return [];
    return parseMemory(fs.readFileSync(file, 'utf8'));
  }

  /** memory.md as it is on disk, '' when there is none: what a dream backs up. */
  memoryText(agent: Agent): string {
    try {
      return fs.readFileSync(path.join(this.path(agent.id), MEMORY), 'utf8');
    } catch {
      return '';
    }
  }

  /** Put memory.md back as it was (a dream's backup): '' removes it. */
  restoreMemory(agent: Agent, text: string): void {
    const file = path.join(this.path(agent.id), MEMORY);
    if (!text) {
      fs.rmSync(file, { force: true });
      return;
    }
    this.ensure(agent);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  /** Which version of each prompt section the agent's session has seen; empty for a session that saw none. */
  seen(agent: Agent): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.path(agent.id), SEEN), 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {};
    } catch {
      return {};
    }
  }

  setSeen(agent: Agent, keys: Record<string, string>): void {
    this.ensure(agent);
    fs.writeFileSync(path.join(this.path(agent.id), SEEN), `${JSON.stringify(keys)}\n`);
  }

  /**
   * Save something the agent learned. An entry that says exactly the same thing already is
   * returned as it is, with `added: false`.
   */
  remember(agent: Agent, rawText: unknown, rawWhy?: unknown, dreamId?: string): { entry: MemoryEntry; added: boolean; entries: MemoryEntry[] } {
    const { text, why } = checkEntry(rawText, rawWhy);
    const entries = this.memory(agent);
    const same = entries.find(e => e.text === text);
    if (same) return { entry: same, added: false, entries };
    const taken = new Set(entries.map(e => e.id));
    let id = randomUUID().slice(0, 8);
    while (taken.has(id)) id = randomUUID().slice(0, 8);
    // Whole seconds, as memory.md records them, so the entry reads back the same.
    const entry: MemoryEntry = { id, text, ...(why ? { why } : {}), createdAt: Math.floor(Date.now() / 1000) * 1000, ...(dreamId ? { dreamId } : {}) };
    const next = [...entries, entry];
    this.write(agent, next, 'Memory is full');
    return { entry, added: true, entries: next };
  }

  /**
   * Rewrite an entry. Leaving `why` out keeps the old reason; an empty one clears it. A dream that
   * rewrites it tags it with its id; otherwise the old tag stays.
   */
  update(agent: Agent, entryId: string, rawText: unknown, rawWhy?: unknown, dreamId?: string): { entry: MemoryEntry; entries: MemoryEntry[] } {
    const entries = this.memory(agent);
    const old = entries.find(e => e.id === entryId);
    if (!old) throw new HttpError(404, 'That memory entry is gone.');
    const { text, why } = checkEntry(rawText, rawWhy === undefined ? old.why : rawWhy);
    if (entries.some(e => e.id !== entryId && e.text === text)) throw new HttpError(409, 'Another memory entry already says that.');
    const tag = dreamId ?? old.dreamId;
    const entry: MemoryEntry = { id: old.id, text, ...(why ? { why } : {}), createdAt: old.createdAt, ...(tag ? { dreamId: tag } : {}) };
    const next = entries.map(e => (e.id === entryId ? entry : e));
    this.write(agent, next, 'That would make memory too long');
    return { entry, entries: next };
  }

  /**
   * Combine entries into one, in a single write: the sources go and the combined entry is added (or,
   * when it says exactly what one source says, that source stays). Like update, it is refused only
   * when it would leave memory over its limit and longer than it was, so a full memory can merge its
   * way back under.
   */
  merge(agent: Agent, entryIds: string[], rawText: unknown, rawWhy?: unknown, dreamId?: string): { entry: MemoryEntry; entries: MemoryEntry[] } {
    const { text, why } = checkEntry(rawText, rawWhy);
    const entries = this.memory(agent);
    const ids = [...new Set(entryIds)];
    if (ids.length < 2) throw new HttpError(400, 'Merge needs two or more entries.');
    if (ids.some(id => !entries.some(e => e.id === id))) throw new HttpError(404, 'That memory entry is gone.');
    if (entries.some(e => !ids.includes(e.id) && e.text === text)) throw new HttpError(409, 'Another memory entry already says that.');
    const keep = entries.find(e => ids.includes(e.id) && e.text === text);
    let entry: MemoryEntry;
    let next: MemoryEntry[];
    if (keep) {
      const tag = dreamId ?? keep.dreamId;
      entry = { id: keep.id, text, ...(why ? { why } : keep.why ? { why: keep.why } : {}), createdAt: keep.createdAt, ...(tag ? { dreamId: tag } : {}) };
      next = entries.filter(e => e.id === keep.id || !ids.includes(e.id)).map(e => (e.id === keep.id ? entry : e));
    } else {
      const taken = new Set(entries.map(e => e.id));
      let id = randomUUID().slice(0, 8);
      while (taken.has(id)) id = randomUUID().slice(0, 8);
      entry = { id, text, ...(why ? { why } : {}), createdAt: Math.floor(Date.now() / 1000) * 1000, ...(dreamId ? { dreamId } : {}) };
      next = [...entries.filter(e => !ids.includes(e.id)), entry];
    }
    this.write(agent, next, 'That would make memory too long');
    return { entry, entries: next };
  }

  forget(agent: Agent, entryId: string): { entry: MemoryEntry; entries: MemoryEntry[] } {
    const entries = this.memory(agent);
    const entry = entries.find(e => e.id === String(entryId ?? '').trim());
    if (!entry) throw new HttpError(404, 'No memory entry with that id.');
    const next = entries.filter(e => e !== entry);
    this.write(agent, next);
    return { entry, entries: next };
  }

  remove(agentId: string): void {
    fs.rmSync(this.path(agentId), { recursive: true, force: true });
  }

  /**
   * Write memory.md. With `over`, a change that leaves memory over its limit is refused, unless it
   * does not make memory longer: over the limit, an update or merge that shrinks it still goes
   * through, so memory can get back under (adding always makes it longer).
   */
  private write(agent: Agent, entries: MemoryEntry[], over?: string): void {
    const text = renderMemory(agent.name, entries);
    if (over && text.length > MEMORY_LIMIT && text.length > renderMemory(agent.name, this.memory(agent)).length) {
      throw new HttpError(400, `${over} (about ${MEMORY_LIMIT} characters). Consolidate related entries into one with forget and remember, or forget ones that no longer matter, then try again.`);
    }
    this.ensure(agent);
    const file = path.join(this.path(agent.id), MEMORY);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }
}

function soulText(text: string): string {
  const soul = String(text ?? '').trim();
  return soul ? `${soul}\n` : '';
}

export function checkEntry(rawText: unknown, rawWhy?: unknown): { text: string; why: string } {
  const text = flat(rawText);
  const why = flat(rawWhy);
  if (!text) throw new HttpError(400, 'Say what to remember.');
  if (text.length > MEMORY_TEXT_LIMIT) throw new HttpError(400, `Keep each memory under ${MEMORY_TEXT_LIMIT} characters; save the gist and where to find the rest.`);
  if (why.length > MEMORY_WHY_LIMIT) throw new HttpError(400, `Keep the reason under ${MEMORY_WHY_LIMIT} characters.`);
  if (looksSecret(text) || looksSecret(why)) {
    throw new HttpError(400, 'That looks like a password, key or token. Never store secrets in memory; note where the secret lives instead, such as process.env.NAME or a keychain item.');
  }
  return { text, why };
}
