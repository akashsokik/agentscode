import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PodCode was AgentsCode (ALL-D4, ALL-D5). Its data folder moves from ~/.agentscode to ~/.podcode,
// once, on the first start of a PodCode build, and ~/.agentscode stays behind as a link to it, so
// every path that names the old folder (an agent's workspace it runs in right now, git worktree
// records in the user's repositories, notes and transcripts that mention one) keeps working.
//
// Nothing here runs when a module is imported: migrateDataDir runs only from the app's entry points
// (server/boot.ts, before the server opens any file), never from tests or scripts, and never when
// PODCODE_HOME (or the old AGENTSCODE_HOME) names the data folder. It never deletes anything.

export const NEW_DIR_NAME = '.podcode';
export const OLD_DIR_NAME = '.agentscode';

/** An environment setting by its PodCode name, falling back to its AgentsCode name (PODCODE_HOME, then AGENTSCODE_HOME). */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`PODCODE_${name}`] || env[`AGENTSCODE_${name}`] || undefined;
}

function lstat(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}

/**
 * A path's real path; for one that is gone, its nearest existing parent's real path plus the rest.
 * Git records made before the move name ~/.agentscode/... (now a link to ~/.podcode), and once that
 * folder is gone realpath fails, so this is how such a record still matches the data folder.
 */
export function realPathThroughParents(p: string): string {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { /* resolve the parent */ }
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realPathThroughParents(parent), path.basename(abs));
}

/** Whether a data folder holds the app's state (state.json), as opposed to being empty or bare. */
function hasState(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'state.json'));
}

/**
 * The data folder to use, without changing anything: PODCODE_HOME (or AGENTSCODE_HOME) when set;
 * else ~/.podcode once it exists; else ~/.agentscode while only that exists (before the first
 * PodCode start migrated it, so tests and scripts never create a second, empty ~/.podcode); else
 * ~/.podcode for a fresh install.
 */
export function resolveDataDir(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const set = envVar('HOME', env);
  if (set) return set;
  const fresh = path.join(home, NEW_DIR_NAME);
  if (lstat(fresh)) return fresh;
  const old = path.join(home, OLD_DIR_NAME);
  return lstat(old) ? old : fresh;
}

export type MigrationAction = 'moved' | 'ready' | 'both' | 'fresh' | 'skipped';

export interface MigrationResult {
  action: MigrationAction;
  dir: string;
  notes: string[];
}

/**
 * Move ~/.agentscode to ~/.podcode once and leave a link at the old place:
 * - only the old folder: rename it (one atomic step on the same disk), link ~/.agentscode to it,
 *   rewrite the absolute paths state.json keeps for agents (home, worktree, where they work), and
 *   link Claude Code's session folders for the new paths so agents resume their conversations;
 * - ~/.agentscode a link to an existing folder (the user's, elsewhere): the link moves the same way,
 *   so ~/.podcode points at that folder;
 * - ~/.podcode already there (and ~/.agentscode a link, or gone): nothing to do;
 * - ~/.podcode there without a state.json while ~/.agentscode has one: ~/.podcode is set aside as
 *   ~/.podcode-unused-<n> and the move goes ahead;
 * - both folders with state: use ~/.podcode and leave ~/.agentscode exactly as it is (logged);
 * - neither, or ~/.agentscode a link to nothing: a fresh install, so ~/.podcode is made.
 * Running it again changes nothing.
 */
