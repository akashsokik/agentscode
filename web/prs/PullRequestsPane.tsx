import { useMemo, useState, type ReactNode } from 'react';
import { checksLabel, isHttpUrl, isOpen, PR_VIEWS, prsInView, viewCounts, type PrCheck, type PrReview, type PrView, type PullRequest } from '../../shared/prs.ts';
import { relativeTime } from '../format.ts';
import { open } from '../layout.ts';
import { Check, ExternalLink, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, LoaderCircle, Minus, RefreshCw, X } from '../mono/icons.tsx';
import { WhoAvatar } from '../notes/parts.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { cx, Empty, HeaderButton, Loading, StatusLabel, type Tone } from '../ui/common.tsx';
import { KeyValueList } from '../ui/KeyValueList.tsx';
import { PanelList, PanelRow, PanelSection, PanelToolbar } from '../ui/PanelList.tsx';
import { useNow } from '../ui/useNow.ts';
import { loadPrs, usePrs, usePrsData } from './prsData.ts';

// The Pull requests page (ACH-D42, ACH-D43): open and recently merged PRs across the user's
// projects, read only. Built from the same pieces as Comms and the panel lists: PaneFrame, the panel
// toolbar's search and views, PanelSection and PanelRow, StatusLabel, and the Notes detail layout.

/** How long a merged PR stays under "Merged recently" in the Open view. */
const RECENT_MS = 7 * 24 * 3600_000;

