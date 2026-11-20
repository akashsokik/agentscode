import fs from 'node:fs';
import path from 'node:path';
import type { Agent, AgentProduced, PeerMessage, WalkthroughSummary } from '../shared/types.ts';
import { readGit, type GitRunner } from './work.ts';

// ACH-73: what an agent produced recently, for the Overview (ACH-D98). Read on request from the
// sources PodCode already has: git in the folder it works in (read-only, through the hardened
// runner, ALL-N15), its walkthroughs and the reports it sent. Each item keeps its own time; a missing
// source gives [] or null. Nothing is attributed to the agent from a shared project checkout.

export const PRODUCED_MAX = 10;
const SUMMARY_MAX = 300;

export interface ProducedInput {
  agent: Agent;
  /** The agent's own folder (its PodCode home); worktrees it made there are its own. */
  home: string | null;
  messages: readonly PeerMessage[];
  walkthroughs: readonly WalkthroughSummary[];
  git?: GitRunner;
  now?: number;
  /** Reuse the git half per agent (ACH-73 L4); `fresh` reads it again. */
  cache?: ProducedCache;
  fresh?: boolean;
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The folder it works in: its own PodCode worktree when it has one (its work is there even if it
 * last read the user's checkout), else the codebase it last touched.
 */
function whereOf(agent: Agent, home: string | null): { folder: string; own: boolean; base: string | null; baseCommit: string | null } | null {
  const wt = agent.worktree;
  if (wt) return { folder: wt.path, own: true, base: wt.base, baseCommit: /^[0-9a-f]{40}$/.test(wt.baseCommit) ? wt.baseCommit : null };
  const folder = agent.workingIn?.root ?? null;
  if (!folder) return null;
  return { folder, own: Boolean(home && within(home, folder)), base: null, baseCommit: null };
}

/** A branch name as a ref that exists here: the local branch, else origin's copy of it. */
async function branchRef(git: GitRunner, folder: string, name: string): Promise<string | null> {
  if (!name || name.startsWith('-')) return null;
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    if ((await git(['rev-parse', '--verify', '--quiet', ref], folder)).ok) return ref;
  }
  return null;
}

/**
 * What the branch is measured against: the worktree's base branch (local, else origin's), else the
 * commit it was made from; with no worktree, origin's default branch, else main or master.
 */
async function baseRef(git: GitRunner, folder: string, place: { base: string | null; baseCommit: string | null }): Promise<string | null> {
  if (place.base) return await branchRef(git, folder, place.base) ?? place.baseCommit;
  const remote = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], folder);
  const name = remote.ok ? remote.out.trim().replace(/^origin\//, '') : '';
  for (const candidate of name ? [name] : ['main', 'master']) {
    const ref = await branchRef(git, folder, candidate);
    if (ref) return ref;
  }
  return null;
}

const UNTRACKED_LINE_FILES = 200;
const UNTRACKED_LINE_BYTES = 1024 * 1024;

/** An untracked file's lines, as git would count them once added: a symlink is one, binary or huge counts none. */
function untrackedLines(folder: string, file: string): number {
  const full = path.join(folder, file);
  if (!within(folder, path.dirname(full))) return 0;
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return 1;
    if (!stat.isFile() || stat.size === 0 || stat.size > UNTRACKED_LINE_BYTES) return 0;
    const data = fs.readFileSync(full);
    if (data.subarray(0, 8000).includes(0)) return 0;
    const newlines = data.reduce((n, byte) => n + (byte === 10 ? 1 : 0), 0);
    return newlines + (data[data.length - 1] === 10 ? 0 : 1);
  } catch { return 0; }
}

/** Worktree setup links (a node_modules or .venv symlink) are not changes. */
function dependencyLink(folder: string, file: string): boolean {
  if (!['node_modules', '.venv'].includes(path.basename(file.replace(/\/$/, '')))) return false;
  try { return fs.lstatSync(path.join(folder, file.replace(/\/$/, ''))).isSymbolicLink(); } catch { return false; }
}

