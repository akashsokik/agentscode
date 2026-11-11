import type { GraphEdge } from './graph.ts';

// The Work view (ACH-D17): what every agent is working on, what was merged into each project's
// main and whether it is on GitHub, a short graph of main, and what can be cleaned up. Built by
// server/work.ts from git (read only) and AgentsCode's own merge and review records.

/** How a branch in progress stands, from our records first, then the owner's status. */
export type WorkState = 'approved' | 'reviewing' | 'working' | 'open';

export interface WorkBranch {
  branch: string;
  /** The folder it is checked out in (a worktree, or a project's own folder for work done in place). */
  folder: string;
  /** It is the project's own checkout, not a worktree. */
  inPlace: boolean;
  /** The agent it belongs to, when known. */
  agentId?: string;
  agentName?: string;
  state: WorkState;
  /** Who is reviewing it or approved it, for "Rhea reviewing" and "approved". */
  reviewer?: string;
  ahead: number;
  behind: number;
  /** Uncommitted changes: tracked files changed, and untracked ones (symlinks counted apart). */
  changed: number;
  untracked: number;
  last?: { hash: string; subject: string; at: number };
  /** The delegation it came from, to open in Comms, and decision ids its task named. */
  conversationId?: string;
  refs: string[];
}

export interface WorkMerge {
  branch: string;
  /** When it was merged into local main (from git's record of main). */
  at: number;
  /** Who did the work, from our records or the merge's own message. */
  agentIds: string[];
  names: string[];
  reviewer?: string;
  /** The merge as it is on main now: the original commit, the commit a rewrite turned it into (same files), or null when a rewrite folded it in with others. */
  hash: string | null;
  /** The original merge commit, which may no longer be on main. */
  originalHash: string;
  rewritten: boolean;
  /** On origin's main: yes, no, or not known (a rewrite hid it and nothing after it tells). */
  pushed: boolean | null;
  /** Why it counts as on main now: the commit itself, the same files on main, or kept in a backup ref from before a rewrite. */
  evidence: { kind: 'main' | 'content' | 'backup'; backup?: string };
  conversationId?: string;
  refs: string[];
}

/** A ref at a commit, as a pill (ACH-D18): a local branch (with its GitHub copy when that is at the same commit), a remote branch on its own, or a tag. */
export interface WorkRef {
  kind: 'local' | 'remote' | 'tag';
  name: string;
  /** For a local branch: its remote copy at the same commit (origin/main), drawn in the same pill. */
  remote?: string;
}

export interface WorkCommit {
  hash: string;
  parents: string[];
  subject: string;
  at: number;
  merge: boolean;
  /** Who it is from: our merge records (also after a rewrite, by the same files) or the message. */
  agentIds: string[];
  names: string[];
  reviewer?: string;
  refs: WorkRef[];
  /** The project's checked-out commit. */
  head: boolean;
  /** Its lane and whose lane that is ('main', an owner's name, or null), from shared/graph.ts. */
  lane: number;
  key: string | null;
}

/** Why a folder counts as having uncommitted changes. */
export interface FolderChanges {
  changed: number;
  untracked: number;
  /** Untracked entries that are only symlinks (a linked node_modules): removing the folder removes the link, never what it points to. */
  links: number;
  /** Ignored build output (dist/, out/ and the like), rebuilt by a build. */
  built: number;
  /** Other ignored files (.env and the like), by path: git never saw them, and removing the folder deletes them. */
  ignored: string[];
}

export interface CleanupFolder {
  path: string;
  branch: string | null;
  agentId?: string;
  agentName?: string;
  /** Why it is listed: its branch is merged (by our records or git), detached and clean, or the folder is gone. */
  reason: 'merged' | 'detached' | 'missing';
  changes: FolderChanges;
  /** Changes beyond symlinks: it starts unticked, and removing it needs a second yes. */
  dirty: boolean;
}

