import type { Project, SuperIssue } from '../shared/types.ts';
import { isOpenIssue } from '../shared/issues.ts';
import { findIssueKeys, issueKeysIn } from '../shared/issueKeys.ts';
import type { MergeRecord, GitRunner, WorkService } from './work.ts';
import { readGit } from './work.ts';
import type { RefCommit, RefMentions } from './refMentions.ts';
import type { ProjectRefs } from './projectRefs.ts';
import { parseRefId } from './projectRefs.ts';
import { HttpError } from './errors.ts';

/** The adapter over githubPrs.ts. It consumes that service's read-only data, never runs gh itself. */
export interface MergedIssuePr {
  repo: string;
  number: number;
  projects: { id: string }[];
  state: string;
  branch: string;
  title: string;
  body?: string;
  mergedAt?: string | null;
  mergeCommit?: string | null;
}

export interface IssueLinkStore {
  issues(): SuperIssue[];
  updateIssue(id: string, patch: { status?: 'done'; activityText: string; activityRef: string }, now: number, by: { kind: 'git' }): SuperIssue;
}

/** A newer merge can finish reopened work; a past merge (even after restarting) cannot. */
function openSince(issue: SuperIssue): number {
  const reopened = issue.activity.filter(e => e.kind === 'status' && e.from && ['done', 'canceled'].includes(e.from) && e.to && !['done', 'canceled'].includes(e.to));
  if (reopened.length) {
    // Git cannot order an unseen merge within the same second as a reopen. Never let a past
    // merge close reopened work: ambiguous same-second events are recorded without closing.
    return (Math.floor(Math.max(...reopened.map(e => e.at)) / 1000) + 1) * 1000;
  }
  return Math.floor(issue.createdAt / 1000) * 1000;
}

function alreadyLogged(issue: SuperIssue, identity: string): boolean {
  return issue.activity.some(e => e.ref === identity);
}

export interface IssueLinkSource {
  projects: () => Project[];
  work: Pick<WorkService, 'view' | 'refreshMerges'>;
  mentions: RefMentions;
  refs: Pick<ProjectRefs, 'get'>;
}

export class IssueLinks {
  private readonly store: IssueLinkStore;
  private readonly now: () => number;
  private readonly changed: () => void;
  private readonly source?: IssueLinkSource;
  private refreshing: Promise<void> | null = null;
  private readonly commitCache = new Map<string, Pick<RefCommit, 'hash' | 'text' | 'author' | 'at'>[]>();
  private readonly records = new Map<string, MergeRecord[]>();

  constructor(store: IssueLinkStore, now = Date.now, changed = () => {}, source?: IssueLinkSource) {
    this.store = store; this.now = now; this.changed = changed; this.source = source;
  }

  private codes(issues: readonly SuperIssue[] = this.store.issues()): Set<string> {
    return new Set(['ALL', ...(this.source?.projects() ?? []).flatMap(p => p.code ? [p.code] : []), ...issues.map(i => i.key.slice(0, i.key.lastIndexOf('-')))]);
  }

  private keys(text: string, codes = this.codes()): string[] {
    return issueKeysIn(text, codes);
  }

  /** A mention links a PR; only an explicit closing phrase completes its issue. */
  private closingKeys(text: string, codes = this.codes()): string[] {
    const upper = text.toUpperCase();
    const keys = new Set<string>();
    for (const phrase of upper.matchAll(/\b(?:FIX(?:ES|ED)?|CLOS(?:E|ES|ED)|RESOLV(?:E|ES|ED))(?:\s*:\s*|\s+)/g)) {
      // Match the phrase first: the shared key matcher deduplicates repeated mentions.
      const match = findIssueKeys(upper.slice(phrase.index + phrase[0].length), codes)[0];
      if (match?.index === 0) keys.add(match.key);
    }
    return [...keys];
  }

