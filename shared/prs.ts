// Pull requests across the user's projects, as the Pull requests page shows them (ACH-D42,
// ACH-D43). Read only: built from `gh pr list` output by server/githubPrs.ts. The pure parts
// (normalising checks and reviews, the views) live here so they can be tested and shared.
import { firstIssueKey } from './issueKeys.ts';

export type PrState = 'open' | 'draft' | 'merged' | 'closed';
export type CheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral';
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null;

export interface PrCheck { name: string; state: CheckState; url?: string; workflow?: string }
export interface PrReview { author: string; state: ReviewState; at?: string }

export interface PullRequest {
  /** "owner/name#57", unique across projects. */
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
  author: string;
  authorIsBot: boolean;
  /** The PodCode agent that worked on the branch (its worktree branch, or agent/<name>), if any. */
  agentId?: string;
  branch: string;
  updatedAt: string;
  mergedAt?: string;
  checks: PrCheck[];
  checksSummary: { total: number; passed: number; failed: number; pending: number };
  reviews: PrReview[];
  reviewDecision: ReviewDecision;
  /** The issue key the branch, title or body names (ACH-12), if any. */
  issueKey?: string;
  /** The projects (code and name) whose remote is this repo. */
  projects: { id: string; name: string; code?: string }[];
}

export interface PrPageData {
  pullRequests: PullRequest[];
  /** Projects not on GitHub, or whose PRs could not be read, and why. */
  skipped: { project: string; reason: string }[];
  /** gh itself is missing or not logged in: nothing could be read. */
  error?: string;
  fetchedAt: number;
}

export type PrView = 'open' | 'needsReview' | 'checksFailing' | 'merged';
export const PR_VIEWS: { view: PrView; label: string }[] = [
  { view: 'open', label: 'Open' },
  { view: 'needsReview', label: 'Needs review' },
  { view: 'checksFailing', label: 'Checks failing' },
  { view: 'merged', label: 'Merged' },
];

export function isOpen(pr: Pick<PullRequest, 'state'>): boolean {
  return pr.state === 'open' || pr.state === 'draft';
}

/** Whether a PR belongs in a view. Needs review: open, not a draft, and waiting on a review. */
export function inView(pr: PullRequest, view: PrView): boolean {
  switch (view) {
    case 'open': return isOpen(pr);
    case 'needsReview': return pr.state === 'open' && (pr.reviewDecision === 'review_required' || pr.reviewDecision === 'changes_requested');
    case 'checksFailing': return isOpen(pr) && pr.checksSummary.failed > 0;
    case 'merged': return pr.state === 'merged';
  }
}

/** Newest first; within a view, the order the page lists. */
export function prsInView(prs: PullRequest[], view: PrView): PullRequest[] {
  const key = (p: PullRequest) => (view === 'merged' ? p.mergedAt ?? p.updatedAt : p.updatedAt);
  return prs.filter(p => inView(p, view)).sort((a, b) => key(b).localeCompare(key(a)));
}

export function viewCounts(prs: PullRequest[]): Record<PrView, number> {
  return Object.fromEntries(PR_VIEWS.map(({ view }) => [view, prs.filter(p => inView(p, view)).length])) as Record<PrView, number>;
}

// ---- normalising gh's JSON ---------------------------------------------------------------------

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One entry of statusCheckRollup: a CheckRun (status and conclusion) or a StatusContext (state). */
export function normalizeCheck(raw: Raw): PrCheck {
  const name = str(raw.name) || str(raw.context) || 'check';
  const url = str(raw.detailsUrl) || str(raw.targetUrl) || undefined;
  const workflow = str(raw.workflowName) || undefined;
  let state: CheckState;
  if (raw.__typename === 'StatusContext' || (raw.state !== undefined && raw.conclusion === undefined)) {
    const s = str(raw.state).toUpperCase();
    state = s === 'SUCCESS' ? 'success' : s === 'FAILURE' || s === 'ERROR' ? 'failure' : 'pending';
  } else if (str(raw.status).toUpperCase() !== 'COMPLETED') {
    state = 'pending';
  } else {
    const c = str(raw.conclusion).toUpperCase();
    state = c === 'SUCCESS' ? 'success'
      : c === 'SKIPPED' ? 'skipped'
        : c === 'NEUTRAL' ? 'neutral'
          : c === 'FAILURE' || c === 'TIMED_OUT' || c === 'CANCELLED' || c === 'ACTION_REQUIRED' || c === 'STARTUP_FAILURE' || c === 'STALE' ? 'failure'
            : 'pending';
  }
  return { name, state, ...(url ? { url } : {}), ...(workflow ? { workflow } : {}) };
}

