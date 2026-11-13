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

let source: IssueLinksSource = localIssueLinks;

/** The source the view uses; Hal's API is wired here when it lands. */
export function issueLinksSource(): IssueLinksSource {
  return source;
}

/** For tests, and for wiring the server source in one place. */
export function setIssueLinksSource(next: IssueLinksSource): void {
  source = next;
}