const STATE_ICON = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;
const STATE_TONE: Record<PullRequest['state'], string> = { open: 'text-success', draft: 'text-content/45', merged: 'text-info', closed: 'text-danger' };
const STATE_WORD: Record<PullRequest['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const CHECK_TONE: Record<ReturnType<typeof checksLabel>['tone'], Tone> = { success: 'success', danger: 'danger', pending: 'neutral', muted: 'muted' };

function StateIcon({ pr, className = 'size-3.5' }: { pr: PullRequest; className?: string }) {
  const Icon = STATE_ICON[pr.state];
  return <Icon aria-hidden className={cx(className, 'shrink-0', STATE_TONE[pr.state])} strokeWidth={1.75} />;
}

/** The project a PR belongs to, as its short code (ACH), or the repo's name. */
function projectLabel(pr: PullRequest): string {
  return pr.projects[0]?.code ?? pr.projects[0]?.name ?? pr.repo.split('/')[1] ?? pr.repo;
}

function matches(pr: PullRequest, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [pr.title, pr.branch, pr.author, `#${pr.number}`, pr.repo, pr.issueKey ?? '', ...pr.projects.map(p => `${p.name} ${p.code ?? ''}`)]
    .some(text => text.toLowerCase().includes(q));
}

export function PullRequestsPane({ prId, chrome }: { prId?: string; chrome: PaneChrome }) {
  usePrsData(true);
  const data = usePrs(s => s.data);
  const error = usePrs(s => s.error);
  const loading = usePrs(s => s.loading);
  const now = useNow();
  const [view, setView] = useState<PrView>('open');
  const [query, setQuery] = useState('');

  const all = useMemo(() => (data?.pullRequests ?? []).filter(pr => matches(pr, query)), [data, query]);
  const counts = viewCounts(all);
  const shown = prsInView(all, view);
  // The Open view also lists what merged in the last week, as the demo does.
  const recent = view === 'open' ? prsInView(all, 'merged').filter(pr => now - Date.parse(pr.mergedAt ?? pr.updatedAt) < RECENT_MS) : [];
  const selected = all.find(pr => pr.id === prId) ?? shown[0] ?? recent[0];

  const title = (
    <span className="flex items-center gap-2">
      <GitPullRequest className="size-3.5 text-content/55" strokeWidth={1.75} />
      <span className="text-content">Pull requests</span>
      {data ? <span className="font-normal text-content/45">{counts.open} open</span> : null}
    </span>
  );
  const actions = <HeaderButton icon={RefreshCw} label="Refresh pull requests" disabled={loading} onClick={() => void loadPrs(true)} />;

  if (!data) {
    return (
      <PaneFrame chrome={chrome} title={title} actions={actions}>
        {error ? <Empty icon={GitPullRequest} title="Pull requests could not be loaded">{error}</Empty> : <Loading />}
      </PaneFrame>
    );
  }
  if (data.error) {
    return (
      <PaneFrame chrome={chrome} title={title} actions={actions}>
        <Empty icon={GitPullRequest} title="GitHub could not be read">{data.error}</Empty>
      </PaneFrame>
    );
  }

  const row = (pr: PullRequest) => <PrRow key={pr.id} pr={pr} now={now} selected={selected?.id === pr.id} />;
  return (
    <PaneFrame chrome={chrome} title={title} actions={actions}>
      <div className="@container/prs flex min-h-0 flex-1">
        <div className={cx('flex min-w-0 flex-1 flex-col', prId && '@max-[44rem]/prs:hidden')}>
          <PanelToolbar
            query={query}
            onQuery={setQuery}
            searchLabel="Search pull requests"
            filter={{ label: 'Show', value: view, onChange: setView, options: PR_VIEWS.map(v => ({ value: v.view, label: v.label, count: counts[v.view] })) }}
          />
          <PanelList label="Pull requests">
            {shown.length || recent.length ? (
              <>
                {shown.length ? <PanelSection label={PR_VIEWS.find(v => v.view === view)!.label} count={shown.length} /> : null}
                {shown.map(row)}
                {recent.length ? <PanelSection label="Merged recently" count={recent.length} /> : null}
                {recent.map(row)}
              </>
            ) : (
              <p className="px-1.5 py-3 font-sans text-[12px] text-content/50">{query.trim() ? 'No pull requests match.' : EMPTY[view]}</p>
            )}
            {data.skipped.length ? (
              <p className="px-1.5 pt-4 font-sans text-[11px] leading-relaxed text-content/40">
                Not shown: {data.skipped.map(s => `${s.project} (${s.reason.replace(/\.$/, '').toLowerCase()})`).join(', ')}.
              </p>
            ) : null}
          </PanelList>
        </div>
        {selected ? (
          <div className={cx('min-w-0 shrink-0 overflow-y-auto overscroll-contain border-stroke @min-[44rem]/prs:w-[min(24rem,40%)] @min-[44rem]/prs:border-l', prId ? 'flex-1 @min-[44rem]/prs:flex-none' : '@max-[44rem]/prs:hidden')}>
            <PrDetail key={selected.id} pr={selected} now={now} />
          </div>
        ) : null}
      </div>
    </PaneFrame>
  );
}

const EMPTY: Record<PrView, string> = {
  open: 'No open pull requests in your projects.',
  needsReview: 'Nothing is waiting on a review.',
  checksFailing: 'No open pull request has failing checks.',
  merged: 'Nothing merged recently.',
};

/** One PR on one line: state, project and number, title, then issue key, branch, checks, author and when. */
function PrRow({ pr, now, selected }: { pr: PullRequest; now: number; selected: boolean }) {
  const checks = checksLabel(pr.checksSummary);
  const when = Date.parse(pr.state === 'merged' ? pr.mergedAt ?? pr.updatedAt : pr.updatedAt);
  return (
    <PanelRow
      id={pr.id}
      selected={selected}
      lead={<StateIcon pr={pr} />}
      label={`${STATE_WORD[pr.state]} pull request ${projectLabel(pr)} #${pr.number}: ${pr.title}. ${checks.text}. By ${pr.author}.`}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-content/45">{projectLabel(pr)}</span>
          <span className="shrink-0 tabular-nums text-content/45">#{pr.number}</span>
          <span className="truncate">{pr.title}</span>
        </span>
      )}
      meta={(
        <>
          {pr.issueKey ? <span className="hidden font-mono text-[var(--link-color)] @min-[36rem]/prs:inline">{pr.issueKey}</span> : null}
          <span className="hidden max-w-[9rem] truncate font-mono text-content/40 @min-[60rem]/prs:inline" title={pr.branch}>{pr.branch}</span>
          <StatusLabel tone={CHECK_TONE[checks.tone]} busy={checks.tone === 'pending'}>{checks.text}</StatusLabel>
          <WhoAvatar name={pr.author} agentId={pr.agentId} />
          <span className="w-7 text-right">{relativeTime(when, now)}</span>
        </>
      )}
      onOpen={() => open({ kind: 'pullRequests', prId: pr.id })}
    />
  );
}

const CHECK_ICON: Record<PrCheck['state'], { icon: typeof Check; className: string }> = {
  success: { icon: Check, className: 'text-success' },
  failure: { icon: X, className: 'text-danger' },
  pending: { icon: LoaderCircle, className: 'text-content/45 animate-spin' },
  skipped: { icon: Minus, className: 'text-content/35' },
  neutral: { icon: Minus, className: 'text-content/45' },
};
const REVIEW_WORD: Record<PrReview['state'], { word: string; tone: Tone }> = {
  approved: { word: 'Approved', tone: 'success' },
  changes_requested: { word: 'Changes requested', tone: 'warning' },
  commented: { word: 'Commented', tone: 'neutral' },
  dismissed: { word: 'Dismissed', tone: 'muted' },
  pending: { word: 'Pending', tone: 'muted' },
};

