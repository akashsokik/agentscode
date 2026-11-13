import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { checksLabel, isHttpUrl, isOpen, PR_VIEWS, prsInView, viewCounts, type PrCheck, type PrDetail, type PrReview, type PrView, type PullRequest } from '../../shared/prs.ts';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { open } from '../layout.ts';
import { Copy, ExternalLink, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, RefreshCw } from '../mono/icons.tsx';
import { WhoAvatar } from '../notes/parts.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { ChipButton, cx, Empty, HeaderButton, Loading } from '../ui/common.tsx';
import { ACTION_GHOST, ACTION_OUTLINE, InboxBar, InboxCard, InboxDetail, InboxFilterTabs, InboxGroup, InboxHero, InboxLayout, InboxList, InboxSearch, InboxSection, InboxTabs, TimelineStop } from '../ui/Inbox.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { StatusMark, StatusText, statusWord, type StatusState } from '../ui/StatusMark.tsx';
import { useNow } from '../ui/useNow.ts';
import { loadPrs, usePrs, usePrsData } from './prsData.ts';

// The Pull requests page (ACH-D42, ACH-D43): open and recently merged PRs across the user's
// projects, read only. Laid out like Comms and MonoCode's Inbox (ACH-D52, ACH-D54), on the shared
// web/ui/Inbox.tsx: the list rail on the left, the selected PR on the right with its header,
// actions, Summary / Code / Checks tabs, and its commits as the activity timeline.

/** How long a merged PR stays under "Merged recently" in the Open view. */
const RECENT_MS = 7 * 24 * 3600_000;

