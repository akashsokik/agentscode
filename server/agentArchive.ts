// Removing an agent archives its home instead of deleting it: <dataDir>/agents/<id>/ (soul.md,
// memory.md, the dream records, workspace/ and everything in it) moves to
// <dataDir>/archive/agents/<id>-<name>-<timestamp>/, with the agent's transcript and a small
// .archived.json beside it. Nothing is deleted. The archive is never loaded as live agents.
//
// Git worktrees an agent made inside its workspace would break when their folder moves, so each one
// is handled on the way:
// - with uncommitted changes (or untracked files): it moves as it is and `git worktree repair`
//   points its repository at the new place, so it stays a working checkout with every change;
// - clean: it moves as files, and only its own registration (<repo>/.git/worktrees/<name>) is
//   removed, after checking it points into the archived home, so no dead entry stays behind and its
//   branch is free to check out again. No other worktree's registration is touched. Its commits are
//   on the branch; the files in the archive are a copy.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { realPathThroughParents } from './dataDir.ts';
import { gitEnv } from './envHygiene.ts';

export interface ArchivedWorktree {
  /** Where it is now, relative to the archived folder. */
  path: string;
  /** The repository it belongs to (its main working tree), when known. */
  repo: string | null;
  branch: string | null;
  /** It had uncommitted changes or untracked files when it was archived. */
  dirty: boolean;
  /** repaired: still a working checkout; unregistered: its registration removed, files kept; failed: see error. */
  action: 'repaired' | 'unregistered' | 'failed';
  error?: string;
}

/** One of the agent's other folders (its attachments), moved in after its home. */
export interface ArchivedExtra {
  name: string;
  /** Where it is now, relative to the archived folder (under .archive-extras/), or where it stayed when the move failed. */
  path: string;
  /** moved: in the archive; failed: left where it was, see error. */
  action: 'moved' | 'failed';
  error?: string;
}

export interface ArchivedAgent {
  id: string;
  name: string;
  role: string;
  engine: string;
  projectId: string | null;
  archivedAt: string;
  /** The archived folder, absolute. */
  dir: string;
  worktrees: ArchivedWorktree[];
  /** Absent in archives made before extras were recorded. */
  extras?: ArchivedExtra[];
  /** Set when the transcript could not be copied in; the live transcript is then kept. */
  transcriptError?: string;
  /** The agent had no home folder: the archive holds only its transcript and extras. */
  noHome?: boolean;
  /** Set when .archived.json could not be written (the folder is then not listed); the live transcript is kept. Never saved in the file. */
  metaError?: string;
}

export const ARCHIVE_META = '.archived.json';
export const ARCHIVE_TRANSCRIPT = 'transcript.jsonl';
/** Where extras go inside the archived folder: a name no agent home uses, so nothing in the home is overwritten. */
export const ARCHIVE_EXTRAS = '.archive-extras';

/** Git without anything that runs another program, and without taking optional locks. */
const GIT_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

export type GitRun = (args: string[], cwd: string) => string;

