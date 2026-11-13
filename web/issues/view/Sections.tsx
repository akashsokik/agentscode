/**
 * The issue view's sections under the description: Sub-issues with a quiet "3/5" (ACH-D46
 * progress A), Relations both ways, In git, and Decisions. One-line rows; a row opens its issue
 * in the full pane. In git and Decisions read through issueLinks.ts (Hal's API once it lands).
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { SuperIssue } from '../../../shared/types.ts';
import { open } from '../../layout.ts';
import { CornerDownRight, GitBranch, Route, StickyNote } from '../../mono/icons.tsx';
import { useNotes } from '../../notes/refsState.ts';
import { RefChip } from '../../notes/RefChip.tsx';
import { useApp } from '../../store.ts';
import { AgentAvatar } from '../../ui/Avatar.tsx';
import { PriorityGlyph, StatusGlyph } from './glyphs.tsx';
import { issueLinksSource, type IssueLinks } from './issueLinks.ts';
import { dueTone, relationsOf, subIssues } from './issueViewModel.ts';

type Icon = typeof GitBranch;

export function Section({ icon: IconC, title, meta, children }: { icon: Icon; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="font-sans">
      <h3 className="mb-1 flex h-7 items-center gap-2 text-[12px] font-medium text-content/60">
        <IconC aria-hidden className="size-3.5 text-content/45" strokeWidth={1.75} />
        {title}
        {meta ? <span className="font-normal text-content/45">{meta}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** One issue on one line: status, priority, key, title; due date and assignee quiet at the right. */
export function IssueLine({ issue, lead }: { issue: SuperIssue; lead?: ReactNode }) {
  const agent = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId) : undefined));
  const due = dueTone(issue.dueDate, issue.status, new Date());
  return (
    <button
      type="button"
      data-issue-line={issue.id}
      onClick={() => open({ kind: 'issue', issueId: issue.id })}
      title={`${issue.key} ${issue.title}`}
      className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] px-1.5 text-left font-sans text-[12.5px] outline-none transition-colors hover:bg-content/5 focus-visible:bg-content/7"
    >
      {lead}
      <StatusGlyph status={issue.status} />
      <PriorityGlyph priority={issue.priority} />
      <span className="shrink-0 font-mono text-[11.5px] text-content/45">{issue.key}</span>
      <span className={`min-w-0 flex-1 truncate ${issue.status === 'done' || issue.status === 'canceled' ? 'text-content/50' : 'text-content/85'}`}>{issue.title}</span>
      {due ? <span className={`shrink-0 text-[11.5px] ${due.tone === 'danger' ? 'text-danger' : due.tone === 'warning' ? 'text-warning' : 'text-content/45'}`}>{due.text.replace(/^(Today|Tomorrow|Yesterday), /, '')}</span> : null}
      {agent ? <AgentAvatar agent={agent} animate={false} className="size-4" /> : null}
    </button>
  );
}

export function SubIssues({ issue, issues }: { issue: SuperIssue; issues: SuperIssue[] }) {
  const subs = subIssues(issues, issue.id);
  if (!subs.items.length) return null;
  return (
    <Section icon={CornerDownRight} title="Sub-issues" meta={subs.label}>
      <div>{subs.items.map(s => <IssueLine key={s.id} issue={s} />)}</div>
    </Section>
  );
}

export function Relations({ issue, issues }: { issue: SuperIssue; issues: SuperIssue[] }) {
  const rows = relationsOf(issues, issue);
  if (!rows.length) return null;
  return (
    <Section icon={Route} title="Relations">
      <div>
        {rows.map(r => (
          <div key={`${r.label}:${r.issue.id}`} className="flex min-w-0 items-center">
            <span className="w-24 shrink-0 font-sans text-[12px] text-content/45">{r.label}</span>
            <div className="min-w-0 flex-1"><IssueLine issue={r.issue} /></div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** In git and Decisions, from the links source (local until Hal's API lands). */
export function useIssueLinks(issue: SuperIssue): IssueLinks | null {
  const [links, setLinks] = useState<IssueLinks | null>(null);
  useEffect(() => {
    let live = true;
    void issueLinksSource()(issue).then(l => { if (live) setLinks(l); }, () => { if (live) setLinks(null); });
    return () => { live = false; };
  }, [issue]);
  return links;
}

export function InGit({ issue, links }: { issue: SuperIssue; links: IssueLinks | null }) {
  const git = links?.git;
  const quiet = 'font-sans text-[12.5px] text-content/45';
  return (
    <Section icon={GitBranch} title="In git">
      {git?.branch || git?.commits.length ? (
        <div className="flex flex-col gap-0.5 font-sans text-[12.5px]">
          {git.branch ? <div className="flex min-h-7 items-center"><span className="w-24 shrink-0 text-content/45">Branch</span><span className="truncate font-mono text-[12px] text-content/85">{git.branch.name}</span></div> : null}
          {git.commits.map((c, i) => (
            <div key={c.sha} className="flex min-h-7 items-center"><span className="w-24 shrink-0 text-content/45">{i === 0 ? 'Commits' : ''}</span><span className="mr-2 shrink-0 font-mono text-[11.5px] text-content/45">{c.sha.slice(0, 7)}</span><span className="truncate text-content/80">{c.subject}</span></div>
          ))}
          {git.closes ? <div className="flex min-h-7 items-center"><span className="w-24 shrink-0 text-content/45">Closes</span><span className="truncate text-content/75">{git.closes}</span></div> : null}
        </div>
      ) : (
        <p className={quiet}>No branch or commit names {issue.key} yet. An agent that starts it names its branch feat/{issue.key}-…, and it closes when that merges into main.</p>
      )}
    </Section>
  );
}

export function Decisions({ links }: { links: IssueLinks | null }) {
  const byId = useNotes(s => s.byId);
  const ids = links?.decisions ?? [];
  if (!ids.length) return null;
  return (
    <Section icon={StickyNote} title="Decisions" meta={`${ids.length}${links?.source === 'local' ? ' cited here' : ' cited in its handoffs, reports and commits'}`}>
      <div className="flex flex-col">
        {ids.map(id => (
          <div key={id} className="flex h-[30px] min-w-0 items-center gap-2 px-1.5 font-sans text-[12.5px]">
            <RefChip id={id} />
            <span className="truncate text-content/80">{byId.get(id)?.title ?? ''}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
