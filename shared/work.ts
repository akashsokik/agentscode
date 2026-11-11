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
  conversationId?: string;
  refs: string[];
}

export interface WorkCommit {
  hash: string;
  subject: string;
  at: number;
  merge: boolean;
  /** Who it is from: our merge records (also after a rewrite, by the same files) or the message. */
  agentIds: string[];
  names: string[];
  reviewer?: string;
  /** main, GitHub (origin's main) and tags at this commit. */
  labels: string[];
}

/** Why a folder counts as having uncommitted changes. */
export interface FolderChanges {
  changed: number;
  untracked: number;
  /** Untracked entries that are only symlinks (a linked node_modules): removing the folder removes the link, never what it points to. */
  links: number;
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
  graph: WorkCommit[];
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