export function summarizeChecks(checks: PrCheck[]): PullRequest['checksSummary'] {
  return {
    total: checks.length,
    passed: checks.filter(c => c.state === 'success').length,
    failed: checks.filter(c => c.state === 'failure').length,
    pending: checks.filter(c => c.state === 'pending').length,
  };
}

/** Each reviewer's latest review that says something (a plain comment does not replace a verdict). */
export function latestReviews(raw: Raw[]): PrReview[] {
  const byAuthor = new Map<string, PrReview>();
  for (const r of raw) {
    const author = str((r.author as Raw | undefined)?.login) || 'someone';
    const s = str(r.state).toUpperCase();
    const state: ReviewState = s === 'APPROVED' ? 'approved' : s === 'CHANGES_REQUESTED' ? 'changes_requested' : s === 'DISMISSED' ? 'dismissed' : s === 'PENDING' ? 'pending' : 'commented';
    const at = str(r.submittedAt) || undefined;
    const prev = byAuthor.get(author);
    if (prev && state === 'commented' && prev.state !== 'commented') continue;
    byAuthor.set(author, { author, state, ...(at ? { at } : {}) });
  }
  return [...byAuthor.values()];
}

function decision(raw: unknown): ReviewDecision {
  const d = str(raw).toUpperCase();
  return d === 'APPROVED' ? 'approved' : d === 'CHANGES_REQUESTED' ? 'changes_requested' : d === 'REVIEW_REQUIRED' ? 'review_required' : null;
}

/**
 * One entry of `gh pr list --json ...` as the page shows it. `codes` are the project codes a key
 * may name; `agentFor` finds the PodCode agent that worked on a branch.
 */
export function normalizePr(raw: Raw, repo: string, opts: { codes?: Iterable<string>; agentFor?: (branch: string) => string | undefined } = {}): PullRequest {
  const number = Number(raw.number);
  const author = raw.author as Raw | undefined;
  const ghState = str(raw.state).toUpperCase();
  const state: PrState = ghState === 'MERGED' ? 'merged' : ghState === 'CLOSED' ? 'closed' : raw.isDraft ? 'draft' : 'open';
  const checks = (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup as Raw[] : []).map(normalizeCheck);
  const branch = str(raw.headRefName);
  const title = str(raw.title);
  const issueKey = firstIssueKey([branch, title, str(raw.body)], opts.codes) ?? undefined;
  const agentId = branch ? opts.agentFor?.(branch) : undefined;
  return {
    id: `${repo}#${number}`, repo, number, title, url: str(raw.url), state,
    // GitHub Apps come as "app/dependabot": the app's name is what a person reads.
    author: str(author?.login).replace(/^app\//, '') || 'unknown',
    authorIsBot: Boolean(author?.is_bot) || /^app\/|\[bot\]$|^dependabot/.test(str(author?.login)),
    ...(agentId ? { agentId } : {}),
    branch, updatedAt: str(raw.updatedAt), ...(str(raw.mergedAt) ? { mergedAt: str(raw.mergedAt) } : {}),
    checks, checksSummary: summarizeChecks(checks),
    reviews: latestReviews(Array.isArray(raw.reviews) ? raw.reviews as Raw[] : []),
    reviewDecision: decision(raw.reviewDecision),
    ...(issueKey ? { issueKey } : {}),
    projects: [],
  };
}

/** "3 passed", "2 of 4 failing", "1 running", "No checks": the row's checks column. */
export function checksLabel(s: PullRequest['checksSummary']): { text: string; tone: 'success' | 'danger' | 'pending' | 'muted' } {
  if (!s.total) return { text: 'No checks', tone: 'muted' };
  if (s.failed) return { text: `${s.failed} of ${s.total} failing`, tone: 'danger' };
  if (s.pending) return { text: `${s.pending} running`, tone: 'pending' };
  return { text: `${s.passed} passed`, tone: 'success' };
}
