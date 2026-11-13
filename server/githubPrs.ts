// The Pull requests page's data (ACH-D42, ACH-D43): open and recently merged PRs across the
// user's projects, read through the same read-only gh path the SuperAgent uses (server/github.ts).
// Nothing here writes to GitHub. Results are cached briefly so opening the page or switching views
// does not run gh again; a refresh asks for fresh data.
import type { Agent, Project } from '../shared/types.ts';
import { normalizePr, type PrPageData, type PullRequest } from '../shared/prs.ts';
import { GhError, ghArgs } from './github.ts';

export const PRS_CACHE_MS = 60_000;
/** A refresh within this long of the last read gets that read: repeated clicks never stack up gh calls. */
export const PRS_REFRESH_FLOOR_MS = 10_000;

export interface PrSource {
  projects: () => Iterable<Project>;
  agents: () => Iterable<Agent>;
  /** owner/name for a project's GitHub remote, or null when it has none. */
  repoOf: (project: Project) => Promise<string | null>;
  /** Runs gh with read-only arguments (server/github.ts runGh). */
  gh: (args: string[]) => Promise<string>;
  now?: () => number;
  /**
   * Called with every fresh read from GitHub (not with cached answers), after the cache holds it.
   * For listeners such as issue auto-close; a throw here is logged and never fails the read.
   */
  onRead?: (data: PrPageData) => void | Promise<void>;
}

/** The PodCode agent that worked on a branch: its worktree is on it, or the branch is agent/<name>/... */
export function agentForBranch(agents: Iterable<Agent>, branch: string): string | undefined {
  const list = [...agents];
  const byWorktree = list.find(a => a.worktree?.branch === branch);
  if (byWorktree) return byWorktree.id;
  const m = /^agents?\/([^/]+)/i.exec(branch);
  if (!m) return undefined;
  const name = m[1].toLowerCase();
  return list.find(a => a.name.toLowerCase() === name)?.id;
}

export class PullRequests {
  private source: PrSource;
  private cache: PrPageData | null = null;
  private inflight: Promise<PrPageData> | null = null;

  constructor(source: PrSource) { this.source = source; }

  private now(): number { return this.source.now?.() ?? Date.now(); }

  /** Cached for PRS_CACHE_MS; `refresh` reads GitHub again. Two calls at once share one read. */
  async list(refresh = false): Promise<PrPageData> {
    const age = this.cache ? this.now() - this.cache.fetchedAt : Infinity;
    if (this.cache && age < (refresh ? PRS_REFRESH_FLOOR_MS : PRS_CACHE_MS)) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.read().then(data => {
      this.cache = data;
      if (!data.error) void Promise.resolve().then(() => this.source.onRead?.(data)).catch(err => console.error('[prs] onRead failed:', (err as Error).message));
      return data;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async read(): Promise<PrPageData> {
    const projects = [...this.source.projects()];
    // ALL holds issues that belong to no project (Fen's NO_PROJECT_CODE), so ALL-12 links too.
    const codes = [...projects.flatMap(p => (p.code ? [p.code] : [])), 'ALL'];
    const agents = [...this.source.agents()];
    const skipped: PrPageData['skipped'] = [];
    // Several projects can share a repo (two checkouts of one); read each repo once.
    const repos = new Map<string, Project[]>();
    await Promise.all(projects.map(async project => {
      if (!project.exists) { skipped.push({ project: project.name, reason: 'The folder is missing.' }); return; }
      const repo = await this.source.repoOf(project).catch(() => null);
      if (!repo) { skipped.push({ project: project.name, reason: 'No GitHub remote.' }); return; }
      repos.set(repo, [...(repos.get(repo) ?? []), project]);
    }));
    const pullRequests: PullRequest[] = [];
    let fatal: string | undefined;
    await Promise.all([...repos].map(async ([repo, owners]) => {
      try {
        const lists = await Promise.all((['open', 'merged'] as const).map(async state => JSON.parse(await this.source.gh(ghArgs.prsPage(repo, state)) || '[]') as unknown));
        for (const list of lists) {
          if (!Array.isArray(list)) continue;
          for (const raw of list) {
            const pr = normalizePr(raw as Record<string, unknown>, repo, { codes, agentFor: branch => agentForBranch(agents, branch) });
            pr.projects = owners.map(p => ({ id: p.id, name: p.name, ...(p.code ? { code: p.code } : {}) }));
            pullRequests.push(pr);
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        // gh missing or logged out stops every repo the same way: say it once.
        if (err instanceof GhError && /not installed|not logged in/.test(message)) fatal = message;
        else for (const p of owners) skipped.push({ project: p.name, reason: message.slice(0, 300) });
      }
    }));
    skipped.sort((a, b) => a.project.localeCompare(b.project));
    return { pullRequests: fatal ? [] : pullRequests, skipped, ...(fatal ? { error: fatal } : {}), fetchedAt: this.now() };
  }
}