async function uncommitted(git: GitRunner, folder: string): Promise<AgentProduced['uncommitted']> {
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], folder);
  if (!status.ok) return null;
  const paths = new Set<string>();
  const untracked: string[] = [];
  const records = status.out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    // A rename or copy is followed by its old path, which is the same change.
    if (/[RC]/.test(code)) i++;
    if (code === '??') {
      if (dependencyLink(folder, file)) continue;
      untracked.push(file);
    }
    paths.add(file);
  }
  let added = 0;
  let removed = 0;
  const numstat = await git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD'], folder);
  if (numstat.ok) {
    for (const line of numstat.out.split('\n')) {
      const [a, r] = line.split('\t');
      // Binary files show "-": they changed, but have no line counts.
      if (/^\d+$/.test(a ?? '')) added += Number(a);
      if (/^\d+$/.test(r ?? '')) removed += Number(r);
    }
  }
  // New files are changes too: count their lines, as `git add` then `git diff` would.
  for (const file of untracked.slice(0, UNTRACKED_LINE_FILES)) added += untrackedLines(folder, file);
  return { files: paths.size, added, removed };
}

async function commits(git: GitRunner, folder: string, base: string): Promise<AgentProduced['commits']> {
  const log = await git(['log', '--format=%H%x1f%s%x1f%ct', '-n', String(PRODUCED_MAX), `${base}..HEAD`, '--'], folder);
  if (!log.ok) return [];
  return log.out.split('\n').flatMap(line => {
    const [hash, subject, at] = line.split('\x1f');
    return hash && /^[0-9a-f]{40}$/.test(hash) ? [{ hash, subject: subject ?? '', at: Number(at) * 1000 }] : [];
  });
}

type GitPart = Pick<AgentProduced, 'where' | 'commits' | 'uncommitted'>;

/** The git half: where it works, its own commits there and the uncommitted changes. */
async function gitPart(git: GitRunner, place: NonNullable<ReturnType<typeof whereOf>>): Promise<GitPart> {
  const none: GitPart = { where: null, commits: [], uncommitted: null };
  if (!fs.existsSync(place.folder)) return none;
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], place.folder);
  if (!head.ok) return { ...none, where: { folder: place.folder, branch: null, own: place.own } };
  const name = head.out.trim();
  const branch = name && name !== 'HEAD' ? name : null;
  const out: GitPart = { where: { folder: place.folder, branch, own: place.own }, commits: [], uncommitted: await uncommitted(git, place.folder) };
  if (place.own && branch) {
    const base = await baseRef(git, place.folder, place);
    if (base) out.commits = await commits(git, place.folder, base);
  }
  return out;
}

/** How long a git reading is reused when nothing said it changed. */
export const PRODUCED_TTL_MS = 60_000;

/**
 * The git half per agent, so opening the Overview or many clients asking costs one reading: reused
 * until the agent's turn ends (invalidate), the folder changes, a fresh one is asked for (the panel
 * opening) or it is a minute old. Callers at the same time share one reading.
 */
export class ProducedCache {
  private entries = new Map<string, { key: string; at: number; value: Promise<GitPart> }>();

  get(agentId: string, key: string, now: number, fresh: boolean, read: () => Promise<GitPart>): Promise<GitPart> {
    const hit = this.entries.get(agentId);
    if (hit && hit.key === key && !fresh && now - hit.at < PRODUCED_TTL_MS) return hit.value;
    const value = read();
    this.entries.set(agentId, { key, at: now, value });
    // A failed reading is not kept.
    value.catch(() => { if (this.entries.get(agentId)?.value === value) this.entries.delete(agentId); });
    return value;
  }

  invalidate(agentId: string): void {
    this.entries.delete(agentId);
  }
}

export async function agentProduced(input: ProducedInput): Promise<AgentProduced> {
  const git = input.git ?? readGit;
  const { agent } = input;
  const now = input.now ?? Date.now();
  // Reports and walkthroughs are PodCode's own records: always current, no git.
  const reports = input.messages
    .filter(m => m.fromAgentId === agent.id && m.report)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, PRODUCED_MAX)
    .map(m => ({
      messageId: m.id, conversationId: m.conversationId, toAgentId: m.toAgentId, toName: m.toName,
      outcome: m.report!.outcome, summary: m.report!.summary.slice(0, SUMMARY_MAX), at: m.ts,
    }));
  const walkthroughs = [...input.walkthroughs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PRODUCED_MAX)
    .map(w => ({ id: w.id, title: w.title, createdAt: w.createdAt, ...(w.branch ? { branch: w.branch } : {}), ...(w.commit ? { commit: w.commit } : {}) }));
  const place = whereOf(agent, input.home);
  const part = !place ? { where: null, commits: [], uncommitted: null }
    : input.cache ? await input.cache.get(agent.id, `${place.folder}\0${place.own}\0${place.base ?? ''}`, now, Boolean(input.fresh), () => gitPart(git, place))
    : await gitPart(git, place);
  return { at: now, ...part, walkthroughs, reports };
}