const STATE_ICON = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;
const STATE_TONE: Record<PullRequest['state'], string> = { open: 'text-success', draft: 'text-content/45', merged: 'text-info', closed: 'text-danger' };
const STATE_WORD: Record<PullRequest['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
/** A checks summary's mark: passed, failing, running, or none at all (a dashed circle, as MonoCode's skipped). */
const SUMMARY_STATE: Record<ReturnType<typeof checksLabel>['tone'], StatusState> = { success: 'pass', danger: 'fail', pending: 'pending', muted: 'skip' };

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
  // The detail's tab stays as you move between PRs, as in MonoCode's inbox.
  const [tab, setTab] = useState<PrTab>('summary');
  // Bumped by Refresh, so the PR on screen reads its files and commits again too.
  const [fresh, setFresh] = useState(0);
  const refresh = () => { setFresh(n => n + 1); void loadPrs(true); };

  const all = useMemo(() => (data?.pullRequests ?? []).filter(pr => matches(pr, query)), [data, query]);
  const counts = viewCounts(all);
  const shown = prsInView(all, view);
  // The Open view also lists what merged in the last week, as the demo does.
  const recent = view === 'open' ? prsInView(all, 'merged').filter(pr => now - Date.parse(pr.mergedAt ?? pr.updatedAt) < RECENT_MS) : [];
  // A PR picked on purpose stays open while you search, as a conversation does in Comms; only
  // with none picked does the detail follow the first one shown.
  const selected = (data?.pullRequests ?? []).find(pr => pr.id === prId) ?? shown[0] ?? recent[0];

  const title = (
    <span className="flex items-center gap-2">
      <GitPullRequest className="size-3.5 text-content/55" strokeWidth={1.75} />
      <span className="text-content">Pull requests</span>
      {data ? <span className="font-normal text-content/45">{counts.open} open</span> : null}
      {data ? <span title={new Date(data.fetchedAt).toLocaleString()} className="font-normal text-content/35">· {loading ? 'updating…' : `updated ${ago(data.fetchedAt, now)}`}</span> : null}
    </span>
  );
  // Spins while a read runs (still, under reduced motion).
  const actions = <HeaderButton icon={RefreshCw} label={loading ? 'Refreshing pull requests' : 'Refresh pull requests'} disabled={loading} onClick={refresh} className={loading ? '[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none' : ''} />;
  const retry = <ChipButton onClick={refresh} disabled={loading}>{loading ? 'Trying…' : 'Try again'}</ChipButton>;

  if (!data) {
    return (
      <PaneFrame chrome={chrome} title={title} actions={actions}>
        {error ? <Empty icon={GitPullRequest} title="Pull requests could not be loaded" action={retry}>{error}</Empty> : <Loading />}
      </PaneFrame>
    );
  }
  if (data.error) {
    return (
      <PaneFrame chrome={chrome} title={title} actions={actions}>
        <Empty icon={GitPullRequest} title="GitHub could not be read" action={retry}>{data.error}</Empty>
      </PaneFrame>
    );
  }

  const card = (pr: PullRequest) => <li key={pr.id}><PrCard pr={pr} now={now} active={selected?.id === pr.id} /></li>;
  const listed = [...shown, ...recent];
  const move = (step: -1 | 1) => {
    const at = listed.findIndex(pr => pr.id === selected?.id);
    const next = listed[Math.max(0, Math.min(listed.length - 1, at + step))];
    if (next) open({ kind: 'pullRequests', prId: next.id });
    return next?.id;
  };
  // J and K walk the list from anywhere in the rail, as the arrows do in the list; never while typing.
  const onRailKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'j' && e.key !== 'k')) return;
    if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    const id = move(e.key === 'j' ? 1 : -1);
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`)?.focus());
  };
  // Escape in the detail goes back to the selected card (and to the list, when only one side shows).
  const onDetailKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !selected) return;
    const card = document.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(selected.id)}"]`);
    e.preventDefault();
    if (!card?.offsetParent) open({ kind: 'pullRequests' });
    focusCard(selected.id);
  };
  return (
    <PaneFrame chrome={chrome} title={title} actions={actions}>
      <InboxLayout
        // Narrow: show the detail only for the PR picked; one that is gone since (refresh, search) shows the list.
        detailOpen={Boolean(prId) && selected?.id === prId}
        onRailKeyDown={onRailKey}
        toolbar={<>
          <InboxFilterTabs options={PR_VIEWS.map(v => ({ value: v.view, label: TAB_LABEL[v.view], count: v.view === 'needsReview' || v.view === 'checksFailing' ? counts[v.view] : undefined, attention: v.view === 'checksFailing' }))} value={view} onChange={setView} fit />
          <InboxSearch value={query} onChange={setQuery} placeholder="Filter pull requests" />
          {/* A failed refresh keeps what was read before, and says so where it is seen. */}
          {error ? (
            <p role="status" className="flex shrink-0 items-center gap-2 border-b border-stroke px-3 py-2 font-sans text-[11.5px] leading-snug text-warning">
              <span className="min-w-0 flex-1">Could not refresh ({error}). Showing what was read {ago(data.fetchedAt, now)}.</span>
              <ChipButton onClick={refresh} disabled={loading}>{loading ? 'Trying…' : 'Try again'}</ChipButton>
            </p>
          ) : null}
        </>}
        list={
          <InboxList
            label="Pull requests"
            onMove={move}
            activeId={selected?.id}
            empty={listed.length ? undefined : query.trim() ? 'No pull requests match.' : EMPTY[view]}
            footer={data.skipped.length ? `Not shown: ${data.skipped.map(s => `${s.project} (${s.reason.replace(/\.$/, '').toLowerCase()})`).join(', ')}.` : undefined}
          >
            {shown.map(card)}
            {recent.length ? <InboxGroup label="Merged recently" count={recent.length} /> : null}
            {recent.map(card)}
          </InboxList>
        }
        detail={selected ? <PrInboxDetail key={selected.id} pr={selected} now={now} tab={tab} onTab={setTab} fresh={fresh} onKeyDown={onDetailKey} /> : null}
      />
    </PaneFrame>
  );
}

/** The rail's tabs, short enough for its width; the views' full names are in PR_VIEWS. */
const TAB_LABEL: Record<PrView, string> = { open: 'Open', needsReview: 'Review', checksFailing: 'Failing', merged: 'Merged' };

