// The issue view's "In git" and "Decisions" sections read through this small interface. Hal's
// server/issueLinks.ts (feat/issue-links, ACH-D41 section 6) will feed it: the branch named from
// the key, the commits that cite it, what closes it, and the decisions cited in its handoffs,
// reports and commits. Until that lands, the local source finds what the app already knows: the
// decisions the issue's own text and comments cite. Swapping sources changes nothing in the view.
import { findRefIds } from '../../../shared/refs.ts';
import type { SuperIssue } from '../../../shared/types.ts';

export interface IssueGitLinks {
  /** The issue's branch, named from its key (feat/ACH-12-short-title). */
  branch?: { name: string; project?: string };
  /** Commits that cite the key, newest first. */
  commits: { sha: string; subject: string }[];
  /** What will close it: its branch merging into main, or its PR merging on GitHub. */
  closes?: string;
}

export interface IssueLinks {
  git: IssueGitLinks;
  /** Decision ids cited about the issue (ACH-D41, ALL-D9), first-cited first. */
  decisions: string[];
  /** Where these came from: 'local' (the issue's own text) until the server's links land. */
  source: 'local' | 'server';
}

export type IssueLinksSource = (issue: Pick<SuperIssue, 'id' | 'key' | 'text' | 'notes' | 'activity'>) => Promise<IssueLinks>;

/** Decision ids (not notes) cited in the issue's text, notes and comments, each once, first-cited first. */
export function citedDecisions(issue: Pick<SuperIssue, 'text' | 'notes' | 'activity'>): string[] {
  const texts = [issue.text, issue.notes ?? '', ...(issue.activity ?? []).filter(e => e.kind === 'comment').map(e => e.text ?? '')];
  const out: string[] = [];
  for (const text of texts) {
    for (const match of findRefIds(text, () => true)) if (/-D\d+$/.test(match.id) && !out.includes(match.id)) out.push(match.id);
  }
  return out;
}

/** What the app knows today, without the server's git links. */
export const localIssueLinks: IssueLinksSource = async issue => ({ git: { commits: [] }, decisions: citedDecisions(issue), source: 'local' });

/** Hal's GET /api/issues/:issueId/decisions (feat/issue-links), as planned. */
export interface IssueDecisionsResponse {
  issueId: string;
  key: string;
  decisions: {
    id: string;
    citations: ({ source: 'commit'; hash: string; subject?: string; projectId?: string; branch?: string; who?: string; ts?: number } | { source: 'message' | 'chat' | 'channel'; [k: string]: unknown })[];
  }[];
}

/**
 * The view's links from the server's answer: its decisions first (then any only the issue's own
 * text cites), the commits that cite them newest first, each once, and the branch most of them
 * are on. Git links that cite no decision come with Hal's next route; none are made up here.
 */
export function fromServerDecisions(issue: Parameters<IssueLinksSource>[0], response: IssueDecisionsResponse): IssueLinks {
  const decisions = response.decisions.map(d => d.id);
  for (const id of citedDecisions(issue)) if (!decisions.includes(id)) decisions.push(id);
  const commits = new Map<string, { sha: string; subject: string; branch?: string; projectId?: string; ts: number }>();
  for (const d of response.decisions) {
    for (const c of d.citations) {
      if (c.source !== 'commit' || typeof c.hash !== 'string' || commits.has(c.hash)) continue;
      const commit = c as Extract<IssueDecisionsResponse['decisions'][number]['citations'][number], { source: 'commit' }>;
      commits.set(commit.hash, { sha: commit.hash, subject: commit.subject ?? '', branch: commit.branch, projectId: commit.projectId, ts: commit.ts ?? 0 });
    }
  }
  const list = [...commits.values()].sort((a, b) => b.ts - a.ts);
  const counts = new Map<string, number>();
  for (const c of list) if (c.branch) counts.set(c.branch, (counts.get(c.branch) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const project = top ? list.find(c => c.branch === top[0])?.projectId : undefined;
  return {
    git: { ...(top ? { branch: { name: top[0], ...(project ? { project } : {}) } } : {}), commits: list.map(c => ({ sha: c.sha, subject: c.subject })) },
    decisions,
    source: 'server',
  };
}

/** The server's links when its route answers; the local ones when it does not (not landed, offline). */
export const serverIssueLinks: IssueLinksSource = async issue => {
  try {
    const response = await fetch(`/api/issues/${encodeURIComponent(issue.id)}/decisions`);
    if (!response.ok) return localIssueLinks(issue);
    return fromServerDecisions(issue, await response.json() as IssueDecisionsResponse);
  } catch {
    return localIssueLinks(issue);
  }
};

let source: IssueLinksSource = typeof (globalThis as { document?: unknown }).document === 'undefined' ? localIssueLinks : serverIssueLinks;

/** The source the view uses; Hal's API is wired here when it lands. */
export function issueLinksSource(): IssueLinksSource {
  return source;
}

/** For tests, and for wiring the server source in one place. */
export function setIssueLinksSource(next: IssueLinksSource): void {
  source = next;
}
