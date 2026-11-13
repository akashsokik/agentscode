// Pull requests across the user's projects, as the Pull requests page shows them (ACH-D42,
// ACH-D43). Read only: built from `gh pr list` output by server/githubPrs.ts. The pure parts
// (normalising checks and reviews, the views) live here so they can be tested and shared.

// ---- issue keys --------------------------------------------------------------------------------
// Fen's phase 1 adds shared/issueKeys.ts (his file) with the shared matcher. Until it merges, the
// PR page matches keys here the same way: a project code, a hyphen and digits, so a decision or
// note id (ACH-D7, ACH-N3) is never a key. Swap these for his issueKeysIn once it is on main.

/** A key anywhere in text: not inside a longer word, and never followed by more letters or digits. */
// Fen's ISSUE_KEY (2-5 letter code, 1-6 digits), with guards so "xACH-4" and "ACH-4b" are not keys.
// A leading zero is the same issue (ACH-012 is ACH-12); no issue is number 0.
const KEY = /(?<![A-Za-z0-9])([A-Z]{2,5})-(\d{1,6})(?![A-Za-z0-9])/g;

interface IssueKeyMatch {
  key: string;
  code: string;
  num: number;
  index: number;
}

/**
 * Every issue key in `text`, in order, without repeats. With `codes`, only keys whose project code
 * is one of them (so "UTF-8" or "ISO-9001" in a title is not a key). Branch names write the key
 * the same way (feat/ACH-12-short-title).
 */
export function findIssueKeys(text: string, codes?: Iterable<string>): IssueKeyMatch[] {
  const known = codes ? new Set([...codes].map(c => c.toUpperCase())) : null;
  const seen = new Set<string>();
  const out: IssueKeyMatch[] = [];
  for (const m of String(text ?? '').matchAll(KEY)) {
    const code = m[1];
    if (known && !known.has(code)) continue;
    if (Number(m[2]) === 0) continue;
    const key = `${code}-${Number(m[2])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, code, num: Number(m[2]), index: m.index ?? 0 });
  }
  return out;
}

/** The first key in the first of `texts` that has one: a branch name wins over a title, a title over a body. */
export function firstIssueKey(texts: (string | undefined)[], codes?: Iterable<string>): string | null {
  for (const text of texts) {
    const found = findIssueKeys(text ?? '', codes);
    if (found.length) return found[0].key;
  }
  return null;
}


/** Whether a link from GitHub data may be used as an href: http and https only. */
export function isHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

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

// ---- how often the page's data is read (web/prs/prsData.ts) ----------------------------------------

/** With the Pull requests page open: every 5 minutes. With only the sidebar's count: every 30. */
export const PAGE_POLL_MS = 5 * 60_000;
export const COUNT_POLL_MS = 30 * 60_000;
/** How often the data should be read now, or null when nothing shows it. */
export function pollInterval(pages: number, counts: number): number | null {
  if (pages > 0) return PAGE_POLL_MS;
  return counts > 0 ? COUNT_POLL_MS : null;
}
/** Whether data read at `fetchedAt` is due again. */
export function isDue(fetchedAt: number | undefined, interval: number | null, now = Date.now()): boolean {
  return interval !== null && (fetchedAt === undefined || now - fetchedAt >= interval);
}
