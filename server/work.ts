import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from './envHygiene.ts';
import type { Agent, ChangedFile, PeerMessage, Project } from '../shared/types.ts';
import type { WorkChanges, WorkDiff, WorkTarget } from '../shared/work.ts';
import { parsePorcelainZ } from './projects.ts';
import { readFile, resolveInside } from './workspace.ts';
import { findRefIds } from '../shared/refs.ts';
import { layoutGraph } from '../shared/graph.ts';
import { mentionsBranch, namesInMergeSubject, parseDecorations, type CleanupBranch, type CleanupFolder, type CleanupRequest, type CleanupResult, type FolderChanges, type WorkBranch, type WorkCommit, type WorkMerge, type WorkProject, type WorkState, type WorkView, isStaleBranch } from '../shared/work.ts';
import { realPathThroughParents } from './dataDir.ts';
import { WorkOwners, ownableBranch, reflogMerges, type Owner } from './workOwners.ts';
import { HttpError } from './errors.ts';

// The Work view's data (ACH-D17). Read only: every git command it runs for the view goes through
// readGit, which allows only commands that read, with no fetch, no hooks, no fsmonitor and no
// optional locks (so even `git status` never rewrites the index). Removal is a separate, explicit
// request (cleanup) that rechecks everything at that moment.
//
// Merges come from git's own record of main (its reflog), copied into <dataDir>/work/merges.json the
// first time they are seen, with the reviewer and the task from PodCode's messages. The copy
// matters: after main's history is rewritten (as for 0.2.6, ACH-D16) the original merge commits are
// no longer on main, git forgets them in time, and git itself no longer sees those branches as merged.
// A branch counts as merged by record when its tip is the tip that was merged (or older).

export interface GitResult { ok: boolean; out: string }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** About how many commits the graph shows (ACH-D18). */
export const GRAPH_ROWS = 20;

/** Keep branch tips visible without adding rows or drawing a parent before its child. */
async function graphWindow(recent: string[], context: string[], tips: string[], main: string | undefined, git: GitRunner, root: string): Promise<string[]> {
  if (!context.length) return recent;
  const candidates = new Map([...context, ...recent].map(line => [line.split('\x1f')[0], line]));
  const pinned = new Set([main, ...tips].filter((hash): hash is string => Boolean(hash)).slice(0, GRAPH_ROWS));
  const selected = new Map([...candidates].filter(([hash]) => pinned.has(hash)));
  for (const [hash, line] of candidates) if (selected.size < GRAPH_ROWS) selected.set(hash, line);
  if (selected.size < 2) return [...selected.values()];
  // Let Git order the full ancestry before filtering to our window. Sorting only
  // visible parents misorders stacked branches when intermediate commits are omitted.
  const base = await git(['merge-base', '--octopus', ...selected.keys()], root);
  const boundary = base.ok ? base.out.trim() : '';
  const ordered = await git(['rev-list', '--topo-order', ...selected.keys(), ...(boundary ? ['--not', boundary] : [])], root);
  const hashes = [...ordered.out.trim().split('\n'), ...(boundary ? [boundary] : [])];
  const rows = hashes.flatMap(hash => selected.has(hash) ? [selected.get(hash)!] : []);
  return ordered.ok && rows.length === selected.size ? rows : recent;
}

/** Git with nothing that runs another program or takes optional locks. */
const GIT_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'diff.submodule=short', '-c', 'status.submoduleSummary=false'];
// GIT_LITERAL_PATHSPECS: a file name is only ever a name (":!x" is not an exclude, "*" not a glob).
// Built per call, without GIT_DIR and the like (server/envHygiene.ts): a command here acts on `cwd`'s repository only.
const GIT_EXTRA = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' };

/** The git commands the view may run: each reads, none writes refs, the index, config or the network. */
const READ_COMMANDS: Record<string, (args: string[]) => boolean> = {
  reflog: a => a[1] === 'show',
  worktree: a => a[1] === 'list' && a.includes('--porcelain'),
  'rev-list': () => true,
  log: () => true,
  status: a => a.includes('--porcelain'),
  'ls-files': a => a.length === 3 && a[1] === '--stage' && a[2] === '-z',
  'rev-parse': () => true,
  'merge-base': a => a[1] === '--is-ancestor' || (a[1] === '--octopus' && a.length >= 4 && a.slice(2).every(h => /^[0-9a-f]{40}$/.test(h))) || (a.length === 3 && !a[1].startsWith('-') && !a[2].startsWith('-')),
  // Comparing content only, with no external diff or textconv program, and no output file.
  diff: a => a.includes('--no-ext-diff') && a.includes('--no-textconv') && ['--quiet', '--name-only', '--numstat', '--patch'].some(flag => a.includes(flag)),
  show: a => a.includes('--no-ext-diff') && a.includes('--no-textconv') && a.includes('--format=') && ['--numstat', '--patch'].some(flag => a.includes(flag)),
  'for-each-ref': () => true,
  // Reading: exactly one ref named, so it can never be the two-argument form that sets one.
  'symbolic-ref': a => a.includes('--short') && a.slice(1).filter(x => !x.startsWith('-')).length === 1,
};

/** Whether a command may run for the view. */
export function isReadOnlyGit(args: readonly string[]): boolean {
  const check = READ_COMMANDS[args[0]];
  if (!check || !check([...args])) return false;
  // Nothing that writes as a side effect, whatever the command.
  return !args.some(a => /^--(output|write|exec|ext-diff|textconv)\b/.test(a) || a === '-o');
}

let running = 0;
const queue: (() => void)[] = [];
const LIMIT = 6;
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= LIMIT) await new Promise<void>(resolve => queue.push(resolve));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}