  /** Local checks reuse verified evidence until HEAD/ref/reflog files change; idle ticks run no Git.
   * GitHub closures are delivered by PullRequests.onRead; this timer never polls gh. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (this.source) {
        const projects = this.source.projects().filter(p => this.store.issues().some(i => i.projectId === p.id && isOpenIssue(i)));
        if (projects.length) await this.source.work.refreshMerges(projects);
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async index(projectId?: string | null): Promise<void> {
    if (!this.source) throw new HttpError(409, 'Issue links are not connected.');
    const projects = this.source.projects().filter(p => (projectId === undefined || p.id === projectId) && this.store.issues().some(i => i.projectId === p.id));
    const work = await this.source.work.view(projects);
    for (const project of projects) {
      const view = work.projects.find(p => p.projectId === project.id);
      if (view?.defaultBranch) await this.indexCommits(project, view.defaultBranch, view.inProgress.map(b => b.branch), this.source.mentions);
    }
  }

  /** The issue view's read API. Citations retain unknown decision ids internally until recorded. */
  async decisions(id: string) {
    const issue = this.store.issues().find(i => i.id === id || i.key === id);
    if (!issue) throw new HttpError(404, 'No issue with that id or key.');
    await this.index(issue.projectId);
    return { issueId: issue.id, key: issue.key, decisions: this.source!.mentions.issueDecisions(issue).filter(d => this.source!.refs.get(d.id)?.kind === 'D') };
  }

  /** The Notes tab's reverse API, using exactly the same citation evidence. */
  async issuesForDecision(rawId: string) {
    const ref = parseRefId(rawId);
    if (!ref || ref.kind !== 'D') throw new HttpError(400, 'Give a decision id such as ACH-D7.');
    if (!this.source?.refs.get(ref.id)) throw new HttpError(404, `There is no decision ${ref.id}.`);
    await this.index();
    return { id: ref.id, issues: this.source.mentions.decisionIssues(ref.id, this.store.issues()) };
  }

  private recordMerge(issues: Map<string, SuperIssue>, issue: SuperIssue, text: string, ref: string, closes: boolean): boolean {
    try {
      issues.set(issue.id, this.store.updateIssue(issue.id, { ...(closes ? { status: 'done' as const } : {}), activityText: text, activityRef: ref }, this.now(), { kind: 'git' }));
      return true;
    } catch (err) {
      // An earlier update can prune an old closed issue from the store's retained history.
      if (!(err instanceof HttpError) || err.status !== 404) throw err;
      issues.delete(issue.id);
      return false;
    }
  }

  /** Called with Work's verified records, before its UI's 30-merge limit. No new git reads. */
  localMerges(project: Project, records: MergeRecord[]): number {
    this.records.set(project.id, records);
    let changed = 0, observed = 0;
    const issues = new Map(this.store.issues().map(issue => [issue.id, issue]));
    const codes = this.codes([...issues.values()]);
    for (const record of [...records].sort((a, b) => a.at - b.at)) {
      // A revert must never act like a merge, even if someone names a merge branch that way.
      if (/^revert\b/i.test(record.subject) || !/^[a-f0-9]{40}$/.test(record.hash)) continue;
      const keys = this.keys(record.branch, codes);
      for (const issue of issues.values()) {
        if (issue.projectId !== project.id) continue;
        if (!keys.includes(issue.key) && issue.branch !== record.branch) continue;
        if (record.at < Math.floor(issue.createdAt / 1000) * 1000 || alreadyLogged(issue, record.hash)) continue;
        // Consume even while closed: replaying an observed second merge after reopen must be inert.
        const closes = isOpenIssue(issue) && record.at >= openSince(issue);
        if (!this.recordMerge(issues, issue, `Merged ${record.hash} from ${record.branch}.`, record.hash, closes)) continue;
        observed++;
        if (closes) changed++;
      }
    }
    if (observed) this.changed();
    return changed;
  }

