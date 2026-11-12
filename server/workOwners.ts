import fs from 'node:fs';
import path from 'node:path';

/**
 * Who owns a branch, and who made a commit (ACH-D34), recorded as it happens so the Work graph can
 * show owners for real, never guessed from names or message text:
 * - a branch's owner is the agent whose own folder (its worktree, or a folder under its home) has
 *   the branch checked out; the latest such agent wins (a branch name can be reused);
 * - a commit's owner is fixed the first time it is seen: on an owned branch ahead of main, or in
 *   the range a merge into main brought in (a fast-forward's old..new, a merge's second parent).
 */
export interface Owner { agentId: string; name: string }

interface ProjectOwners {
  branches: Record<string, Owner & { at: number }>;
  commits: Record<string, Owner>;
  /** Reflog entries of main already read (by hash and message), so each merge is read once. */
  seen: string[];
}

type OwnersFile = Record<string, ProjectOwners>;

/** Branch names that are never anyone's own work, and short hashes (a detached checkout). */
export function ownableBranch(branch: string | null | undefined): branch is string {
  return Boolean(branch) && !/^(main|master|HEAD)$/.test(branch!) && !branch!.startsWith('backup/') && !/^[0-9a-f]{7,40}$/.test(branch!);
}

export class WorkOwners {
  private file: string | null;
  private data: OwnersFile | null = null;
  private dirty = false;
  /** At most this many commits and reflog entries are kept per project. */
  limit = 5_000;
  /** `dir` null keeps the records in memory only (tests, and a service built without one). */
  constructor(dir: string | null) { this.file = dir ? path.join(dir, 'owners.json') : null; }

  private load(): OwnersFile {
    if (this.data) return this.data;
    if (!this.file) return this.data = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      this.data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as OwnersFile : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }

  private project(projectId: string): ProjectOwners {
    const data = this.load();
    const p = data[projectId] ??= { branches: {}, commits: {}, seen: [] };
    p.branches ??= {}; p.commits ??= {}; p.seen ??= [];
    return p;
  }

  /** An agent has this branch checked out in its own folder. */
  noteBranch(projectId: string, branch: string | null | undefined, owner: Owner, at = Date.now()): void {
    if (!ownableBranch(branch)) return;
    const p = this.project(projectId);
    const known = p.branches[branch];
    if (known && known.agentId === owner.agentId && known.name === owner.name) return;
    p.branches[branch] = { agentId: owner.agentId, name: owner.name, at };
    this.dirty = true;
  }

  /** The branch's recorded owner; with `asOf`, only one recorded by then (a later owner of a reused name is not the one who merged it). */
  branchOwner(projectId: string, branch: string, asOf?: number): Owner | undefined {
    const known = this.project(projectId).branches[branch];
    if (!known || (asOf !== undefined && known.at > asOf)) return undefined;
    return { agentId: known.agentId, name: known.name };
  }

  /** These commits are the owner's, unless an earlier sighting already said whose they are. */
  noteCommits(projectId: string, hashes: readonly string[], owner: Owner): void {
    const p = this.project(projectId);
    for (const hash of hashes) {
      if (!hash || p.commits[hash]) continue;
      p.commits[hash] = { agentId: owner.agentId, name: owner.name };
      this.dirty = true;
    }
    const keys = Object.keys(p.commits);
    if (keys.length > this.limit) for (const old of keys.slice(0, keys.length - this.limit)) delete p.commits[old];
  }

  commitOwner(projectId: string, hash: string): Owner | undefined {
    return this.project(projectId).commits[hash];
  }

  seen(projectId: string, entry: string): boolean {
    return this.project(projectId).seen.includes(entry);
  }

  /** The reflog entries already read, as a set for a whole scan. */
  seenSet(projectId: string): Set<string> {
    return new Set(this.project(projectId).seen);
  }

  markSeen(projectId: string, entries: readonly string[]): void {
    const p = this.project(projectId);
    const fresh = entries.filter(e => !p.seen.includes(e));
    if (!fresh.length) return;
    p.seen.push(...fresh);
    if (p.seen.length > this.limit) p.seen.splice(0, p.seen.length - this.limit);
    this.dirty = true;
  }

  /** Write what changed (atomically), if anything did. */
  save(): void {
    if (!this.dirty || !this.data || !this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}

/**
 * Main's reflog, newest first, as merges into it: the branch, the new main, the main before it (the
 * next older entry), and whether git fast-forwarded. Other entries (commits, resets, pulls of a
 * remote) are not anyone's branch work.
 */
export interface ReflogMerge { entry: string; branch: string; hash: string; before: string | null; fastForward: boolean; at: number }

export function reflogMerges(text: string, defaultBranch: string): ReflogMerge[] {
  const lines = text.split('\n').filter(Boolean).map(line => { const [hash = '', what = '', selector = ''] = line.split('\x1f'); return { hash, what, at: Number(/@\{(\d+)\}/.exec(selector)?.[1] ?? 0) * 1000 }; });
  const out: ReflogMerge[] = [];
  lines.forEach((line, i) => {
    const merge = /^merge ([^:\s]+): (.*)$/.exec(line.what);
    if (!line.hash || !merge || merge[1] === defaultBranch || /^(origin|upstream|refs\/remotes)\//.test(merge[1])) return;
    out.push({ entry: `${line.hash} ${line.what}`, branch: merge[1], hash: line.hash, before: lines[i + 1]?.hash || null, fastForward: /^Fast-forward/.test(merge[2]), at: line.at });
  });
  return out;
}