function reviewSummary(pr: PullRequest): string {
  const approved = pr.reviews.filter(r => r.state === 'approved').map(r => r.author);
  if (pr.reviewDecision === 'changes_requested') return 'Changes requested';
  if (approved.length) return `${approved.join(', ')} approved`;
  if (pr.reviewDecision === 'review_required') return 'Review required';
  return pr.reviews.length ? 'Commented' : 'No reviews';
}

/** The selected PR: where it is, who and which branch, its review, linked issue, checks and reviews. */
function PrDetail({ pr, now }: { pr: PullRequest; now: number }) {
  const checks = checksLabel(pr.checksSummary);
  const rows: [string, ReactNode][] = [
    ['State', <><StateIcon pr={pr} /><span>{STATE_WORD[pr.state]}</span>{pr.mergedAt ? <span className="text-content/45">{relativeTime(Date.parse(pr.mergedAt), now)}</span> : null}</>],
    ['Author', <><WhoAvatar name={pr.author} agentId={pr.agentId} /><span className="truncate">{pr.author}</span></>],
    ['Branch', <><GitBranch aria-hidden className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} /><span className="truncate font-mono text-[11.5px]" title={pr.branch}>{pr.branch}</span></>],
    ['Review', <span className="truncate">{reviewSummary(pr)}</span>],
    ['Linked issue', pr.issueKey ? <span className="font-mono text-[var(--link-color)]">{pr.issueKey}</span> : <span className="text-content/35">None</span>],
    ['Updated', <span>{relativeTime(Date.parse(pr.updatedAt), now)}</span>],
  ];
  return (
    <div className="px-4 pb-6 pt-3.5 font-sans">
      <div className="flex items-center gap-1.5 text-[12px] text-content/45">
        <span className="truncate">{pr.repo}</span>
        <span aria-hidden>›</span>
        <span className="tabular-nums">#{pr.number}</span>
        {isHttpUrl(pr.url) ? <a href={pr.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" title="Open on GitHub" className="ml-auto grid size-6 shrink-0 place-items-center rounded-md hover:bg-content/10 hover:text-content">
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </a> : null}
      </div>
      <h3 className="mt-1.5 text-[14px] font-semibold leading-snug text-content">{pr.title}</h3>
      <div className="mt-3"><KeyValueList rows={rows} /></div>
      {pr.issueKey ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-content/45">Found by the key in the {pr.branch.includes(pr.issueKey) ? 'branch name' : 'title or description'}.</p>
      ) : null}

      <div className="mt-4 flex items-center justify-between text-[12px]">
        <span className="font-medium text-content/70">Checks</span>
        <StatusLabel tone={CHECK_TONE[checks.tone]} busy={checks.tone === 'pending'}>{checks.text}</StatusLabel>
      </div>
      {pr.checks.length ? (
        <ul className="mt-1 flex flex-col text-[12px]">
          {pr.checks.map((c, i) => {
            const { icon: Icon, className } = CHECK_ICON[c.state];
            const body = (
              <>
                <Icon aria-hidden className={cx('size-3.5 shrink-0', className)} strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate text-content/85">{c.name}</span>
                <span className="shrink-0 text-[11px] text-content/40">{c.state}</span>
              </>
            );
            return (
              <li key={`${c.name}-${i}`}>
                {isHttpUrl(c.url)
                  ? <a href={c.url} target="_blank" rel="noreferrer" className="flex h-7 items-center gap-2 rounded-md px-1 hover:bg-content/5">{body}</a>
                  : <span className="flex h-7 items-center gap-2 px-1">{body}</span>}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="mt-4 text-[12px] font-medium text-content/70">Reviews</div>
      {pr.reviews.length ? (
        <ul className="mt-1 flex flex-col text-[12px]">
          {pr.reviews.map(r => (
            <li key={r.author} className="flex h-7 items-center gap-2 px-1">
              <WhoAvatar name={r.author} />
              <span className="min-w-0 flex-1 truncate text-content/85">{r.author}</span>
              <StatusLabel tone={REVIEW_WORD[r.state].tone}>{REVIEW_WORD[r.state].word}</StatusLabel>
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 px-1 text-[12px] text-content/40">No reviews yet.</p>}

      <p className="mt-5 text-[11.5px] leading-relaxed text-content/45">
        Read only, through the gh commands the SuperAgent already uses. Merging stays a decision for you{isOpen(pr) ? ', on GitHub' : ''}.
      </p>
    </div>
  );
}
