import { useRef, useState } from 'react';
import { ISSUE_STATUS_LABEL } from '../../shared/issues.ts';
import type { SuperIssue } from '../../shared/types.ts';
import { relativeTime } from '../format.ts';
import { open } from '../layout.ts';
import { WhoAvatar } from '../notes/parts.tsx';
import { useApp } from '../store.ts';
import { ContextMenu, openContextMenu, type MenuAnchor } from '../ui/ContextMenu.tsx';
import { InboxBar, InboxCard, InboxDetail, InboxHero, InboxSection } from '../ui/Inbox.tsx';
import { assigneeName, DueDate, IssueMenu, PriorityMark, StatusIcon } from './issueParts.tsx';
import { type RowProperty } from './issuesView.ts';
import { showIssueInList } from './openIssue.ts';
import { Activity } from './view/Activity.tsx';
import { IssueDescription } from './view/EditableText.tsx';
import { propertyKey } from './view/issueViewModel.ts';
import { PropertySidebar, type PropertySidebarHandle } from './view/PropertySidebar.tsx';
import { Decisions, InGit, Relations, SubIssues, useIssueLinks } from './view/Sections.tsx';

// The Issues page on the shared inbox layout (ACH-D54): an issue as an InboxCard in the list, and
// its detail beside it, built from Ada's issue view pieces inside InboxDetail (web/ui/Inbox.tsx).

/** One issue in the list: status, key, project and when; the title; then status, priority, due and who. */
export function IssueCard({ issue, active, properties, today, now }: {
  issue: SuperIssue;
  active: boolean;
  properties: readonly RowProperty[];
  today: string;
  now: number;
}) {
  const project = useApp(s => (issue.projectId ? s.snapshot?.projects.find(p => p.id === issue.projectId) : undefined));
  const agentName = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId)?.name : undefined));
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const show = (p: RowProperty) => properties.includes(p);
  const who = assigneeName(issue, agentName);
  const select = () => showIssueInList(issue.id);
  return (
    <li onContextMenu={e => openContextMenu(e, setMenu)}>
      <InboxCard
        id={issue.id}
        active={active}
        onSelect={select}
        label={`${issue.key} ${ISSUE_STATUS_LABEL[issue.status]}: ${issue.title}${who ? `, with ${who}` : ''}${project ? `, ${project.name}` : ''}`}
        title={issue.title}
        top={(
          <>
            <StatusIcon status={issue.status} />
            {show('key') ? <span className="shrink-0 font-mono text-[11px] text-content/55">{issue.key}</span> : null}
            {show('project') && project ? <span className="min-w-0 truncate text-[11px] text-content/45">{project.code ?? project.name}</span> : null}
            {show('updated') ? <span className="ml-auto shrink-0 text-[11px] tabular-nums text-content/40">{relativeTime(issue.updatedAt, now)}</span> : null}
          </>
        )}
        meta={(
          <>
            <span className="shrink-0">{ISSUE_STATUS_LABEL[issue.status]}</span>
            {show('priority') && issue.priority !== 'none' ? <PriorityMark priority={issue.priority} /> : null}
            {show('due') && issue.dueDate ? <DueDate dueDate={issue.dueDate} today={today} /> : null}
            {show('labels') && issue.labels.length ? <span className="min-w-0 truncate">{issue.labels.join(', ')}</span> : null}
            {show('assignee') && who ? (
              <span className="ml-auto flex min-w-0 items-center gap-1">
                <WhoAvatar name={who} agentId={issue.forUser ? undefined : issue.agentId} className="size-3.5" />
                <span className="truncate">{who}</span>
              </span>
            ) : null}
          </>
        )}
      />
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} label={`Issue ${issue.key}`}><IssueMenu issue={issue} close={() => setMenu(null)} onOpen={select} /></ContextMenu> : null}
    </li>
  );
}

/** A hero pill, as Comms draws its participants (CommsPane): a button when it opens something. */
const PILL = 'inline-flex max-w-64 items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 font-sans text-[11px]';

/**
 * The selected issue, laid out as a Comms conversation (ACH-D54): the bar (status, then the issue
 * and when it was added; when it was updated on the right), the hero (title, then who and the project
 * as pills), then stacked sections: Description, Properties, sub-issues, relations, In git, decisions
 * and the Activity with its comment box. No tabs. S, P, D and L open Status, Priority, Due date and
 * Labels, as in Ada's issue view.
 */
export function IssueInboxDetail({ issue, issues, now }: { issue: SuperIssue; issues: SuperIssue[]; now: number }) {
  const project = useApp(s => (issue.projectId ? s.snapshot?.projects.find(p => p.id === issue.projectId) : undefined));
  const agentName = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId)?.name : undefined));
  const links = useIssueLinks(issue);
  const sidebar = useRef<PropertySidebarHandle>(null);
  const who = assigneeName(issue, agentName);
  const agentId = issue.forUser ? undefined : issue.agentId;
  return (
    <InboxDetail
      bar={(
        <InboxBar backLabel="All issues" onBack={() => open({ kind: 'issues' })}>
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusIcon status={issue.status} />
            <span className="text-content/70">{ISSUE_STATUS_LABEL[issue.status]}</span>
          </span>
          <span className="min-w-0 truncate">
            <span className="font-mono">{issue.key}</span> · added {relativeTime(issue.createdAt, now)} ago by {issue.by === 'user' ? 'you' : 'the SuperAgent'}
          </span>
          {issue.updatedAt !== issue.createdAt ? (
            <span className="ml-auto shrink-0 tabular-nums text-content/45 @max-[28rem]/detail:hidden">updated {relativeTime(issue.updatedAt, now)} ago</span>
          ) : null}
        </InboxBar>
      )}
    >
      <div
        onKeyDown={e => {
          const property = propertyKey(e, e.target);
          if (!property) return;
          e.preventDefault();
          sidebar.current?.open(property);
        }}
      >
        <InboxHero title={issue.title}>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {who && agentId ? (
              <button type="button" onClick={() => open({ kind: 'agent', agentId })} title={`Open ${who}`} className={`${PILL} text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content`}>
                <WhoAvatar name={who} agentId={agentId} className="size-3.5" />{who}
              </button>
            ) : (
              <span className={`${PILL} text-content/45`}>{who ? <><WhoAvatar name={who} className="size-3.5" />{who}</> : 'Nobody on it yet'}</span>
            )}
            {project ? <span className={`${PILL} text-content/45`}>{project.name}</span> : null}
          </div>
        </InboxHero>
        <InboxSection title="Description">
          <IssueDescription id={issue.id} text={issue.text} />
        </InboxSection>
        <InboxSection title="Properties">
          <PropertySidebar ref={sidebar} issue={issue} issues={issues} />
        </InboxSection>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-10 @min-[40rem]/inbox:px-6">
          <SubIssues issue={issue} issues={issues} />
          <Relations issue={issue} issues={issues} />
          <InGit issue={issue} links={links} />
          <Decisions links={links} />
          <Activity issue={issue} />
        </div>
      </div>
    </InboxDetail>
  );
}