const runGit: GitRun = (args, cwd) => execFileSync('git', [...GIT_FLAGS, ...args], {
  cwd,
  encoding: 'utf8',
  timeout: 30_000,
  env: gitEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

/** A name safe for a folder: lower case letters, digits and dashes, at most 40. */
export function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

/** 2026-11-10T07:51:23.234Z as 20261110-075123. */
export function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}

/** The folder to archive into: <id>-<name>-<stamp>, then -2, -3 ... if that is taken. */
export function archiveDir(root: string, id: string, name: string, date: Date): string {
  const base = path.join(root, `${id}-${slug(name)}-${stamp(date)}`);
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  return dir;
}

interface FoundWorktree {
  dir: string;
  /** The worktree's admin folder in its repository: <repo>/.git/worktrees/<name>. */
  gitdir: string;
}

/** Folders the worktree search never enters. */
const SKIP = new Set(['.git', 'node_modules']);
/** The most folders the search visits, so a huge workspace cannot hold up a removal. */
const MAX_VISITS = 50_000;

/**
 * Linked git worktrees under `root`, at any depth: folders whose .git is a file pointing at a
 * repository's worktrees/ folder. Symlinks are never followed (an agent's workspace may link
 * node_modules or a whole project), .git and node_modules are not entered, and a worktree's own
 * contents are not searched.
 */
export function findWorktrees(root: string, maxVisits = MAX_VISITS): FoundWorktree[] {
  const out: FoundWorktree[] = [];
  let visits = 0;
  let warned = false;
  const walk = (dir: string) => {
    if (++visits > maxVisits) {
      if (!warned) console.warn(`[archive] stopped looking for worktrees under ${root} after ${maxVisits} folders; any deeper ones move as plain files`);
      warned = true;
      return;
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dotGit = entries.find(e => e.name === '.git' && e.isFile());
    if (dotGit) {
      const text = fs.readFileSync(path.join(dir, '.git'), 'utf8');
      const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
      if (gitdir) {
        const resolved = path.resolve(dir, gitdir);
        if (/[/\\]worktrees[/\\][^/\\]+$/.test(resolved)) out.push({ dir, gitdir: resolved });
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };
  walk(root);
  return out;
}

/** The repository's common git folder from a worktree's admin folder (worktrees/<name>/commondir). */
function commonDir(gitdir: string): string {
  try {
    return path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
  } catch {
    return path.resolve(gitdir, '..', '..');
  }
}

/** The file operations a move uses; tests replace them to simulate another file system. */
export interface MoveOps {
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
}

const realOps: MoveOps = {
  rename: (from, to) => fs.renameSync(from, to),
  copy: (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }),
};

/**
 * Move a folder. Across file systems (EXDEV) it is copied, keeping symlinks as links, and the
 * original is removed only once the whole copy succeeded; a failed copy is cleaned up, but only
 * when this move created the destination: a folder that was already there is never removed. The
 * original is left as it was.
 */
export function move(from: string, to: string, ops: MoveOps = realOps): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const existed = fs.existsSync(to);
  try {
    ops.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    try {
      ops.copy(from, to);
    } catch (copyErr) {
      if (!existed) fs.rmSync(to, { recursive: true, force: true });
      throw copyErr;
    }
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Remove one clean worktree's registration: its own admin folder <repo>/.git/worktrees/<name>, and
 * only when the gitdir it records points into the home being archived. A locked worktree is left
 * registered. Nothing else in the repository is touched.
 */
function unregister(gitdir: string, inHome: (p: string) => boolean): void {
  const recorded = fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim();
  const points = path.resolve(gitdir, recorded);
  // A record made before the data folder moved names ~/.agentscode/..., now a link to ~/.podcode;
  // the home has just moved out, so resolve it through its nearest existing parent (ALL-D6).
  if (!inHome(points) && !inHome(realPathThroughParents(points))) throw new Error(`not removing ${gitdir}: it names ${recorded}, outside the archived home`);
  if (fs.existsSync(path.join(gitdir, 'locked'))) throw new Error(`not removing ${gitdir}: the worktree is locked`);
  fs.rmSync(gitdir, { recursive: true, force: true });
}

/**
 * Archive an agent's home into `archiveRoot`. An agent with no home still has its transcript and
 * extras archived, in a fresh folder; returns null only when there is nothing of its at all.
 * Throws (moving nothing) if the move itself fails. Once the home has moved nothing throws: worktree,
 * extra, transcript and .archived.json failures are recorded on the result instead.
 */
export function archiveAgentHome(input: {
  home: string;
  archiveRoot: string;
  agent: { id: string; name: string; role: string; engine: string; projectId: string | null };
  /** The agent's transcript file, copied in as transcript.jsonl when it exists. */
  transcript?: string;
  /** Other folders of the agent's to move in with it (its attachments), each under its name. */
  extras?: { from: string; name: string }[];
  now?: Date;
  git?: GitRun;
  ops?: MoveOps;
}): ArchivedAgent | null {
  const git = input.git ?? runGit;
  const now = input.now ?? new Date();
  const noHome = !fs.existsSync(input.home);
  if (noHome) {
    // Nothing to move, but the transcript and attachments are still the agent's: they go into a
    // fresh folder of their own. With none of them either, there is nothing to archive.
    const transcript = Boolean(input.transcript && fs.existsSync(input.transcript));
    if (!transcript && !(input.extras ?? []).some(e => fs.existsSync(e.from))) return null;
  }
  const found = noHome ? [] : findWorktrees(input.home).map(wt => {
    let dirty = true; // when status cannot be read, keep it as if it had changes
    let branch: string | null = null;
    try { dirty = git(['status', '--porcelain'], wt.dir).trim() !== ''; } catch { /* keep dirty */ }
    try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.dir).trim() || null; } catch { /* detached or broken */ }
    const common = commonDir(wt.gitdir);
    return { ...wt, dirty, branch, common, repo: path.basename(common) === '.git' ? path.dirname(common) : common };
  });

  // git records real paths (/private/var on macOS for /var), so compare against the home's real path.
  const realHome = noHome ? path.resolve(input.home) : fs.realpathSync(input.home);
  const dir = archiveDir(input.archiveRoot, input.agent.id, input.agent.name, now);
  if (noHome) fs.mkdirSync(dir, { recursive: true });
  else move(input.home, dir, input.ops);

  const done = new Map<FoundWorktree, ArchivedWorktree>();
  const home = path.resolve(input.home);
  const inside = (p: string) => p === realHome || p.startsWith(realHome + path.sep) || p === home || p.startsWith(home + path.sep);
  const remap = (p: string) => (inside(p) ? path.join(dir, path.relative(realHome, p)) : p);
  for (const wt of found) {
    const rel = path.relative(input.home, wt.dir);
    const moved = path.join(dir, rel);
    // A repository the agent kept in its own workspace moved into the archive with its worktrees:
    // each one is repaired against it there, clean or not, and nothing live is left pointing at it.
    const ownRepo = inside(wt.common);
    const common = remap(wt.common);
    const result = { path: rel, repo: wt.repo === null ? null : remap(wt.repo), branch: wt.branch, dirty: wt.dirty };
    try {
      // Its .git file still names the repository's old place; point it at the new one first.
      if (ownRepo) fs.writeFileSync(path.join(moved, '.git'), `gitdir: ${remap(wt.gitdir)}\n`);
      if (wt.dirty || ownRepo) git(['worktree', 'repair', moved], common);
      else unregister(wt.gitdir, inside);
      done.set(wt, { ...result, action: wt.dirty || ownRepo ? 'repaired' : 'unregistered' });
    } catch (err) {
      done.set(wt, { ...result, action: 'failed', error: String((err as Error).message).slice(0, 300) });
    }
  }
  const worktrees = found.map(wt => done.get(wt)!);

  // The home is in the archive now, so nothing below throws: a failure is recorded in .archived.json.
  let transcriptError: string | undefined;
  if (input.transcript && fs.existsSync(input.transcript)) {
    try {
      fs.copyFileSync(input.transcript, path.join(dir, ARCHIVE_TRANSCRIPT), fs.constants.COPYFILE_EXCL);
    } catch (err) {
      transcriptError = String((err as Error).message).slice(0, 300);
    }
  }
  const extras: ArchivedExtra[] = [];
  for (const extra of input.extras ?? []) {
    if (!fs.existsSync(extra.from)) continue;
    // Under .archive-extras/, by its base name only, so it can never land on something from the home.
    const rel = path.join(ARCHIVE_EXTRAS, path.basename(extra.name) || 'extra');
    try {
      move(extra.from, path.join(dir, rel), input.ops);
      extras.push({ name: extra.name, path: rel, action: 'moved' });
    } catch (err) {
      extras.push({ name: extra.name, path: extra.from, action: 'failed', error: String((err as Error).message).slice(0, 300) });
    }
  }
  const record: ArchivedAgent = { ...input.agent, archivedAt: now.toISOString(), dir, worktrees, extras, ...(transcriptError ? { transcriptError } : {}), ...(noHome ? { noHome } : {}) };
  try {
    fs.writeFileSync(path.join(dir, ARCHIVE_META), JSON.stringify({ ...record, dir: undefined }, null, 2));
  } catch (err) {
    // The home is already in the archive: report it rather than throw (the agent would stay, homeless).
    return { ...record, metaError: String((err as Error).message).slice(0, 300) };
  }
  return record;
}

/** The archived agents, newest first, from each folder's .archived.json. Read only. */
export function listArchive(archiveRoot: string): ArchivedAgent[] {
  let names: string[];
  try { names = fs.readdirSync(archiveRoot); } catch { return []; }
  const out: ArchivedAgent[] = [];
  for (const name of names) {
    const dir = path.join(archiveRoot, name);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, ARCHIVE_META), 'utf8')) as ArchivedAgent;
      out.push({ ...meta, dir });
    } catch { /* not an archived agent */ }
  }
  return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