const EMPTY: Record<PrView, string> = {
  open: 'No open pull requests in your projects.',
  needsReview: 'Nothing is waiting on a review.',
  checksFailing: 'No open pull request has failing checks.',
  merged: 'Nothing merged recently.',
};

/** A PR as an InboxCard: its project and number and when, the title, then checks, linked issue and author. */
function PrCard({ pr, now, active }: { pr: PullRequest; now: number; active: boolean }) {
  const checks = checksLabel(pr.checksSummary);
  const when = Date.parse(pr.state === 'merged' ? pr.mergedAt ?? pr.updatedAt : pr.updatedAt);
  return (
    <InboxCard
      id={pr.id}
      active={active}
      onSelect={() => open({ kind: 'pullRequests', prId: pr.id })}
      label={`${STATE_WORD[pr.state]} pull request ${projectLabel(pr)} #${pr.number}: ${pr.title}. ${checks.text}. By ${pr.author}.`}
      title={pr.title}
      top={<>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-content/55">
          <StateIcon pr={pr} className="size-3.5" />
          <span className="shrink-0 font-mono">{projectLabel(pr)}</span>
          <span className="shrink-0 tabular-nums">#{pr.number}</span>
          <span className="min-w-0 truncate text-content/40">{pr.repo}</span>
        </span>
        <time dateTime={new Date(when).toISOString()} title={new Date(when).toLocaleString()} className="shrink-0 text-[11px] tabular-nums text-content/45">{relativeTime(when, now)}</time>
      </>}
      meta={<>
        <StatusText state={SUMMARY_STATE[checks.tone]} quiet={checks.tone === 'muted'}>{checks.text}</StatusText>
        {pr.issueKey ? <><span aria-hidden>·</span><span className="shrink-0 font-mono text-[var(--link-color)]">{pr.issueKey}</span></> : null}
        <span aria-hidden>·</span>
        <span className="flex min-w-0 items-center gap-1"><WhoAvatar name={pr.author} agentId={pr.agentId} className="size-3.5" /><span className="truncate">{pr.author}</span></span>
      </>}
    />
  );
}

/** A check's state as the shared mark (MonoCode: neutral and skipped are both "skipping"). */
const CHECK_STATE: Record<PrCheck['state'], StatusState> = { failure: 'fail', pending: 'pending', success: 'pass', skipped: 'skip', neutral: 'skip' };
/** MonoCode's order (CHECK_STATES): failures first, then running, then passed, then skipped. Only states CHECK_STATE gives. */
const CHECK_ORDER: StatusState[] = ['fail', 'pending', 'pass', 'skip'];
const REVIEW: Record<PrReview['state'], { word: string; state: StatusState }> = {
  approved: { word: 'Approved', state: 'pass' },
  changes_requested: { word: 'Changes requested', state: 'warn' },
  commented: { word: 'Commented', state: 'skip' },
  dismissed: { word: 'Dismissed', state: 'cancel' },
  pending: { word: 'Pending', state: 'skip' },
};

function reviewSummary(pr: PullRequest): string {
  const approved = pr.reviews.filter(r => r.state === 'approved').map(r => r.author);
  if (pr.reviewDecision === 'changes_requested') return 'Changes requested';
  if (approved.length) return `${approved.join(', ')} approved`;
  if (pr.reviewDecision === 'review_required') return 'Review required';
  return pr.reviews.length ? 'Commented' : 'No reviews';
}

type PrTab = 'summary' | 'code' | 'checks';

/** One PR's files and commits, read when it is shown (cached by the server). */
function usePrDetail(pr: PullRequest, fresh: number): { detail: PrDetail | null; error: string | null } {
  const [state, setState] = useState<{ detail: PrDetail | null; error: string | null }>({ detail: null, error: null });
  const first = useRef(fresh);
  useEffect(() => {
    let live = true;
    // After a Refresh press, read GitHub again (the server keeps its 10 s floor).
    api.prDetail(pr.repo, pr.number, fresh !== first.current)
      .then(detail => { if (live) setState({ detail, error: null }); })
      // A failed re-read keeps the files and commits already shown.
      .catch((err: Error) => { if (live) setState(prev => ({ detail: prev.detail, error: err.message })); });
    return () => { live = false; };
  }, [pr.repo, pr.number, fresh]);
  return state;
}

