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
}

function real(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The folder it works in: the codebase it last touched, else its worktree. */
function whereOf(agent: Agent, home: string | null): { folder: string; own: boolean; base: string | null } | null {
  const folder = agent.workingIn?.root ?? agent.worktree?.path ?? null;
  if (!folder) return null;
  const wt = agent.worktree;
  if (wt && within(wt.path, folder) && within(folder, wt.path)) return { folder, own: true, base: wt.base };
  return { folder, own: Boolean(home && within(home, folder)), base: null };
}

/** The branch the work is measured against: origin's default branch, else main or master. */
async function baseBranch(git: GitRunner, folder: string): Promise<string | null> {
  const remote = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], folder);
  const name = remote.ok ? remote.out.trim().replace(/^origin\//, '') : '';
  if (name) return name;
  for (const candidate of ['main', 'master']) {
    if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], folder)).ok) return candidate;
  }
  return null;
}

/** Worktree setup links (a node_modules or .venv symlink) are not changes. */
function dependencyLink(folder: string, file: string): boolean {
  if (!['node_modules', '.venv'].includes(path.basename(file.replace(/\/$/, '')))) return false;
  try { return fs.lstatSync(path.join(folder, file.replace(/\/$/, ''))).isSymbolicLink(); } catch { return false; }
}

async function uncommitted(git: GitRunner, folder: string): Promise<AgentProduced['uncommitted']> {
  const status = await git(['status', '--porcelain', '-z'], folder);
  if (!status.ok) return null;
  const paths = new Set<string>();
  const records = status.out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    // A rename or copy is followed by its old path, which is the same change.
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (code === '??' && dependencyLink(folder, file)) continue;
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
  return { files: paths.size, added, removed };
}

async function commits(git: GitRunner, folder: string, branch: string, base: string): Promise<AgentProduced['commits']> {
  if (branch === base || base.startsWith('-')) return [];
  const log = await git(['log', '--format=%H%x1f%s%x1f%ct', '-n', String(PRODUCED_MAX), `${base}..HEAD`, '--'], folder);
  if (!log.ok) return [];
  return log.out.split('\n').flatMap(line => {
    const [hash, subject, at] = line.split('\x1f');
    return hash && /^[0-9a-f]{40}$/.test(hash) ? [{ hash, subject: subject ?? '', at: Number(at) * 1000 }] : [];
  });
}

export async function agentProduced(input: ProducedInput): Promise<AgentProduced> {
  const git = input.git ?? readGit;
  const { agent } = input;
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
  const out: AgentProduced = { at: input.now ?? Date.now(), where: null, commits: [], uncommitted: null, walkthroughs, reports };

  const place = whereOf(agent, input.home);
  if (!place || !fs.existsSync(place.folder)) return out;
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], place.folder);
  if (!head.ok) {
    out.where = { folder: place.folder, branch: null, own: place.own };
    return out;
  }
  const name = head.out.trim();
  const branch = name && name !== 'HEAD' ? name : null;
  out.where = { folder: place.folder, branch, own: place.own };
  out.uncommitted = await uncommitted(git, place.folder);
  if (place.own && branch) {
    const base = place.base ?? await baseBranch(git, place.folder);
    if (base) out.commits = await commits(git, place.folder, branch, base);
  }
  return out;
}
