import { isStaleBranch, type WorkBranch, type WorkCommit, type WorkProject } from '../../shared/work.ts';

// What one row of the calm Work graph shows (ACH-D34), kept pure so the rules are tested without a DOM.

/** A branch name without its fix/, feat/... prefix, for a label that leaves the subject the room. */
export function shortBranch(name: string): string {
  return name.replace(/^(fix|feat|feature|chore|test|tests|docs|refactor|perf|ci|build|style|release|hotfix)\//, '');
}

/** The open branches the graph draws (with a lane and a label), and the stale ones it folds into one row. */
export function splitBranches(project: Pick<WorkProject, 'inProgress'>, now: number): { open: WorkBranch[]; older: WorkBranch[] } {
  const open: WorkBranch[] = [];
  const older: WorkBranch[] = [];
  for (const b of project.inProgress) (isStaleBranch(b, now) ? older : open).push(b);
  return { open, older };
}

/**
 * The labels a commit row carries: only the tips of open, non-stale branches (a branch's local and
 * remote refs count once; a remote copy behind the local tip gets none). Merged branches, main,
 * remote main and stale branches get none.
 */
export function tipLabels(commit: Pick<WorkCommit, 'refs'>, open: readonly WorkBranch[], graph: readonly Pick<WorkCommit, 'refs'>[] = []): WorkBranch[] {
  const out: WorkBranch[] = [];
  for (const ref of commit.refs) {
    if (ref.kind === 'tag') continue;
    const name = ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
    // A remote copy labels only a branch with no local tip in view (an older pushed copy is not the tip).
    if (ref.kind === 'remote' && graph.some(c => c.refs.some(r => r.kind === 'local' && r.name === name))) continue;
    const branch = open.find(b => b.branch === name);
    if (branch && !out.includes(branch)) out.push(branch);
  }
  return out;
}

/** Release tags stay as quiet text. */
export function tagNames(commit: Pick<WorkCommit, 'refs'>): string[] {
  return commit.refs.filter(r => r.kind === 'tag').map(r => r.name);
}

/**
 * The branch a merge commit brought in: our merge records by hash, else git's own subject ("Merge
 * branch 'x'", "Merge x: ...", "Merge approved x ..."). Undefined when it is not a merge or not known.
 */
export function mergedBranch(project: Pick<WorkProject, 'merged'>, commit: Pick<WorkCommit, 'hash' | 'merge' | 'subject'>): string | undefined {
  if (!commit.merge) return undefined;
  const record = project.merged.find(m => m.hash === commit.hash);
  if (record) return record.branch;
  const quoted = /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(commit.subject);
  if (quoted) return quoted[1];
  const plain = /^Merge (?:approved )?([\w.-]+\/[\w./-]+?)(?=[:\s(]|$)/.exec(commit.subject);
  return plain?.[1];
}

/** A merge row reads "Merged <short branch>"; any other row its own subject. */
export function rowText(project: Pick<WorkProject, 'merged'>, commit: Pick<WorkCommit, 'hash' | 'merge' | 'subject'>): { text: string; merge: boolean } {
  const branch = mergedBranch(project, commit);
  return branch ? { text: `Merged ${shortBranch(branch)}`, merge: true } : { text: commit.subject, merge: false };
}

/**
 * The owners a row shows at its end: who made the commit (a merge: everyone it names), at most three
 * avatars, nothing at all when nobody was recorded (never a "?").
 */
export function rowOwners(commit: Pick<WorkCommit, 'names' | 'agentIds'>): { id?: string; name: string }[] {
  const aligned = commit.names.length === commit.agentIds.length;
  return commit.names.slice(0, 3).map((name, i) => ({ ...(aligned ? { id: commit.agentIds[i] } : {}), name }));
}

/** The graph header's count: "2 open · 4 older", "4 older", or "No open branches". */
export function branchCount(open: number, older: number): string {
  const parts = [open ? `${open} open` : '', older ? `${older} older` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No open branches';
}
