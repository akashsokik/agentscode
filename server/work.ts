import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, PeerMessage, Project } from '../shared/types.ts';
import { findRefIds } from '../shared/refs.ts';
import { mentionsBranch, namesInMergeSubject, type CleanupBranch, type CleanupFolder, type CleanupRequest, type CleanupResult, type FolderChanges, type WorkBranch, type WorkCommit, type WorkMerge, type WorkProject, type WorkState, type WorkView } from '../shared/work.ts';
import { HttpError } from './errors.ts';

// The Work view's data (ACH-D17). Read only: every git command it runs for the view goes through
// readGit, which allows only commands that read, with no fetch, no hooks, no fsmonitor and no
// optional locks (so even `git status` never rewrites the index). Removal is a separate, explicit
// request (cleanup) that rechecks everything at that moment.
//
// Merges come from git's own record of main (its reflog), copied into <dataDir>/work/merges.json the
// first time they are seen, with the reviewer and the task from AgentsCode's messages. The copy
// matters: after main's history is rewritten (as for 0.2.6, ACH-D16) the original merge commits are
// no longer on main, git forgets them in time, and git itself no longer sees those branches as merged.
// A branch counts as merged by record when its tip is the tip that was merged (or older).

export interface GitResult { ok: boolean; out: string }
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/** Git with nothing that runs another program or takes optional locks. */
const GIT_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** The git commands the view may run: each reads, none writes refs, the index, config or the network. */
const READ_COMMANDS: Record<string, (args: string[]) => boolean> = {
  reflog: a => a[1] === 'show',
  worktree: a => a[1] === 'list' && a.includes('--porcelain'),
  'rev-list': () => true,
  log: () => true,
  status: a => a.includes('--porcelain'),
  'rev-parse': () => true,
  'merge-base': a => a[1] === '--is-ancestor',
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

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return slot(() => new Promise(resolve => {
    execFile('git', [...GIT_FLAGS, ...args], { cwd, env: GIT_ENV, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, out: String(stdout ?? '') });
    });
  }));
}

/** The view's git: read-only commands only; anything else is refused before git runs. */
export const readGit: GitRunner = (args, cwd) => {
  if (!isReadOnlyGit(args)) return Promise.reject(new Error(`Not a read-only git command: git ${args.join(' ')}`));
  return runGit(args, cwd);
};

/** Cleanup's git: removing one worktree or deleting one branch, nothing else. */
const writeGit: GitRunner = (args, cwd) => {
  const ok = (args[0] === 'worktree' && args[1] === 'remove') || (args[0] === 'branch' && args[1] === '-D' && args.length === 3);
  if (!ok) return Promise.reject(new Error(`Not a cleanup command: git ${args.join(' ')}`));
  return runGit(args, cwd);
};

// ---- merge records ---------------------------------------------------------------------------

export interface MergeRecord {
  /** The merge commit as made. */
  hash: string;
  tree: string;
  /** The branch's tip when it was merged (the merge's second parent). */
  tip: string;
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

export function parseWorktrees(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
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

/** `git status --porcelain` counted: changed tracked files, untracked entries, and which of those are symlinks. */
export function countChanges(porcelain: string, folder: string): FolderChanges {
  let changed = 0;
  let untracked = 0;
  let links = 0;
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('??')) {
      untracked++;
      const rel = line.slice(3).replace(/\/$/, '');
      try { if (fs.lstatSync(path.join(folder, rel)).isSymbolicLink()) links++; } catch { /* gone */ }
    } else {
      changed++;
    }
  }
  return { changed, untracked, links };
}

const realOrSelf = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

export interface WorkContext {
  agents: () => Agent[];
  messages: () => PeerMessage[];
  /** <dataDir>/agents, whose subfolders are agents' own homes. */
  agentsDir: string;
  /** <dataDir>: cleanup only ever lists folders under it (agent homes, AgentsCode's worktrees) or an agent's recorded worktree. */
  dataDir: string;
  knownRef: (id: string) => boolean;
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
  private records: MergeRecords;
  private git: GitRunner;
  private ctx: WorkContext;
  /** How long a project's view is reused before git is asked again. */
  ttlMs = 10_000;

  constructor(records: MergeRecords, ctx: WorkContext, git: GitRunner = readGit) {
    this.records = records;
    this.ctx = ctx;
    this.git = git;
  }

  async view(projects: Project[], fresh = false): Promise<WorkView> {
    const out = await Promise.all(projects.map(p => this.project(p, fresh)));
    return { projects: out, at: Date.now() };
  }

