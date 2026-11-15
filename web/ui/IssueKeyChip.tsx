import { ISSUE_PRIORITY_LABEL, ISSUE_STATUS_LABEL } from '../../shared/issues.ts';
import type { SuperIssue } from '../../shared/types.ts';
import { DueDate, PriorityIcon, StatusIcon } from '../issues/issueParts.tsx';
import { localDay } from '../issues/issuesView.ts';
import { relativeTime } from '../format.ts';
import { showIssueInList } from '../issues/openIssue.ts';
import { WhoAvatar } from '../notes/parts.tsx';
import { getState, useApp } from '../store.ts';
import { ReferenceChip } from '../notes/RefChip.tsx';
import { issueGist, updated } from './issueCard.ts';
import { useNow } from './useNow.ts';

/**
 * An issue key in text (ACH-23 in a transcript, a message, a PR description) as a chip (ACH-D57):
 * the reference chip's look (.ref-chip, as notes and decisions), in the content colour, with the
 * issue's status mark. Hovering it (or focusing it) shows the same card as a decision chip
 * (web/ui/HoverCard.tsx, ACH-D58): status, title, its properties, a gist and when it changed.
 * A click shows it on the Issues page, selected (showIssueInList, ACH-D52); the right panel keeps
 * its tabs (ACH-D55). Only keys of issues that exist become chips, so "UTF-8", "SHA-256", ACH-0
 * or a removed issue's key stay text.
 */

/** Whether a key names an issue PodCode has now (for the Markdown chip pass). */
export function isKnownIssueKey(key: string): boolean {
  return Boolean(getState().snapshot?.super.issues.some(i => i.key === key));
}

/** The issue keys there are, as one string: Markdown parses again when it changes. */
export function useIssueKeysKey(): string {
  return useApp(s => (s.snapshot?.super.issues ?? []).map(i => i.key).join(' '));
}

export function IssueKeyChip({ issueKey, fade, inert = false }: { issueKey: string; fade?: boolean; inert?: boolean }) {
  const issue = useApp(s => s.snapshot?.super.issues.find(i => i.key === issueKey));
  if (!issue) return <>{issueKey}</>;
  return <ReferenceChip kind="Issue" label={issue.key} inert={inert} fade={fade} glyph={<StatusIcon status={issue.status} className="size-3" />}
    onOpen={() => showIssueInList(issue.id)} cardContent={<IssueCard issue={issue} />} />;
}

/** The issue's card: the decision card's shell and order, with an issue's facts. */
function IssueCard({ issue }: { issue: SuperIssue }) {
  const agent = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId) : undefined));
  const project = useApp(s => s.snapshot?.projects.find(p => p.id === issue.projectId));
  const now = useNow();
  const gist = issueGist(issue.text);
  const facts = [
    issue.priority !== 'none' ? <span key="priority" className="inline-flex items-center gap-1"><PriorityIcon priority={issue.priority} className="size-3" />{ISSUE_PRIORITY_LABEL[issue.priority]}</span> : null,
    agent ? <span key="who" className="inline-flex min-w-0 items-center gap-1"><WhoAvatar name={agent.name} agentId={agent.id} className="size-3.5" /><span className="truncate">{agent.name}</span></span>
      : issue.forUser ? <span key="who" className="inline-flex items-center gap-1"><WhoAvatar name="You" className="size-3.5" />You</span> : null,
    issue.dueDate ? <span key="due" className="inline-flex"><DueDate dueDate={issue.dueDate} today={localDay(now)} /></span> : null,
    project ? <span key="project" className="truncate">{project.name}</span> : null,
  ].filter(Boolean);
  return (
    <>
      <div className="flex items-center gap-1.5 text-[11px] text-content/55">
        <StatusIcon status={issue.status} className="size-3" />
        <span>Issue</span>
        <span className="text-content/35">·</span>
        <span className="font-mono">{issue.key}</span>
        <span className="ml-auto">{ISSUE_STATUS_LABEL[issue.status]}</span>
      </div>
      <h3 className="mt-2 text-[13px] font-semibold leading-5">{issue.title}</h3>
      {facts.length ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-content/60">{facts}</div>
      ) : null}
      {issue.labels.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {issue.labels.map(l => <span key={l} className="rounded-full border border-content/12 px-1.5 text-[11px] leading-[17px] text-content/65">{l}</span>)}
        </div>
      ) : null}
      {gist && gist !== issue.title ? <p className="mt-1.5 line-clamp-3 text-[12px] leading-[1.45] text-content/55">{gist}</p> : null}
      <div className="mt-2.5 flex min-w-0 items-center gap-1.5 text-[11px] text-content/45">
        <span className="truncate">{updated(relativeTime(issue.updatedAt, now))}</span>

      </div>
    </>
  );
}