/**
 * The selected PR, as MonoCode's InboxDetail: the identity bar, then the title, who and when and
 * which branches, the actions, the Summary / Code / Checks tabs, and its commits as the activity.
 */
function PrInboxDetail({ pr, now, tab, onTab: setTab, fresh, onKeyDown }: { pr: PullRequest; now: number; tab: PrTab; onTab: (tab: PrTab) => void; fresh: number; onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copyLink = () => {
    const done = (state: 'copied' | 'failed') => {
      setCopy(state);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopy('idle'), 2000);
    };
    navigator.clipboard.writeText(pr.url).then(() => done('copied'), () => done('failed'));
  };
  const { detail, error } = usePrDetail(pr, fresh);
  const checks = checksLabel(pr.checksSummary);
  const linked = isHttpUrl(pr.url);
  const created = detail?.createdAt ? Date.parse(detail.createdAt) : NaN;
  return (
    <InboxDetail
      onKeyDown={onKeyDown}
      bar={
        <InboxBar backLabel="All pull requests" onBack={() => { open({ kind: 'pullRequests' }); focusCard(pr.id); }}>
          <span className="flex shrink-0 items-center gap-1.5"><StateIcon pr={pr} /><span className="text-content/70">{STATE_WORD[pr.state]}</span></span>
          <span className="shrink-0 tabular-nums">#{pr.number}</span>
          <span className="min-w-0 truncate">{pr.repo}</span>
          <span className="ml-auto shrink-0 @max-[28rem]/detail:hidden"><StatusText state={SUMMARY_STATE[checks.tone]} quiet={checks.tone === 'muted'}>{checks.text}</StatusText></span>
        </InboxBar>
      }
    >
      <InboxHero
        title={pr.title}
        tabs={<InboxTabs label="Pull request sections" value={tab} onChange={setTab} tabs={[
          { value: 'summary', label: 'Summary' },
          { value: 'code', label: 'Code', count: detail?.filesTotal },
          { value: 'checks', label: 'Checks', mark: pr.checks.length ? <StatusMark state={SUMMARY_STATE[checks.tone]} quiet={checks.tone === 'muted'} className="size-3.5" /> : undefined, count: pr.checks.length },
        ]} />}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[12px] text-content/50">
          <span className="inline-flex min-w-0 items-center gap-1.5"><WhoAvatar name={pr.author} agentId={pr.agentId} /><span className="truncate">{pr.author}</span></span>
          {Number.isFinite(created) ? <><span aria-hidden>·</span><span>Created {relativeTime(created, now)}</span></> : null}
          <span aria-hidden>·</span>
          <span>{pr.mergedAt ? `Merged ${relativeTime(Date.parse(pr.mergedAt), now)}` : `Updated ${relativeTime(Date.parse(pr.updatedAt), now)}`}</span>
          <span aria-hidden>·</span>
          <span className="inline-flex min-w-0 items-center gap-1" title={`${detail?.baseRef ?? 'base'} ← ${pr.branch}`}>
            <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate font-mono text-[11.5px]">{detail?.baseRef ? `${detail.baseRef} ← ` : ''}{pr.branch}</span>
          </span>
          <span aria-hidden>·</span>
          <span>{reviewSummary(pr)}</span>
        </div>
        {pr.issueKey || pr.agentId ? (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 font-sans text-[11px]">
            {pr.issueKey ? (
              <span title={`Found by the key in the ${pr.branch.includes(pr.issueKey) ? 'branch name' : 'title or description'}`} className="inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 font-mono text-[var(--link-color)]">{pr.issueKey}</span>
            ) : null}
            {pr.agentId ? (
              <button type="button" onClick={() => open({ kind: 'agent', agentId: pr.agentId! })} className="inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content">
                <WhoAvatar name="" agentId={pr.agentId} className="size-3.5" />
                Worked on by this agent
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <button
            type="button"
            disabled={!linked}
            onClick={copyLink}
            className={ACTION_OUTLINE}
          >
            <Copy className="size-3.5" strokeWidth={1.75} />
            <span aria-live="polite">{copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Copy failed' : 'Copy link'}</span>
          </button>
          {linked ? (
            <a href={pr.url} target="_blank" rel="noreferrer" className={ACTION_GHOST}>
              <ExternalLink className="size-3.5" strokeWidth={1.75} />
              {isOpen(pr) ? 'Review on GitHub' : 'Open on GitHub'}
            </a>
          ) : null}
        </div>
      </InboxHero>

      {tab === 'summary' ? (
        <InboxSection title="Description">
          {pr.body.trim() ? <Markdown text={pr.body} remote className="text-[13px]" /> : <p className="font-sans text-[12px] text-content/40">No description.</p>}
          <div className="mb-1 mt-6 font-sans text-[12px] text-content/70">Reviews</div>
          <Reviews pr={pr} />
        </InboxSection>
      ) : tab === 'code' ? (
        <InboxSection title="Changed files" count={detail ? <span className="tabular-nums"><span className="text-success">+{detail.additions}</span> <span className="text-danger">−{detail.deletions}</span></span> : undefined}>
          {detail ? <Files detail={detail} /> : error ? <p className="font-sans text-[12px] text-content/45">The changed files could not be read ({error}).</p> : <Loading className="py-2" />}
        </InboxSection>
      ) : (
        <InboxSection title="Checks" count={checks.text}>
          <Checks pr={pr} />
        </InboxSection>
      )}

      <InboxSection title="Activity" count={detail ? `${detail.commitsTotal} ${detail.commitsTotal === 1 ? 'commit' : 'commits'}` : undefined}>
        {detail ? <Commits pr={pr} detail={detail} now={now} /> : error ? <p className="font-sans text-[12px] text-content/45">The commits could not be read ({error}).</p> : <Loading className="py-2" />}
        <p className="mt-5 font-sans text-[11.5px] leading-relaxed text-content/45">
          Read only, through the gh commands the SuperAgent already uses. Merging stays a decision for you{isOpen(pr) ? ', on GitHub' : ''}.
        </p>
      </InboxSection>
    </InboxDetail>
  );
}

/** The changed files with their added and removed lines (MonoCode's InboxPrChangesGlance, without the diff). */
function Files({ detail }: { detail: PrDetail }) {
  if (!detail.files.length) return <p className="font-sans text-[12px] text-content/40">No changed files.</p>;
  return (
    <>
      <ul className="flex flex-col font-sans text-[12px]">
        {detail.files.map(f => (
          <li key={f.path} className="flex h-7 items-center gap-2 rounded-md px-1 hover:bg-content/5">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-content/85" title={f.path}>{f.path}</span>
            <span className="shrink-0 tabular-nums text-[11px] text-success">+{f.additions}</span>
            <span className="w-10 shrink-0 text-right tabular-nums text-[11px] text-danger">−{f.deletions}</span>
          </li>
        ))}
      </ul>
      {detail.filesTotal > detail.files.length ? <p className="mt-2 font-sans text-[11.5px] text-content/40">{detail.filesTotal - detail.files.length} more on GitHub.</p> : null}
    </>
  );
}

/** The commits, oldest first, as timeline stops; a merged PR ends with its merge. */
function Commits({ pr, detail, now }: { pr: PullRequest; detail: PrDetail; now: number }) {
  const stops = detail.commits.length + (pr.mergedAt ? 1 : 0);
  if (!stops) return <p className="font-sans text-[12px] text-content/40">No commits.</p>;
  const dot = <span className="size-2 rounded-full bg-content/30" />;
  return (
    <ol className="flex flex-col">
      {detail.commits.map((c, i) => (
        <TimelineStop key={c.oid} first={i === 0} last={i === stops - 1} node={dot}>
          <p className="flex h-5 min-w-0 items-center gap-1.5 font-sans text-[12px] text-content/50">
            <span className="min-w-0 truncate text-content">{c.headline}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{c.author}</span>
            <span className="shrink-0 font-mono text-[11px] text-content/40">{c.oid.slice(0, 7)}</span>
            {c.at ? <span className="ml-auto shrink-0 tabular-nums text-[11px] text-content/40">{relativeTime(Date.parse(c.at), now)}</span> : null}
          </p>
        </TimelineStop>
      ))}
      {pr.mergedAt ? (
        <TimelineStop first={!detail.commits.length} last node={<GitMerge className="size-3.5 text-info" strokeWidth={1.75} />}>
          <p className="flex h-5 items-center gap-1.5 font-sans text-[12px] text-content/50">
            <span className="text-content">Merged</span>
            {pr.mergeCommit ? <span className="font-mono text-[11px] text-content/40">{pr.mergeCommit.slice(0, 7)}</span> : null}
            <span className="ml-auto tabular-nums text-[11px] text-content/40">{relativeTime(Date.parse(pr.mergedAt), now)}</span>
          </p>
        </TimelineStop>
      ) : null}
    </ol>
  );
}

function Reviews({ pr }: { pr: PullRequest }) {
  if (!pr.reviews.length) return <p className="font-sans text-[12px] text-content/40">No reviews yet.</p>;
  return (
    <ul className="flex flex-col font-sans text-[12px]">
      {pr.reviews.map(r => (
        <li key={r.author} className="flex h-7 items-center gap-2 px-1">
          <WhoAvatar name={r.author} />
          <span className="min-w-0 flex-1 truncate text-content/85">{r.author}</span>
          <StatusText state={REVIEW[r.state].state}>{REVIEW[r.state].word}</StatusText>
        </li>
      ))}
    </ul>
  );
}

/** Checks grouped by state, failures first (MonoCode's CHECK_STATES order). */
function Checks({ pr }: { pr: PullRequest }) {
  if (!pr.checks.length) return <p className="font-sans text-[12px] text-content/40">No checks.</p>;
  return (
    <>
      {CHECK_ORDER.map(state => {
        const group = pr.checks.filter(c => CHECK_STATE[c.state] === state);
        if (!group.length) return null;
        return (
          <div key={state}>
            <h4 className="mb-0.5 mt-2.5 flex items-center gap-2 px-1 font-sans text-[12px] font-normal text-content/55">
              {statusWord(state)}
              <span className="text-[10px] tabular-nums text-content/35">{group.length}</span>
            </h4>
            <ul className="flex flex-col font-sans text-[12px]">
              {group.map((c, i) => {
                const linkedCheck = isHttpUrl(c.url);
                // A link carries the whole name; without one, the mark names its state itself.
                const body = (
                  <>
                    <span className="grid h-7 w-5 shrink-0 place-items-center"><StatusMark state={state} {...(linkedCheck ? {} : { label: statusWord(state) })} /></span>
                    <span className="min-w-0 flex-1 truncate text-content/85">{c.name}</span>
                    {c.workflow ? <span className="shrink-0 text-[11px] text-content/40">{c.workflow}</span> : null}
                  </>
                );
                return (
                  <li key={`${c.name}-${i}`}>
                    {linkedCheck
                      ? <a href={c.url} target="_blank" rel="noreferrer" aria-label={`${c.name}: ${statusWord(state)}`} className="flex h-7 items-center gap-2 rounded-md px-1 hover:bg-content/5">{body}</a>
                      : <span className="flex h-7 items-center gap-2 px-1">{body}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/** "just now", or "2m ago". */
function ago(ts: number, now: number): string {
  const t = relativeTime(ts, now);
  return t === 'now' ? 'just now' : `${t} ago`;
}

/** Focus a PR's card on the next frame (after the list shows again), as Back and Escape hand focus back to the list. */
function focusCard(id: string): void {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`)?.focus());
}