  async project(project: Project, fresh = false): Promise<WorkProject> {
    const hit = this.cache.get(project.id);
    if (!fresh && hit && Date.now() - hit.at < this.ttlMs) return hit.view;
    let view: WorkProject;
    try {
      view = await this.build(project);
    } catch (err) {
      view = { ...this.empty(project, null), error: (err as Error).message.slice(0, 300) };
    }
    this.cache.set(project.id, { at: Date.now(), view });
    return view;
  }

  private empty(project: Project, defaultBranch: string | null): WorkProject {
    return { projectId: project.id, name: project.name, ...(project.code ? { code: project.code } : {}), defaultBranch, remote: null, notPushed: 0, inProgress: [], merged: [], graph: [], cleanup: { folders: [], branches: [] } };
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
    const worktrees = parseWorktrees((await this.git(['worktree', 'list', '--porcelain'], root)).out);
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
    for (const line of log.out.split('\n')) {
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
      const tip = parents?.split(' ')[1];
      if (!tree || !tip) continue;
      const refs = [...new Set([...info.refs, ...findRefIds(subject ?? '', this.ctx.knownRef).map(r => r.id)])].filter(this.ctx.knownRef);
      found.push({ hash, tree, tip, branch, at, subject: subject ?? '', names: namesInMergeSubject(subject ?? ''), refs, ...(info.reviewer ? { reviewer: info.reviewer } : {}), ...(info.conversationId ? { conversationId: info.conversationId } : {}) });
    }
    this.records.merge(root, found.filter(r => r.tree || known.has(r.hash)));
    return this.records.list(root);
  }