function execGit(args: string[], cwd: string): Promise<GitResult & { code?: string | number }> {
  return new Promise(resolve => execFile('git', [...GIT_FLAGS, ...args], { cwd, env: gitEnv(GIT_EXTRA), timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    resolve({ ok: !error, out: String(stdout ?? ''), ...(error ? { code: error.code } : {}) });
  }));
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return slot(async () => {
    if (args[0] !== 'diff' && args[0] !== 'status') return execGit(args, cwd);
    // Even status and --no-textconv diff can execute clean/process filters. Read only
    // their config names, disable each driver, and never fall back to an unsafe read.
    const filters = await execGit(['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\.'], cwd);
    if (!filters.ok && filters.code !== 1) return { ok: false, out: '' };
    const drivers = new Set(filters.out.split('\0').filter(Boolean).map(key => key.slice(0, key.lastIndexOf('.'))));
    const overrides = [...drivers].flatMap(driver => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`]);
    // Do not recurse into dirty submodule worktrees with their own filter config.
    return execGit([...overrides, '-c', 'status.submoduleSummary=false', '-c', 'diff.submodule=short', args[0], '--ignore-submodules=dirty', ...args.slice(1)], cwd);
  });
}

/** Worktree setup links are not source changes and must not mask committed branch work. */
function dependencyLink(root: string, file: { path: string; status: string }): boolean {
  if (file.status !== '??' || !['node_modules', '.venv'].includes(path.basename(file.path))) return false;
  try { return fs.lstatSync(path.join(resolveInside(root, path.dirname(file.path)), path.basename(file.path))).isSymbolicLink(); } catch { return false; }
}

/** Git commits a symlink's target string, never the file the link points to. */
function untrackedContent(root: string, file: string) {
  const parent = resolveInside(root, path.dirname(file));
  const full = path.join(parent, path.basename(file));
  if (fs.lstatSync(full).isSymbolicLink()) return { text: fs.readlinkSync(full), binary: false, truncated: false };
  return readFile(root, file);
}

/** The view's git: read-only commands only; anything else is refused before git runs. */
export const readGit: GitRunner = (args, cwd) => {
  if (!isReadOnlyGit(args)) return Promise.reject(new Error(`Not a read-only git command: git ${args.join(' ')}`));
  return runGit(args, cwd);
};

/** Status deliberately skips submodule contents; never offer their worktrees for removal. */
async function canCleanWorktree(root: string, git: GitRunner): Promise<boolean> {
  if (fs.existsSync(path.join(root, '.gitmodules'))) return false;
  const index = await git(['ls-files', '--stage', '-z'], root);
  if (!index.ok || index.out.split('\0').some(entry => entry.startsWith('160000 '))) return false;
  // Keep registered submodules protected even if their gitlinks/.gitmodules were removed.
  for (const flag of ['--git-dir', '--git-common-dir']) {
    const dir = await git(['rev-parse', '--path-format=absolute', flag], root);
    if (!dir.ok || !dir.out.trim() || fs.existsSync(path.join(dir.out.trim(), 'modules'))) return false;
  }
  return true;
}

/** Cleanup's git: removing one worktree or deleting one branch, nothing else. */
const writeGit: GitRunner = (args, cwd) => {
  const ok = (args[0] === 'worktree' && args[1] === 'remove' && args.at(-2) === '--') || (args[0] === 'branch' && args[1] === '-D' && args[2] === '--' && args.length === 4);
  if (!ok) return Promise.reject(new Error(`Not a cleanup command: git ${args.join(' ')}`));
  return runGit(args, cwd);
};

// ---- merge records ---------------------------------------------------------------------------

export interface MergeEvidence {
  kind: 'main' | 'content' | 'backup';
  backup?: string;
}

export interface MergeRecord {
  /** The merge commit as made. */
  hash: string;
  tree: string;
  /** The branch's tip when it was merged (the merge's second parent). */
  tip: string;
  /** main as it was when merged into (the merge's first parent); absent on records from before it was kept. */
  parent?: string;
  branch: string;
  at: number;
  subject: string;
  names: string[];
  reviewer?: string;
  conversationId?: string;
  refs: string[];
}

type RecordFile = Record<string, MergeRecord[]>;

export class MergeRecords {
  private file: string;
  private data: RecordFile | null = null;
  constructor(dir: string) { this.file = path.join(dir, 'merges.json'); }

  private load(): RecordFile {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      this.data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as RecordFile : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  list(repo: string): MergeRecord[] {
    return [...(this.load()[repo] ?? [])];
  }

  /** Add records not seen before (by merge hash), and fill in a reviewer or task found later. */
  merge(repo: string, found: MergeRecord[]): void {
    const data = this.load();
    const list = data[repo] ?? [];
    let changed = false;
    for (const record of found) {
      const known = list.find(r => r.hash === record.hash);
      if (!known) { list.push(record); changed = true; continue; }
      for (const key of ['reviewer', 'conversationId'] as const) {
        if (!known[key] && record[key]) { known[key] = record[key]; changed = true; }
      }
      if (!known.refs.length && record.refs.length) { known.refs = record.refs; changed = true; }
    }
    if (!changed) return;
    data[repo] = list.sort((a, b) => a.at - b.at);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ---- reading a repository ---------------------------------------------------------------------

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain` (with -z: fields end in NUL, entries in two), so no path or name is misread. */
export function parseWorktrees(text: string): WorktreeEntry[] {
  const z = text.includes('\0');
  const blocks = z ? text.split('\0\0') : text.split(/\n\n+/);
  const out: WorktreeEntry[] = [];
  for (const block of blocks) {
    const lines = block.split(z ? '\0' : '\n').filter(Boolean);
    const at = lines.find(l => l.startsWith('worktree '));
    if (!at) continue;
    const get = (key: string) => lines.find(l => l === key || l.startsWith(`${key} `));
    out.push({
      path: at.slice('worktree '.length),
      head: get('HEAD')?.slice(5) ?? null,
      branch: get('branch')?.slice(7).replace(/^refs\/heads\//, '') ?? null,
      locked: Boolean(get('locked')),
      prunable: Boolean(get('prunable')),
    });
  }
  return out;
}

/** Ignored folders that are build output, rebuilt by a build: noted, but not a reason to ask twice. */
const BUILD_OUTPUT = new Set(['dist', 'out', 'build', 'release', 'coverage', 'node_modules', '.vite', '.turbo', '.next', '.cache', '.DS_Store']);

/**
 * `git status --porcelain --ignored` counted: changed tracked files, untracked entries (and which of
 * those are symlinks), ignored build output, and other ignored files by name (.env and the like),
 * which removing the folder would delete without git ever having seen them.
 */
export function countChanges(porcelain: string, folder: string): FolderChanges {
  let changed = 0;
  let untracked = 0;
  let links = 0;
  let built = 0;
  const ignored: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const rel = line.slice(3).replace(/\/$/, '');
    if (line.startsWith('!!')) {
      if (BUILD_OUTPUT.has(rel.split('/')[0])) built++; else ignored.push(rel);
    } else if (line.startsWith('??')) {
      untracked++;
      try { if (fs.lstatSync(path.join(folder, rel)).isSymbolicLink()) links++; } catch { /* gone */ }
    } else {
      changed++;
    }
  }
  return { changed, untracked, links, built, ignored: ignored.slice(0, 20) };
}

/** Changes that removing the folder would lose: edits, untracked files beyond symlinks, or ignored files that are not build output. */
export function hasLosses(c: FolderChanges): boolean {
  return c.changed > 0 || c.untracked > c.links || c.ignored.length > 0;
}

const realOrSelf = realPathThroughParents;
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

export interface WorkContext {
  agents: () => Agent[];
  messages: () => PeerMessage[];
  /** <dataDir>/agents, whose subfolders are agents' own homes. */
  agentsDir: string;
  /** <dataDir>: cleanup only ever lists folders under it (agent homes, PodCode's worktrees) or an agent's recorded worktree. */
  dataDir: string;
  knownRef: (id: string) => boolean;
  /** Who owns each branch and commit (ACH-D34); kept in memory when not given. */
  owners?: WorkOwners;
  /** Existing, verified merge evidence for issue auto-close (ACH-D43); no additional Git reads. */
  onMerges?: (project: Project, records: MergeRecord[]) => void;
}

interface RepoFacts {
  root: string;
  defaultBranch: string;
  remote: string | null;
  worktrees: WorktreeEntry[];
}

/** The reviewer and task our messages name for a branch: a passing report, or a review asked for and not answered yet. */
function fromMessages(branch: string, messages: PeerMessage[], agents: Agent[]): { reviewer?: string; reviewing?: string; conversationId?: string; refs: string[] } {
  const text = (m: PeerMessage) => [m.text, m.delegation?.task, m.delegation?.context, m.delegation?.acceptanceCriteria, m.report?.summary].filter(Boolean).join('\n');
  const about = messages.filter(m => mentionsBranch(text(m), branch));
  const reviewers = new Set(agents.filter(a => a.role === 'reviewer').map(a => a.id));
  let reviewer: string | undefined;
  let reviewing: string | undefined;
  for (const m of about) {
    if (m.report && reviewers.has(m.fromAgentId) && (m.report.outcome === 'passed' || m.report.outcome === 'done')) reviewer = m.fromName;
  }
  if (!reviewer) {
    const asked = about.filter(m => m.delegation && reviewers.has(m.toAgentId));
    const open = asked.find(d => !messages.some(r => r.report && r.replyTo === d.id));
    if (open) reviewing = open.toName;
  }
  // The task the branch came from: the earliest delegation naming it (later ones may only mention it).
  const task = about.find(m => m.delegation && !reviewers.has(m.toAgentId)) ?? about.find(m => m.delegation);
  return { reviewer, reviewing, conversationId: task?.conversationId, refs: task?.delegation ? taskRefs(task.delegation.task) : [] };
}

/** The ids a task's own words name, not the "Decisions in force that may apply" list a lead appends; at most three. */
export function taskRefs(task: string): string[] {
  const own = task.split(/\n\s*\n|\n(?=Decisions in force)/).filter(part => !/^\s*Decisions in force/i.test(part)).join('\n');
  return [...new Set(findRefIds(own, () => true).map(r => r.id))].slice(0, 3);
}

/** A branch that never had a commit or merge of its own (only "branch: Created from ..."): new, not merged. */
async function neverUsed(git: GitRunner, branch: string, cwd: string): Promise<boolean> {
  const log = await git(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], cwd);
  if (!log.ok) return false;
  const entries = log.out.split('\n').filter(Boolean);
  return entries.length > 0 && entries.every(e => /^branch: Created from/.test(e));
}

export class WorkService {
  private cache = new Map<string, { at: number; view: WorkProject }>();
  /** A build already running for a project, so polls arriving together share it. */
  private building = new Map<string, Promise<WorkProject>>();
  private records: MergeRecords;
  private git: GitRunner;
  private ctx: WorkContext;
  private owners: WorkOwners;
  /** How long a project's view is reused before git is asked again. */
  ttlMs = 10_000;

  constructor(records: MergeRecords, ctx: WorkContext, git: GitRunner = readGit) {
    this.records = records;
    this.ctx = ctx;
    this.git = git;
    this.owners = ctx.owners ?? new WorkOwners(null);
  }

  /**
   * An agent is on this branch in this folder (ACH-D34): the branch is the agent's when the folder is
   * its own (its worktree, or a folder under its home), whether PodCode or plain git made the branch.
   */
  noteBranch(projectId: string, folder: string, branch: string | null | undefined, agent: Pick<Agent, 'id' | 'name'>): void {
    if (!ownableBranch(branch)) return;
    if (this.owner(folder, this.ctx.agents())?.id !== agent.id) return;
    this.owners.noteBranch(projectId, branch, { agentId: agent.id, name: agent.name });
    this.owners.save();
  }

  /**
   * Read main's merges not read before and give the commits each brought in to the owner its branch
   * had then: a fast-forward's old..new range, or a merge commit and its second parent's side.
   */
  private async captureOwners(project: Project, root: string, defaultBranch: string, others: (tip: string, branch: string) => Promise<string[]>): Promise<void> {
    const log = await this.git(['reflog', 'show', '--date=unix', '--format=%H%x1f%gs%x1f%gd', `refs/heads/${defaultBranch}`], root);
    if (!log.ok) return;
    const done: string[] = [];
    const seen = this.owners.seenSet(project.id);
    for (const m of reflogMerges(log.out, defaultBranch)) {
      if (seen.has(m.entry)) continue;
      const owner = this.owners.branchOwner(project.id, m.branch, m.at ? m.at + 60_000 : undefined);
      if (!owner) continue; // not known yet: read it again next time
      // Not commits a branch below this one still has (it owns those); see others().
      const tip = m.fastForward ? m.hash : `${m.hash}^2`;
      const range = m.fastForward && !m.before ? null : [tip, '--not', m.fastForward ? m.before! : `${m.hash}^1`, ...await others(tip, m.branch)];
      if (range) {
        const list = await this.git(['rev-list', '--max-count=500', ...range], root);
        if (list.ok) this.owners.noteCommits(project.id, [...(m.fastForward ? [] : [m.hash]), ...list.out.split('\n').filter(Boolean)], owner);
      }
      done.push(m.entry);
    }
    this.owners.markSeen(project.id, done);
  }

  async view(projects: Project[], fresh = false): Promise<WorkView> {
    const out = await Promise.all(projects.map(p => this.project(p, fresh)));
    return { projects: out, at: Date.now() };
  }

  /** Resolve only rows we actually expose, so requests cannot choose arbitrary paths or refs. */
  private async inspection(project: Project, target: WorkTarget): Promise<{ root: string; args: string[]; basis: WorkChanges['basis'] }> {
    if (!target.id || !['branch', 'commit', 'merge'].includes(target.kind)) throw new HttpError(400, 'Choose a branch or commit.');
    const view = await this.project(project);
    const facts = await this.facts(project);
    if (!facts) throw new HttpError(409, 'This project is not a Git repository.');
    const flags = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'];
    if (target.kind === 'branch') {
      const branch = view.inProgress.find(b => b.folder === target.id);
      const folder = facts.worktrees.find(w => w.path === branch?.folder && w.branch === branch.branch);
      if (!branch || !folder) throw new HttpError(404, 'That branch is no longer in this project. Refresh Work.');
      // Recheck the checkout's repository before reading any working-tree files.
      const common = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], folder.path);
      const expected = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], facts.root);
      if (!common.ok || !expected.ok || realOrSelf(common.out.trim()) !== realOrSelf(expected.out.trim())) throw new HttpError(409, 'That worktree has changed. Refresh Work.');
      const dirty = await this.git(['status', '--porcelain', '-z', '--untracked-files=all'], folder.path);
      if (!dirty.ok) throw new HttpError(409, 'Could not read that worktree.');
      if (parsePorcelainZ(dirty.out).some(file => !dependencyLink(folder.path, file))) return { root: folder.path, args: ['diff', ...flags, 'HEAD'], basis: 'uncommitted' };
      const base = await this.git(['merge-base', `refs/heads/${facts.defaultBranch}`, `refs/heads/${branch.branch}`], facts.root);
      if (!base.ok) throw new HttpError(409, 'Could not find this branch’s base.');
      return { root: folder.path, args: ['diff', ...flags, base.out.trim(), `refs/heads/${branch.branch}`], basis: 'branch' };
    }
    const hash = target.kind === 'commit' ? view.graph.find(c => c.hash === target.id)?.hash : view.merged.find(m => m.originalHash === target.id)?.hash;
    if (!hash) throw new HttpError(404, target.kind === 'merge' ? 'This merge no longer has a separate commit after the history rewrite.' : 'That commit is no longer in this view. Refresh Work.');
    return { root: facts.root, args: ['show', ...flags, '--format=', '--first-parent', '--diff-merges=first-parent', hash], basis: 'commit' };
  }

  private async changedFiles(inspect: { root: string; args: string[]; basis: WorkChanges['basis'] }, countUntracked = true): Promise<WorkChanges> {
    const result = await this.git([...inspect.args, '--numstat', '-z', '--'], inspect.root);
    if (!result.ok) throw new HttpError(409, 'Could not read these changes. Refresh Work and try again.');
    const files: ChangedFile[] = result.out.split('\0').filter(Boolean).flatMap(entry => {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      return match ? [{ path: match[3], added: Number(match[1]) || 0, removed: Number(match[2]) || 0, status: '' }] : [];
    });
    let total = files.length;
    const limited = files.slice(0, 500);
    if (inspect.basis === 'uncommitted') {
      const status = await this.git(['status', '--porcelain', '-z', '--untracked-files=all'], inspect.root);
      if (!status.ok) throw new HttpError(409, 'Could not read that worktree.');
      const untracked = parsePorcelainZ(status.out).filter(file => file.status === '??' && !dependencyLink(inspect.root, file));
      total += untracked.length;
      for (const file of untracked.slice(0, Math.max(0, 500 - limited.length))) {
        let added = 0;
        if (countUntracked) {
          try { const f = untrackedContent(inspect.root, file.path); if (!f.binary && !f.truncated) added = f.text ? f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0) : 0; } catch { /* selecting the diff reports unreadable files */ }
        }
        limited.push({ path: file.path, status: '??', added, removed: 0 });
      }
    }
    return { files: limited, basis: inspect.basis, truncated: total > 500 };
  }

  async changes(project: Project, target: WorkTarget): Promise<WorkChanges> {
    return this.changedFiles(await this.inspection(project, target));
  }

  async diff(project: Project, target: WorkTarget, file: string): Promise<WorkDiff> {
    const inspect = await this.inspection(project, target);
    const changes = await this.changedFiles(inspect, false);
    const listed = changes.files.find(f => f.path === file);
    if (!listed) throw new HttpError(404, 'That file is not in these changes.');
    let diff: string;
    let truncated = false;
    if (listed.status === '??') {
      const content = untrackedContent(inspect.root, file);
      truncated = content.truncated;
      const name = JSON.stringify(`b/${file}`);
      const lines = content.text.split('\n');
      if (content.text.endsWith('\n')) lines.pop();
      diff = content.binary ? `Binary files /dev/null and ${name} differ\n` : `--- /dev/null\n+++ ${name}\n@@ -0,0 +1,${content.text ? lines.length : 0} @@\n${content.text ? lines.map(line => `+${line}`).join('\n') : ''}\n`;
    } else {
      const result = await this.git([...inspect.args, '--patch', '--', file], inspect.root);
      if (!result.ok) throw new HttpError(409, 'Could not read that diff. Refresh Work and try again.');
      diff = result.out;
    }
    truncated ||= diff.length > 400_000;
    return { path: file, status: listed.status, diff: diff.slice(0, 400_000), truncated };
  }

  async project(project: Project, fresh = false): Promise<WorkProject> {
    const hit = this.cache.get(project.id);
    if (!fresh && hit && Date.now() - hit.at < this.ttlMs) return hit.view;
    const running = this.building.get(project.id);
    if (running && !fresh) return running;
    const job = (async () => {
      let view: WorkProject;
      try {
        view = await this.build(project);
      } catch (err) {
        view = { ...this.empty(project, null), error: (err as Error).message.slice(0, 300) };
      }
      this.cache.set(project.id, { at: Date.now(), view });
      return view;
    })();
    this.building.set(project.id, job);
    try { return await job; } finally { if (this.building.get(project.id) === job) this.building.delete(project.id); }
  }

  private empty(project: Project, defaultBranch: string | null): WorkProject {
    return { projectId: project.id, name: project.name, ...(project.code ? { code: project.code } : {}), defaultBranch, remote: null, notPushed: 0, inProgress: [], merged: [], graph: [], graphEdges: [], graphLanes: 0, laneOwners: {}, cleanup: { folders: [], branches: [] } };
  }

  private async facts(project: Project): Promise<RepoFacts | null> {
    const top = await this.git(['rev-parse', '--show-toplevel'], project.path);
    if (!top.ok) return null;
    const root = top.out.trim();
    let defaultBranch = '';
    const head = await this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
    if (head.ok && head.out.trim()) defaultBranch = head.out.trim().replace(/^origin\//, '');
    for (const name of [defaultBranch, 'main', 'master']) {
      if (name && (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], root)).ok) { defaultBranch = name; break; }
    }
    if (!defaultBranch) {
      const current = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
      defaultBranch = current.out.trim() || 'main';
    }
    const remote = (await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${defaultBranch}`], root)).ok ? `origin/${defaultBranch}` : null;
    const worktrees = parseWorktrees((await this.git(['worktree', 'list', '--porcelain', '-z'], root)).out);
    return { root, defaultBranch, remote, worktrees };
  }

  private async ancestor(a: string, b: string, cwd: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', a, b], cwd)).ok;
  }

  /** Read main's reflog and keep a record of every merge into it, with its reviewer and task. */
  private async captureMerges(facts: RepoFacts): Promise<MergeRecord[]> {
    const { root, defaultBranch } = facts;
    const known = new Set(this.records.list(root).map(r => r.hash));
    const log = await this.git(['reflog', 'show', '--date=unix', '--format=%H%x1f%gd%x1f%gs', `refs/heads/${defaultBranch}`], root);
    const found: MergeRecord[] = [];
    const messages = this.ctx.messages();
    const agents = this.ctx.agents();
    const entries = log.out.split('\n');
    for (const [index, line] of entries.entries()) {
      const [hash, selector, what] = line.split('\x1f');
      const merge = /^merge ([^:\s]+):/.exec(what ?? '');
      // Merging origin's main (or any remote branch) back in is not anyone's work.
      if (!hash || !merge || merge[1] === defaultBranch || /^(origin|upstream|refs\/remotes)\//.test(merge[1])) continue;
      const at = Number(/@\{(\d+)\}/.exec(selector ?? '')?.[1] ?? 0) * 1000;
      const branch = merge[1];
      const info = fromMessages(branch, messages, agents);
      if (known.has(hash)) {
        // Fill in what messages say now (a review that landed after the first look).
        found.push({ hash, tree: '', tip: '', branch, at, subject: '', names: [], refs: info.refs.filter(this.ctx.knownRef), ...(info.reviewer ? { reviewer: info.reviewer } : {}), ...(info.conversationId ? { conversationId: info.conversationId } : {}) });
        continue;
      }
      const parts = await this.git(['log', '-1', '--format=%T%x1f%P%x1f%s', hash], root);
      if (!parts.ok) continue; // the commit is gone: nothing to record
      const [tree, parents, subject] = parts.out.trim().split('\x1f');
      const fastForward = /Fast-forward/i.test(what ?? '');
      const tip = parents?.split(' ')[1] ?? (fastForward ? hash : undefined);
      if (!tree || !tip) continue;
      const refs = [...new Set([...info.refs, ...findRefIds(subject ?? '', this.ctx.knownRef).map(r => r.id)])].filter(this.ctx.knownRef);
      // A fast-forward's previous main is already in the next reflog entry.
      const parent = fastForward ? entries[index + 1]?.split('\x1f')[0] : parents?.split(' ')[0];
      found.push({ hash, tree, tip, ...(parent ? { parent } : {}), branch, at, subject: subject ?? '', names: namesInMergeSubject(subject ?? ''), refs, ...(info.reviewer ? { reviewer: info.reviewer } : {}), ...(info.conversationId ? { conversationId: info.conversationId } : {}) });
    }
    this.records.merge(root, found.filter(r => r.tree || known.has(r.hash)));
    return this.records.list(root);
  }

  /**
   * Evidence that a recorded merge's work is on main now (H1: a record alone is never enough):
   * - main: the merge commit is on main;
   * - content: a commit on main has exactly its files (a rewrite kept it as one commit), or every
   *   file the branch changed is the same on main today (a rewrite folded it in with others);
   * - backup: its tip is kept in a backup/* ref that is main from before a rewrite (one holding a
   *   merge with main or content evidence), so deleting the branch loses no commit (ALL-N2).
   * A merge undone by a reset has none of these and is left out everywhere.
   */
  private async evidence(records: MergeRecord[], mapped: Map<string, string | null>, defaultBranch: string, root: string): Promise<Map<string, MergeEvidence>> {
    const out = new Map<string, MergeEvidence>();
    const pending: MergeRecord[] = [];
    for (const r of records) {
      const now = mapped.get(r.hash);
      if (now === r.hash) out.set(r.hash, { kind: 'main' });
      else if (now) out.set(r.hash, { kind: 'content' });
      else if (await this.sameFilesOnMain(r.tip, defaultBranch, root)) out.set(r.hash, { kind: 'content' });
      else pending.push(r);
    }
    if (!pending.length) return out;
    const refs = await this.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/backup/'], root);
    const proven = records.filter(r => out.has(r.hash));
    const backups: string[] = [];
    for (const b of refs.out.split('\n').filter(Boolean)) {
      for (const r of proven) if (await this.ancestor(r.hash, `refs/heads/${b}`, root)) { backups.push(b); break; }
    }
    for (const r of pending) {
      // Only when main itself was rewritten past this merge (its first parent is no longer on main). A
      // merge undone by a reset has its first parent still on main, so a backup of it is not evidence.
      const parent = r.parent ?? ((await this.git(['rev-parse', '--verify', '--quiet', `${r.hash}^1`], root)).out.trim() || null);
      if (!parent || await this.ancestor(parent, `refs/heads/${defaultBranch}`, root)) continue;
      for (const b of backups) if (await this.ancestor(r.tip, `refs/heads/${b}`, root)) { out.set(r.hash, { kind: 'backup', backup: b }); break; }
    }
    return out;
  }

  /** Every file the branch changed since it left main is the same on main today. */
  private async sameFilesOnMain(tip: string, defaultBranch: string, root: string): Promise<boolean> {
    const base = await this.git(['merge-base', tip, `refs/heads/${defaultBranch}`], root);
    if (!base.ok) return false;
    const files = await this.git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', base.out.trim(), tip], root);
    const list = files.out.split('\n').filter(Boolean);
    if (!files.ok || !list.length) return false;
    return (await this.git(['diff', '--no-ext-diff', '--no-textconv', '--quiet', tip, `refs/heads/${defaultBranch}`, '--', ...list], root)).ok;
  }

  /**
   * The branches whose tips are in some recorded merge: the branch merged itself, or a branch that
   * went in through it (feat/x merged into feat/y, feat/y merged into main). By branch name, the
   * latest such record.
   */
  private async mergedBranches(records: MergeRecord[], cwd: string): Promise<Map<string, MergeRecord>> {
    const out = new Map<string, MergeRecord>();
    if (!records.length) return out;
    // One for-each-ref for all tips at once (several --merged are a union), in chunks for long lists.
    const merged = new Map<string, string>();
    const latest = [...records].sort((a, b) => b.at - a.at);
    for (let i = 0; i < latest.length; i += 100) {
      const chunk = latest.slice(i, i + 100);
      const list = await this.git(['for-each-ref', ...chunk.flatMap(r => ['--merged', r.tip]), '--format=%(refname:short)%1f%(objectname)', 'refs/heads'], cwd);
      if (!list.ok) {
        // A tip git no longer has makes the whole call fail: ask for each tip on its own instead.
        for (const r of chunk) {
          const one = await this.git(['for-each-ref', '--merged', r.tip, '--format=%(refname:short)%1f%(objectname)', 'refs/heads'], cwd);
          for (const line of one.out.split('\n').filter(Boolean)) { const [n, o] = line.split('\x1f'); merged.set(n, o); }
        }
        continue;
      }
      for (const line of list.out.split('\n').filter(Boolean)) { const [n, o] = line.split('\x1f'); merged.set(n, o); }
    }
    // Which record: the latest merge of that very branch, else the latest merge whose tip holds it.
    for (const [name, tip] of merged) {
      const own = latest.find(r => r.branch === name && (r.tip === tip));
      if (own) { out.set(name, own); continue; }
      for (const r of latest) {
        if (r.tip === tip || await this.ancestor(tip, r.tip, cwd)) { out.set(name, r); break; }
      }
    }
    return out;
  }

  private owner(folder: string, agents: Agent[]): Agent | undefined {
    const real = realOrSelf(folder);
    const byWorktree = agents.find(a => a.worktree && realOrSelf(a.worktree.path) === real);
    if (byWorktree) return byWorktree;
    const home = realOrSelf(this.ctx.agentsDir);
    if (!inside(real, home)) return undefined;
    const id = path.relative(home, real).split(path.sep)[0];
    return agents.find(a => a.id === id);
  }

  private async build(project: Project): Promise<WorkProject> {
    const facts = await this.facts(project);
    if (!facts) return this.empty(project, null);
    const { root, defaultBranch, remote, worktrees } = facts;
    const agents = this.ctx.agents();
    const messages = this.ctx.messages();
    const byName = (name: string) => agents.find(a => a.name.toLowerCase() === name.toLowerCase());
    const allRecords = await this.captureMerges(facts);
    const dataDir = realOrSelf(this.ctx.dataDir);
    const fresh = new Map<string, Promise<boolean>>();
    const isNew = (branch: string) => { if (!fresh.has(branch)) fresh.set(branch, neverUsed(this.git, branch, root)); return fresh.get(branch)!; };
    const usable = async (branch: string) => branch !== defaultBranch && !branch.startsWith('backup/') && !(await isNew(branch));

    // main's recent history, with the trees to match rewritten merges by their files.
    const log = await this.git(['log', '--first-parent', '-200', '--format=%H%x1f%T%x1f%P%x1f%s%x1f%ct', defaultBranch], root);
    const history = log.out.split('\n').filter(Boolean).map(line => {
      const [hash, tree, parents, subject, at] = line.split('\x1f');
      return { hash, tree, merge: (parents ?? '').split(' ').length > 1, subject: subject ?? '', at: Number(at) * 1000 };
    });
    const onMain = new Set(history.map(c => c.hash));
    // Changes on local main that origin's main (as last fetched) does not have.
    const local = new Set<string>();
    if (remote) {
      // First-parent: main's own changes (a merge counts once, not with every commit it brought in).
      const ahead = await this.git(['rev-list', '--first-parent', `${remote}..${defaultBranch}`], root);
      for (const hash of ahead.out.split('\n').filter(Boolean)) local.add(hash);
    }
    const notPushed = local.size;

    // Where each recorded merge is on main now: itself, or the rewritten commit with the same files.
    const mapped = new Map<string, string | null>();
    for (const r of allRecords) {
      if (onMain.has(r.hash) || await this.ancestor(r.hash, defaultBranch, root)) mapped.set(r.hash, r.hash);
      else mapped.set(r.hash, history.find(c => c.tree === r.tree)?.hash ?? null);
    }
    // A record counts only with evidence that its work is on main now (a merge undone by a reset has none).
    const evidence = await this.evidence(allRecords, mapped, defaultBranch, root);
    const records = allRecords.filter(r => evidence.has(r.hash));
    this.ctx.onMerges?.(project, records);
    const byRecord = await this.mergedBranches(records, root);
    /**
     * On origin's main: the merge's commit as it is on main now is not among the local-only ones. A
     * merge a rewrite folded in with others has no commit of its own: it is on GitHub when a later
     * merge's commit is (a rewrite keeps the order), and not known otherwise.
     */
    const pushedOf = (r: MergeRecord): boolean | null => {
      if (!remote) return null;
      const now = mapped.get(r.hash);
      if (now) return !local.has(now);
      // With nothing on local main that origin lacks, everything merged into it is on GitHub.
      if (local.size === 0) return true;
      const next = records.filter(x => x.at > r.at).map(x => mapped.get(x.hash)).find((h): h is string => Boolean(h));
      return next && !local.has(next) ? true : null;
    };
    const ids = (names: string[]) => names.map(byName).filter((a): a is Agent => Boolean(a)).map(a => a.id);

    const merged: WorkMerge[] = records.slice().sort((a, b) => b.at - a.at).slice(0, 30).map(r => {
      const now = mapped.get(r.hash) ?? null;
      return {
        branch: r.branch, at: r.at, names: r.names, agentIds: ids(r.names), ...(r.reviewer ? { reviewer: r.reviewer } : {}),
        hash: now, originalHash: r.hash, rewritten: now !== r.hash, pushed: pushedOf(r), evidence: evidence.get(r.hash)!,
        ...(r.conversationId ? { conversationId: r.conversationId } : {}), refs: r.refs,
      };
    });

    // Branches checked out somewhere: in progress, or merged and left behind.
    const realRoot = realOrSelf(root);
    // Where agents are working: their recorded worktrees, and wherever their tools last ran. A folder
    // with either in it (or another worktree inside it) is never listed for cleanup.
    const busyPlaces = agents.flatMap(a => [...(a.worktree ? [realOrSelf(a.worktree.path)] : []), ...(a.workingIn ? [realOrSelf(a.workingIn.root)] : [])]);
    const otherWorktrees = worktrees.map(w => realOrSelf(w.path));
    const inProgress: WorkBranch[] = [];
    const folders: CleanupFolder[] = [];
    for (const wt of worktrees) {
      const main = realOrSelf(wt.path) === realRoot;
      if (main && (!wt.branch || wt.branch === defaultBranch)) continue;
      const agent = this.owner(wt.path, agents);
      if (agent && !wt.prunable) this.owners.noteBranch(project.id, wt.branch, { agentId: agent.id, name: agent.name });
      if (wt.prunable || !fs.existsSync(wt.path)) {
        // git gives real paths (/private/var on macOS), so compare with the data folder's real path.
        if (!main && !wt.locked && inside(realOrSelf(wt.path), dataDir)) folders.push({ path: wt.path, branch: wt.branch, ...(agent ? { agentId: agent.id, agentName: agent.name } : {}), reason: 'missing', changes: { changed: 0, untracked: 0, links: 0, built: 0, ignored: [] }, dirty: false });
        continue;
      }
      const status = await this.git(['status', '--porcelain', '--untracked-files=normal', '--ignored'], wt.path);
      const changes = countChanges(status.out, wt.path);
      const dirty = hasLosses(changes);
      const head = wt.head ?? '';
      const record = wt.branch && await usable(wt.branch) ? byRecord.get(wt.branch) ?? null : null;
      // On main by git, unless it is a branch that never had work of its own (just made from main).
      const gitMerged = head ? await this.ancestor(head, defaultBranch, root) && !(wt.branch && await isNew(wt.branch)) : false;
      const folderReal = realOrSelf(wt.path);
      const isLive = busyPlaces.some(p => inside(p, folderReal)) || otherWorktrees.some(p => p !== folderReal && inside(p, folderReal));
      // Only folders PodCode made: under its data folder, or an agent's recorded worktree; never
      // a worktree another tool or the user made elsewhere.
      const ours = inside(realOrSelf(wt.path), dataDir) || agents.some(a => a.worktree && realOrSelf(a.worktree.path) === realOrSelf(wt.path));
      // A detached folder is listed only when it is clean and its commit is on main: removing one
      // with commits of its own would leave them on no branch.
      const leftover = wt.branch ? Boolean(record || gitMerged) : gitMerged && !dirty;
      if (!main && !wt.locked && !isLive && ours && leftover && status.ok && await canCleanWorktree(wt.path, this.git)) {
        folders.push({ path: wt.path, branch: wt.branch, ...(agent ? { agentId: agent.id, agentName: agent.name } : {}), reason: wt.branch ? 'merged' : 'detached', changes, dirty });
        continue;
      }
      if (!wt.branch || record || gitMerged) continue;
      const counts = await this.git(['rev-list', '--left-right', '--count', `refs/heads/${defaultBranch}...refs/heads/${wt.branch}`], root);
      const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
      const last = await this.git(['log', '-1', '--format=%h%x1f%s%x1f%ct', `refs/heads/${wt.branch}`], root);
      const [lh, ls, lt] = last.out.trim().split('\x1f');
      const info = fromMessages(wt.branch, messages, agents);
      // Working: its owner is mid-turn in this very folder (its worktree, or where its tools last ran).
      const here = agent && (realOrSelf(agent.worktree?.path ?? '') === realOrSelf(wt.path) || (agent.workingIn && inside(realOrSelf(agent.workingIn.root), realOrSelf(wt.path))));
      const state: WorkState = info.reviewer ? 'approved' : info.reviewing ? 'reviewing' : agent?.status === 'working' && here ? 'working' : 'open';
      // The folder's owner, else whoever the records say has the branch (work done in the project's own folder).
      const recordedOwner = agent ? undefined : this.owners.branchOwner(project.id, wt.branch);
      inProgress.push({
        branch: wt.branch, folder: wt.path, inPlace: main,
        ...(agent ? { agentId: agent.id, agentName: agent.name } : recordedOwner ? { agentId: recordedOwner.agentId, agentName: recordedOwner.name } : {}),
        state, ...(info.reviewer || info.reviewing ? { reviewer: info.reviewer ?? info.reviewing } : {}),
        ahead: ahead || 0, behind: behind || 0, changed: changes.changed, untracked: changes.untracked - changes.links + changes.ignored.length,
        ...(lh ? { last: { hash: lh, subject: ls ?? '', at: Number(lt) * 1000 } } : {}),
        ...(info.conversationId ? { conversationId: info.conversationId } : {}), refs: info.refs.filter(this.ctx.knownRef),
      });
    }

    // Branches whose work is on main, by our records or by git; never main itself or backup/*.
    const branches: CleanupBranch[] = [];
    const heads = await this.git(['for-each-ref', '--format=%(refname:short)%1f%(objectname)', 'refs/heads'], root);
    const checkedOut = new Map(worktrees.filter(w => w.branch).map(w => [w.branch!, w.path]));
    for (const line of heads.out.split('\n').filter(Boolean)) {
      const [name, tip] = line.split('\x1f');
      if (!name || !tip || name === defaultBranch || name.startsWith('backup/')) continue;
      const at = checkedOut.get(name);
      if (at && !folders.some(f => f.path === at)) continue; // still in use somewhere
      const isFresh = await isNew(name);
      const record = isFresh ? null : byRecord.get(name) ?? null;
      const gitMerged = !record && !isFresh && await this.ancestor(tip, defaultBranch, root);
      if (!record && !gitMerged) continue;
      const names = record?.names ?? [];
      const proof = record ? evidence.get(record.hash) : undefined;
      branches.push({ name, by: record ? 'record' : 'git', ...(proof ? { evidence: proof.kind } : {}), ...(proof?.backup ? { backup: proof.backup } : {}), ...(at ? { inFolder: at } : {}), ...(names[0] ? { agentName: names[0] } : {}) });
    }

    // The graph (ACH-D18): about 20 commits of main and the open branches, in topological order, with
    // parents and refs; main's own line is 'main', an open branch's lane its owner, a merged branch's
    // lane the merge's author (lazygit colours a lane by what opened it).
    // An owned open branch's commits are its owner's; then main's merges since the last look. A
    // commit a branch below it also has is left uncredited (a stack: the lower branch owns it),
    // better unknown than wrong. Branches that contain the tip being credited (built on top of it,
    // or made from main after the merge) own none of it, so they never block the credit.
    const localHeads = heads.out.split('\n').map(line => line.split('\x1f')[0]).filter((n): n is string => Boolean(n) && n !== defaultBranch);
    const others = async (tip: string, branch: string): Promise<string[]> => {
      const containing = await this.git(['for-each-ref', '--contains', tip, '--format=%(refname)', 'refs/heads'], root);
      const above = new Set(containing.ok ? containing.out.split('\n').filter(Boolean) : []);
      return localHeads.map(n => `refs/heads/${n}`).filter(ref => ref !== `refs/heads/${branch}` && !above.has(ref));
    };
    for (const b of inProgress) {
      if (!b.agentId || !b.agentName) continue;
      const tip = `refs/heads/${b.branch}`;
      const ahead = await this.git(['rev-list', '--max-count=200', tip, '--not', `refs/heads/${defaultBranch}`, ...await others(tip, b.branch)], root);
      if (ahead.ok) this.owners.noteCommits(project.id, ahead.out.split('\n').filter(Boolean), { agentId: b.agentId, name: b.agentName });
    }
    await this.captureOwners(project, root, defaultBranch, others);
    this.owners.save();
    const ownerOf = (hash: string): Owner | undefined => this.owners.commitOwner(project.id, hash);

    // Stale branches (ACH-D34) fold into one row in the client and take no lane or rows here.
    const now = Date.now();
    const tips = inProgress.filter(b => !isStaleBranch(b, now)).map(b => b.branch);
    const graphFormat = '--format=%H%x1f%P%x1f%T%x1f%s%x1f%ct%x1f%D';
    const glog = await this.git(['log', '--topo-order', `-${GRAPH_ROWS}`, '--decorate=full', graphFormat, defaultBranch, ...tips.map(b => `refs/heads/${b}`)], root);
    const mainLine = new Set(history.map(c => c.hash));
    const tipOwner = new Map<string, string>();
    for (const b of inProgress.filter(x => tips.includes(x.branch))) {
      const tip = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${b.branch}`], root);
      if (tip.ok) tipOwner.set(tip.out.trim(), b.agentName ?? b.branch);
    }
    const recent = glog.out.split('\n').filter(Boolean);
    const present = new Set(recent.map(line => line.split('\x1f')[0]));
    const mainHead = history[0]?.hash;
    const required = [mainHead, ...tipOwner.keys()].filter((hash): hash is string => Boolean(hash)).slice(0, GRAPH_ROWS);
    const context: string[] = [];
    // A busy main can fill the entire recent window and hide every older open branch.
    // Reserve their tips and one parent of context within the same 20-row budget.
    for (const hash of required.filter(hash => !present.has(hash))) {
      // Only unmerged branch context: including an old main ancestor here would make
      // a gap in main's first-parent line. Off-window parents remain boundary edges.
      const extra = await this.git(['log', '--topo-order', hash === mainHead ? '-1' : '-2', '--decorate=full', graphFormat, hash, ...(hash === mainHead ? [] : ['--not', defaultBranch])], root);
      if (extra.ok) context.push(...extra.out.split('\n').filter(Boolean));
    }
    const commits = (await graphWindow(recent, context, [...tipOwner.keys()], mainHead, this.git, root)).map(line => {
      const [hash, parents, tree, subject, at, deco] = line.split('\x1f');
      const r = records.find(x => x.hash === hash) ?? records.find(x => x.tree === tree);
      const named = r?.names.length ? r.names : namesInMergeSubject(subject ?? '');
      const recorded = named.length ? undefined : ownerOf(hash ?? '');
      const names = recorded ? [recorded.name] : named;
      const parentList = (parents ?? '').split(' ').filter(Boolean);
      const { refs, head } = parseDecorations(deco ?? '');
      return {
        hash, parents: parentList, subject: subject ?? '', at: Number(at) * 1000, merge: parentList.length > 1,
        names, agentIds: recorded ? [recorded.agentId] : ids(names), ...(r?.reviewer ? { reviewer: r.reviewer } : {}), refs, head,
        key: mainLine.has(hash) ? 'main' : tipOwner.get(hash) ?? null, mergeKey: names[0] ?? null,
      };
    });
    const layout = layoutGraph(commits, { mainKey: 'main' });
    const graph: WorkCommit[] = commits.map(({ mergeKey: _m, ...c }, i) => ({ ...c, lane: layout.rows[i].lane, key: layout.rows[i].key }));
    const laneOwners: Record<string, string> = {};
    for (const key of new Set([...graph.map(c => c.key), ...layout.edges.map(e => e.key)])) {
      const agent = key ? byName(key) : undefined;
      if (key && agent) laneOwners[key] = agent.id;
    }

    const fetchPath = await this.git(['rev-parse', '--git-path', 'FETCH_HEAD'], root);
    let fetchedAt: number | null = null;
    if (fetchPath.ok) { try { fetchedAt = fs.statSync(path.resolve(root, fetchPath.out.trim())).mtimeMs; } catch { /* never fetched */ } }
    return {
      projectId: project.id, name: project.name, ...(project.code ? { code: project.code } : {}),
      defaultBranch, remote, fetchedAt, notPushed, inProgress, merged, graph, graphEdges: layout.edges, graphLanes: layout.lanes, laneOwners,
      cleanup: { folders, branches: branches.sort((a, b) => a.name.localeCompare(b.name)) },
    };
  }

  /**
   * Remove what the user ticked, checked again now: each folder and branch must still be on a fresh
   * cleanup list, folders with real changes need forceFolders too, folders go first, and a branch
   * still checked out somewhere stays.
   */
  async cleanup(project: Project, request: CleanupRequest): Promise<CleanupResult> {
    const facts = await this.facts(project);
    if (!facts) throw new HttpError(409, `${project.name} is not a git repository.`);
    const fresh = await this.project(project, true);
    const result: CleanupResult = { removed: { folders: [], branches: [] }, skipped: [] };
    const force = new Set((request.forceFolders ?? []).map(realOrSelf));
    for (const raw of request.folders ?? []) {
      const folder = fresh.cleanup.folders.find(f => realOrSelf(f.path) === realOrSelf(String(raw)));
      if (!folder) { result.skipped.push({ item: String(raw), why: 'not on the cleanup list now' }); continue; }
      if (folder.dirty && !force.has(realOrSelf(folder.path))) { result.skipped.push({ item: folder.path, why: 'it has uncommitted changes; confirm it again to remove it' }); continue; }
      if (folder.reason === 'missing') {
        const ok = unregisterMissing(facts.root, folder.path);
        if (ok) result.removed.folders.push(folder.path); else result.skipped.push({ item: folder.path, why: 'could not find its record in the repository' });
        continue;
      }
      // Checked again right before removing it: anything that appeared since the list needs the second yes too.
      if (!await canCleanWorktree(folder.path, readGit)) { result.skipped.push({ item: folder.path, why: 'submodule worktrees require manual cleanup' }); continue; }
      const status = await readGit(['status', '--porcelain', '--untracked-files=normal', '--ignored'], folder.path);
      if (!status.ok) { result.skipped.push({ item: folder.path, why: 'could not verify its current changes' }); continue; }
      const now = countChanges(status.out, folder.path);
      if (hasLosses(now) && !force.has(realOrSelf(folder.path))) { result.skipped.push({ item: folder.path, why: 'it has uncommitted or ignored files now; confirm it again to remove it' }); continue; }
      // --force only for a folder whose only extras are symlinks or build output, or one the user confirmed twice.
      const forced = hasLosses(now) || now.untracked > 0 || now.built > 0;
      const removed = await writeGit(['worktree', 'remove', ...(forced ? ['--force'] : []), '--', folder.path], facts.root);
      if (removed.ok) result.removed.folders.push(folder.path); else result.skipped.push({ item: folder.path, why: 'git could not remove it' });
    }
    const after = parseWorktrees((await readGit(['worktree', 'list', '--porcelain', '-z'], facts.root)).out);
    for (const raw of request.branches ?? []) {
      const name = String(raw);
      const branch = fresh.cleanup.branches.find(b => b.name === name);
      if (!branch || name === facts.defaultBranch || name.startsWith('backup/')) { result.skipped.push({ item: name, why: 'not on the cleanup list now' }); continue; }
      if (after.some(w => w.branch === name)) { result.skipped.push({ item: name, why: 'still checked out in a folder' }); continue; }
      const deleted = await writeGit(['branch', '-D', '--', name], facts.root);
      if (deleted.ok) result.removed.branches.push(name); else result.skipped.push({ item: name, why: 'git could not delete it' });
    }
    this.cache.delete(project.id);
    return result;
  }
}

/**
 * A worktree whose folder is gone: remove only its own record in the repository (never
 * `git worktree prune`, which is repo-wide), after checking the record points at that folder.
 */
function unregisterMissing(root: string, folder: string): boolean {
  const admin = path.join(root, '.git', 'worktrees');
  let names: string[];
  try { names = fs.readdirSync(admin); } catch { return false; }
  for (const name of names) {
    try {
      const recorded = fs.readFileSync(path.join(admin, name, 'gitdir'), 'utf8').trim();
      if (path.resolve(path.dirname(recorded)) !== path.resolve(folder)) continue;
      if (fs.existsSync(path.join(admin, name, 'locked'))) return false;
      fs.rmSync(path.join(admin, name), { recursive: true, force: true });
      return true;
    } catch { /* not this one */ }
  }
  return false;
}