export interface CleanupBranch {
  name: string;
  /** Merged by our records (needed after a rewrite) or by git itself. */
  by: 'record' | 'git';
  /** Its commits are kept in this backup ref (from before a rewrite), so deleting the branch loses none. */
  backup?: string;
  /** For one merged by record: on main as merged, on main by its files (after a rewrite), or kept in a backup ref. */
  evidence?: 'main' | 'content' | 'backup';
  /** It is checked out in this listed folder, so it goes once the folder does. */
  inFolder?: string;
  agentName?: string;
}

export interface WorkProject {
  projectId: string;
  name: string;
  code?: string;
  /** null when the folder is not a git repository. */
  defaultBranch: string | null;
  /** origin's main as last fetched by someone else; AgentsCode never fetches. */
  remote: string | null;
  /** Changes on local main (first-parent: a merge counts once) that origin's main does not have. */
  notPushed: number;
  inProgress: WorkBranch[];
  merged: WorkMerge[];
  /** About 20 commits of main and its open branches, newest first, laid out in lanes (ACH-D18). */
  graph: WorkCommit[];
  graphEdges: GraphEdge[];
  graphLanes: number;
  /** A lane key that is an agent's name, to its id, for the lane's colour (the agent's avatar colour). */
  laneOwners: Record<string, string>;
  cleanup: { folders: CleanupFolder[]; branches: CleanupBranch[] };
  error?: string;
}

export interface WorkView {
  projects: WorkProject[];
  at: number;
}

export interface CleanupRequest {
  projectId: string;
  folders: string[];
  branches: string[];
  /** Folders with real uncommitted changes the user said yes to a second time. */
  forceFolders?: string[];
}

export interface CleanupResult {
  removed: { folders: string[]; branches: string[] };
  skipped: { item: string; why: string }[];
}

/**
 * Pills from `git log --decorate=full --format=%D`: local branches, remote branches, tags, and
 * whether HEAD is here. A local branch whose remote copy (origin/<same name>) is at the same commit
 * takes it into its pill, as VS Code's Git Graph does by default; remote HEAD pointers are left out.
 */
export function parseDecorations(text: string): { refs: WorkRef[]; head: boolean } {
  let head = false;
  const locals: WorkRef[] = [];
  const remotes: string[] = [];
  const tags: WorkRef[] = [];
  for (const raw of text.split(',').map(s => s.trim()).filter(Boolean)) {
    let ref = raw;
    if (ref === 'HEAD') { head = true; continue; }
    if (ref.startsWith('HEAD -> ')) { head = true; ref = ref.slice(8); }
    if (ref.startsWith('tag: ')) { tags.push({ kind: 'tag', name: ref.slice(5).replace(/^refs\/tags\//, '') }); continue; }
    if (ref.startsWith('refs/heads/')) { locals.push({ kind: 'local', name: ref.slice(11) }); continue; }
    if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remotes.push(ref.slice(13));
  }
  const loose: WorkRef[] = [];
  for (const remote of remotes) {
    const branch = remote.slice(remote.indexOf('/') + 1);
    const local = locals.find(l => l.name === branch && !l.remote);
    if (local) local.remote = remote; else loose.push({ kind: 'remote', name: remote });
  }
  return { refs: [...locals, ...loose, ...tags], head };
}

/** A branch name as a whole word in text: feat/notes-tab, not feat/notes-tab-2. */
export function mentionsBranch(text: string, branch: string): boolean {
  if (!branch) return false;
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w/.-])${escaped}(?![\\w/-]|\\.\\w)`).test(text);
}

/** The names in a merge message's parentheses: "Merge feat/x (Fen, Ada): ..." gives Fen and Ada. */
export function namesInMergeSubject(subject: string): string[] {
  const match = /^Merge\s+\S+\s+\(([^)]{1,80})\)/.exec(subject);
  if (!match) return [];
  return match[1].split(/\s*,\s*|\s+and\s+/).map(s => s.trim()).filter(s => /^[\w .-]{1,24}$/.test(s));
}