  githubMerges(prs: readonly MergedIssuePr[]): number {
    let changed = 0, observed = 0;
    const issues = new Map(this.store.issues().map(issue => [issue.id, issue]));
    const codes = this.codes([...issues.values()]);
    for (const pr of prs) {
      const at = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
      if (pr.state.toLowerCase() !== 'merged' || !Number.isFinite(at) || !pr.mergeCommit || !/^[a-f0-9]{40}$/.test(pr.mergeCommit)) continue;
      if (/^revert\b/i.test(pr.title)) continue;
      const keys = [...new Set([...this.keys(pr.branch.toUpperCase(), codes), ...this.closingKeys(pr.title, codes), ...this.closingKeys(pr.body ?? '', codes)])];
      for (const issue of issues.values()) {
        if (!pr.projects.some(p => p.id === issue.projectId)) continue;
        if (!keys.includes(issue.key) && issue.branch !== pr.branch) continue;
        const identity = `${pr.repo}#${pr.number}:${pr.mergeCommit}`;
        if (at < Math.floor(issue.createdAt / 1000) * 1000 || alreadyLogged(issue, identity)) continue;
        const closes = isOpenIssue(issue) && at >= openSince(issue);
        if (!this.recordMerge(issues, issue, `Merged ${pr.repo}#${pr.number} (${pr.mergeCommit}) from ${pr.branch}.`, identity, closes)) continue;
        observed++;
        if (closes) changed++;
      }
    }
    if (observed) this.changed();
    return changed;
  }

  /** Decision citations include full commit messages, not just the graph's short subjects. */
  async indexCommits(project: Project, defaultBranch: string, branches: string[], mentions: RefMentions, git: GitRunner = readGit): Promise<void> {
    const issues = this.store.issues().filter(i => i.projectId === project.id);
    const commits = new Map<string, RefCommit>();
    const read = async (branch: string, args: string[], keys: string[]) => {
      // Both ends are immutable hashes captured together, so a branch/main move invalidates this range.
      const cacheKey = JSON.stringify([project.id, project.path, ...args]);
      let rows = this.commitCache.get(cacheKey);
      if (!rows) {
        const result = await git(['log', '-500', '--format=%H%x1f%ct%x1f%an%x1f%B%x1e', ...args], project.path);
        if (!result.ok) return; // Failed reads are never cached.
        rows = [];
        for (const raw of result.out.split('\x1e')) {
          const [hash, at, author, ...body] = raw.trim().split('\x1f');
          if (!/^[a-f0-9]{40}$/.test(hash ?? '') || !Number.isFinite(Number(at))) continue;
          rows.push({ hash, at: Number(at) * 1000, author, text: body.join('\x1f') });
        }
        this.commitCache.set(cacheKey, rows);
        // Old branch heads do not grow the cache indefinitely.
        if (this.commitCache.size > 128) this.commitCache.delete(this.commitCache.keys().next().value!);
      }
      for (const row of rows) {
        const old = commits.get(row.hash);
        commits.set(row.hash, { ...row, projectId: project.id, branch, issueKeys: [...new Set([...(old?.issueKeys ?? []), ...keys, ...this.keys(row.text)])] });
      }
    };
    // A keyed branch need not be checked out in a worktree (so it may be absent from Work's active list).
    const heads = await git(['for-each-ref', '--format=%(refname:strip=2)%1f%(objectname)', 'refs/heads/'], project.path);
    if (!heads.ok) return;
    const tips = new Map(heads.out.split('\n').flatMap(line => {
      const [name, hash] = line.split('\x1f');
      return name && /^[a-f0-9]{40}$/.test(hash ?? '') ? [[name, hash] as const] : [];
    }));
    const selected = [...new Set([...branches, ...tips.keys(), ...issues.flatMap(i => i.branch ? [i.branch] : [])])];
    for (const branch of selected) {
      const keys = issues.filter(i => i.branch === branch || this.keys(branch).includes(i.key)).map(i => i.key);
      const tip = tips.get(branch), base = tips.get(defaultBranch);
      if (keys.length && tip && base) await read(branch, [tip, '--not', base], keys);
    }
    for (const record of this.records.get(project.id) ?? []) {
      const keys = issues.filter(i => i.branch === record.branch || this.keys(record.branch).includes(i.key)).map(i => i.key);
      if (keys.length && /^[a-f0-9]{40}$/.test(record.tip) && /^[a-f0-9]{40}$/.test(record.parent ?? '')) {
        await read(record.branch, [record.tip, '--not', record.parent!], keys);
      }
    }
    mentions.setCommits(project.id, [...commits.values()]);
  }
}