  /**
   * The branches whose tips are in some recorded merge: the branch merged itself, or a branch that
   * went in through it (feat/x merged into feat/y, feat/y merged into main). By branch name, the
   * latest such record.
   */
  private async mergedBranches(records: MergeRecord[], cwd: string): Promise<Map<string, MergeRecord>> {
    const out = new Map<string, MergeRecord>();
    for (const r of [...records].sort((a, b) => a.at - b.at)) {
      const merged = await this.git(['for-each-ref', '--merged', r.tip, '--format=%(refname:short)', 'refs/heads'], cwd);
      if (!merged.ok) continue; // the tip is gone from the repository
      for (const name of merged.out.split('\n').filter(Boolean)) out.set(name, r);
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
    const records = await this.captureMerges(facts);
    const byRecord = await this.mergedBranches(records, root);
    const dataDir = realOrSelf(this.ctx.dataDir);
    const usable = async (branch: string) => branch !== defaultBranch && !branch.startsWith('backup/') && !(await neverUsed(this.git, branch, root));

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
    for (const r of records) {
      if (onMain.has(r.hash) || await this.ancestor(r.hash, defaultBranch, root)) mapped.set(r.hash, r.hash);
      else mapped.set(r.hash, history.find(c => c.tree === r.tree)?.hash ?? null);
    }
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
        hash: now, originalHash: r.hash, rewritten: now !== r.hash, pushed: pushedOf(r),
        ...(r.conversationId ? { conversationId: r.conversationId } : {}), refs: r.refs,
      };
    });

    // The graph: the last 15 on main, each labelled from our records (the same commit or the same files).
    const labels = new Map<string, string[]>();
    const refsOut = await this.git(['for-each-ref', '--format=%(objectname)%1f%(refname:short)', 'refs/tags', `refs/heads/${defaultBranch}`, ...(remote ? [`refs/remotes/${remote}`] : [])], root);
    for (const line of refsOut.out.split('\n').filter(Boolean)) {
      const [hash, name] = line.split('\x1f');
      const label = name === remote ? 'GitHub' : name;
      labels.set(hash, [...(labels.get(hash) ?? []), label]);
    }
    const graph: WorkCommit[] = history.slice(0, 15).map(c => {
      const r = records.find(x => x.hash === c.hash) ?? records.find(x => x.tree === c.tree);
      const names = r?.names.length ? r.names : namesInMergeSubject(c.subject);
      return { hash: c.hash, subject: c.subject, at: c.at, merge: c.merge, names, agentIds: ids(names), ...(r?.reviewer ? { reviewer: r.reviewer } : {}), labels: labels.get(c.hash) ?? [] };
    });

    // Branches checked out somewhere: in progress, or merged and left behind.
    const realRoot = realOrSelf(root);
    const liveWorktrees = new Set(agents.flatMap(a => (a.worktree ? [realOrSelf(a.worktree.path)] : [])));
    const inProgress: WorkBranch[] = [];
    const folders: CleanupFolder[] = [];
    for (const wt of worktrees) {
      const main = realOrSelf(wt.path) === realRoot;
      if (main && (!wt.branch || wt.branch === defaultBranch)) continue;
      const agent = this.owner(wt.path, agents);
      if (wt.prunable || !fs.existsSync(wt.path)) {
        if (!main && !wt.locked && inside(path.resolve(wt.path), path.resolve(this.ctx.dataDir))) folders.push({ path: wt.path, branch: wt.branch, ...(agent ? { agentId: agent.id, agentName: agent.name } : {}), reason: 'missing', changes: { changed: 0, untracked: 0, links: 0 }, dirty: false });
        continue;
      }
      const status = await this.git(['status', '--porcelain', '--untracked-files=normal'], wt.path);
      const changes = countChanges(status.out, wt.path);
      const dirty = changes.changed > 0 || changes.untracked > changes.links;
      const head = wt.head ?? '';
      const record = wt.branch && await usable(wt.branch) ? byRecord.get(wt.branch) ?? null : null;
      // On main by git, unless it is a branch that never had work of its own (just made from main).
      const gitMerged = head ? await this.ancestor(head, defaultBranch, root) && !(wt.branch && await neverUsed(this.git, wt.branch, root)) : false;
      const isLive = liveWorktrees.has(realOrSelf(wt.path));
      // Only folders AgentsCode made: under its data folder, or an agent's recorded worktree; never
      // a worktree another tool or the user made elsewhere.
      const ours = inside(realOrSelf(wt.path), dataDir) || agents.some(a => a.worktree && realOrSelf(a.worktree.path) === realOrSelf(wt.path));
      // A detached folder is listed only when it is clean and its commit is on main: removing one
      // with commits of its own would leave them on no branch.
      const leftover = wt.branch ? Boolean(record || gitMerged) : gitMerged && !dirty;
      if (!main && !wt.locked && !isLive && ours && leftover) {
        folders.push({ path: wt.path, branch: wt.branch, ...(agent ? { agentId: agent.id, agentName: agent.name } : {}), reason: wt.branch ? 'merged' : 'detached', changes, dirty });
        continue;
      }
      if (!wt.branch || record || gitMerged) continue;
      const counts = await this.git(['rev-list', '--left-right', '--count', `${defaultBranch}...${wt.branch}`], root);
      const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
      const last = await this.git(['log', '-1', '--format=%h%x1f%s%x1f%ct', wt.branch], root);
      const [lh, ls, lt] = last.out.trim().split('\x1f');
      const info = fromMessages(wt.branch, messages, agents);
      // Working: its owner is mid-turn in this very folder (its worktree, or where its tools last ran).
      const here = agent && (realOrSelf(agent.worktree?.path ?? '') === realOrSelf(wt.path) || (agent.workingIn && inside(realOrSelf(agent.workingIn.root), realOrSelf(wt.path))));
      const state: WorkState = info.reviewer ? 'approved' : info.reviewing ? 'reviewing' : agent?.status === 'working' && here ? 'working' : 'open';
      inProgress.push({
        branch: wt.branch, folder: wt.path, inPlace: main,
        ...(agent ? { agentId: agent.id, agentName: agent.name } : {}),
        state, ...(info.reviewer || info.reviewing ? { reviewer: info.reviewer ?? info.reviewing } : {}),
        ahead: ahead || 0, behind: behind || 0, changed: changes.changed, untracked: changes.untracked - changes.links,
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
      const fresh = await neverUsed(this.git, name, root);
      const record = fresh ? null : byRecord.get(name) ?? null;
      const gitMerged = !record && !fresh && await this.ancestor(tip, defaultBranch, root);
      if (!record && !gitMerged) continue;
      const names = record?.names ?? [];
      branches.push({ name, by: record ? 'record' : 'git', ...(at ? { inFolder: at } : {}), ...(names[0] ? { agentName: names[0] } : {}) });
    }

    return {
      projectId: project.id, name: project.name, ...(project.code ? { code: project.code } : {}),
      defaultBranch, remote, notPushed, inProgress, merged, graph,
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
      // --force only for a folder whose only extras are symlinks, or one the user confirmed twice.
      const forced = folder.dirty || folder.changes.untracked > 0;
      const removed = await writeGit(['worktree', 'remove', ...(forced ? ['--force'] : []), folder.path], facts.root);
      if (removed.ok) result.removed.folders.push(folder.path); else result.skipped.push({ item: folder.path, why: 'git could not remove it' });
    }
    const after = parseWorktrees((await readGit(['worktree', 'list', '--porcelain'], facts.root)).out);
    for (const raw of request.branches ?? []) {
      const name = String(raw);
      const branch = fresh.cleanup.branches.find(b => b.name === name);
      if (!branch || name === facts.defaultBranch || name.startsWith('backup/')) { result.skipped.push({ item: name, why: 'not on the cleanup list now' }); continue; }
      if (after.some(w => w.branch === name)) { result.skipped.push({ item: name, why: 'still checked out in a folder' }); continue; }
      const deleted = await writeGit(['branch', '-D', name], facts.root);
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