export function migrateDataDir(options: { home?: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void } = {}): MigrationResult {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(`[data] ${line}`));
  const notes: string[] = [];
  const say = (line: string) => { notes.push(line); log(line); };
  const set = envVar('HOME', env);
  if (set) return { action: 'skipped', dir: set, notes: [`PODCODE_HOME is set (${set}): no migration.`] };

  const fresh = path.join(home, NEW_DIR_NAME);
  const old = path.join(home, OLD_DIR_NAME);
  const freshStat = lstat(fresh);
  const oldStat = lstat(old);

  // The old name is the user's own link to a folder elsewhere (a synced drive, say): that folder is
  // their data. The link itself moves to the new name, so ~/.podcode points where it pointed.
  const oldIsLinkToData = Boolean(oldStat?.isSymbolicLink() && isDir(old));

  if (freshStat) {
    if (oldStat && (!oldStat.isSymbolicLink() || oldIsLinkToData) && hasState(old) && !hasState(fresh)) {
      // ~/.podcode was made (by a fresh start, say) but holds no state, while ~/.agentscode does:
      // starting on the empty one would look like a lost install. Set it aside, then move as usual.
      const aside = setAside(fresh);
      say(`${fresh} held no state.json while ${old} does; moved ${fresh} to ${aside} and moving ${old} in its place.`);
    } else {
      if (oldStat && !oldStat.isSymbolicLink()) {
        say(`Both ${fresh} and ${old} exist as folders. Using ${fresh}; ${old} is left as it is.`);
        return { action: 'both', dir: fresh, notes };
      }
      return { action: 'ready', dir: fresh, notes };
    }
  } else if (!oldStat || (oldStat.isSymbolicLink() && !oldIsLinkToData)) {
    if (oldStat?.isSymbolicLink()) say(`${old} is a link to nothing that exists and ${fresh} is missing; starting a new ${fresh} (the link is left alone).`);
    fs.mkdirSync(fresh, { recursive: true });
    return { action: 'fresh', dir: fresh, notes };
  }

  // A rename moves a link as a link: the data behind it stays where it is.
  if (oldIsLinkToData) say(`${old} is a link to ${fs.realpathSync(old)}; moving the link to ${fresh}.`);
  fs.renameSync(old, fresh);
  // From here the data is in ~/.podcode, so the steps below run even if the link can't be made.
  try {
    fs.symlinkSync(fresh, old, 'dir');
    say(`Moved ${old} to ${fresh}, and linked ${old} to it so paths naming the old folder keep working.`);
  } catch (err) {
    say(`Moved ${old} to ${fresh}, but could not link ${old} to it (${err instanceof Error ? err.message : String(err)}); paths naming the old folder will not resolve until that link exists.`);
  }
  const rewritten = rewriteStatePaths(path.join(fresh, 'state.json'), old, fresh);
  if (rewritten) say(`Rewrote ${rewritten} saved ${rewritten === 1 ? 'path' : 'paths'} in state.json to ${fresh}.`);
  const linked = linkClaudeSessions(home);
  if (linked) say(`Linked ${linked} Claude Code session ${linked === 1 ? 'folder' : 'folders'} under their new paths, so agents resume where they were.`);
  return { action: 'moved', dir: fresh, notes };
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Rename a folder to a free `<name>-unused-<n>` beside it. Nothing is deleted. */
function setAside(dir: string): string {
  for (let n = 1; ; n++) {
    const target = `${dir}-unused-${n}`;
    if (lstat(target)) continue;
    fs.renameSync(dir, target);
    return target;
  }
}

/** The agent fields that hold absolute paths the app works from (not prose such as messages). */
const PATH_FIELDS: { get: (a: Record<string, unknown>) => Record<string, unknown> | null; keys: string[] }[] = [
  { get: a => a, keys: ['home', 'sessionCwd'] },
  { get: a => (a.worktree && typeof a.worktree === 'object' ? a.worktree as Record<string, unknown> : null), keys: ['path', 'cwd', 'gitDir'] },
  { get: a => (a.workingIn && typeof a.workingIn === 'object' ? a.workingIn as Record<string, unknown> : null), keys: ['root'] },
];

/** Rewrite agents' saved absolute paths from the old folder to the new one. Returns how many changed; never fails a start. */
export function rewriteStatePaths(file: string, oldDir: string, newDir: string): number {
  let raw: { agents?: Record<string, unknown>[] };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof raw; } catch { return 0; }
  const swap = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    if (value === oldDir) return newDir;
    return value.startsWith(oldDir + path.sep) ? newDir + value.slice(oldDir.length) : value;
  };
  let changed = 0;
  for (const agent of raw.agents ?? []) {
    for (const field of PATH_FIELDS) {
      const target = field.get(agent);
      if (!target) continue;
      for (const key of field.keys) {
        const next = swap(target[key]);
        if (next !== target[key]) { target[key] = next; changed++; }
      }
    }
  }
  if (!changed) return 0;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, file);
  return changed;
}

/**
 * Claude Code keeps each session under ~/.claude/projects/<the folder it ran in, encoded>.
 * An agent's folder is now under ~/.podcode, so its sessions would not be found and it would start
 * over. For each folder there for a path under ~/.agentscode, add a link under the matching
 * ~/.podcode name. Additive only: an existing name is never touched, nothing is moved or deleted.
 */
export function linkClaudeSessions(home: string): number {
  const projects = path.join(home, '.claude', 'projects');
  let names: string[];
  try { names = fs.readdirSync(projects); } catch { return 0; }
  // Claude Code's folder name for a path: every character other than a letter or digit becomes '-'.
  const encode = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const oldPrefix = encode(path.join(home, OLD_DIR_NAME));
  const newPrefix = encode(path.join(home, NEW_DIR_NAME));
  let linked = 0;
  for (const name of names) {
    if (!name.startsWith(oldPrefix + '-') && name !== oldPrefix) continue;
    const target = newPrefix + name.slice(oldPrefix.length);
    if (lstat(path.join(projects, target))) continue;
    try {
      fs.symlinkSync(path.join(projects, name), path.join(projects, target), 'dir');
      linked++;
    } catch { /* leave it: that agent starts a fresh session */ }
  }
  return linked;
}
