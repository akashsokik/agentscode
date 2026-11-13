import { useRef, useState } from 'react';
import { ISSUE_STATUS_LABEL } from '../../shared/issues.ts';
import type { SuperIssue } from '../../shared/types.ts';
import { relativeTime } from '../format.ts';
import { open } from '../layout.ts';
import { Copy } from '../mono/icons.tsx';
import { WhoAvatar } from '../notes/parts.tsx';
import { useApp } from '../store.ts';
import { ContextMenu, openContextMenu, type MenuAnchor } from '../ui/ContextMenu.tsx';
import { ACTION_OUTLINE, InboxBar, InboxCard, InboxDetail, InboxHero, InboxSection } from '../ui/Inbox.tsx';
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

/**
 * The selected issue (ACH-D54): the identity bar (status, key, project), the hero (title, who, when,
 * Copy key), Details (the description and the properties), then sub-issues, relations, In git,
 * decisions and the activity with its comment box. S, P, D and L open Status, Priority, Due date
 * and Labels, as in Ada's issue view.
 */
export function IssueInboxDetail({ issue, issues, now }: { issue: SuperIssue; issues: SuperIssue[]; now: number }) {
  const project = useApp(s => (issue.projectId ? s.snapshot?.projects.find(p => p.id === issue.projectId) : undefined));
  const agentName = useApp(s => (issue.agentId ? s.snapshot?.agents.find(a => a.id === issue.agentId)?.name : undefined));
  const links = useIssueLinks(issue);
  const sidebar = useRef<PropertySidebarHandle>(null);
  const who = assigneeName(issue, agentName);
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(issue.key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <InboxDetail
      bar={(
        <InboxBar backLabel="Back to issues" onBack={() => open({ kind: 'issues' })}>
          <StatusIcon status={issue.status} />
          <span className="shrink-0 font-mono text-content/70">{issue.key}</span>
          <span className="min-w-0 truncate">{project?.name ?? 'No project'}</span>
          <span className="ml-auto shrink-0">{ISSUE_STATUS_LABEL[issue.status]}</span>
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
          <p className="font-sans text-[12px] text-content/50">
            {who ? `With ${who}` : 'Nobody on it yet'} · added by {issue.by === 'user' ? 'you' : 'the SuperAgent'} {relativeTime(issue.createdAt, now)} ago
            {issue.updatedAt !== issue.createdAt ? ` · updated ${relativeTime(issue.updatedAt, now)} ago` : ''}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={ACTION_OUTLINE} onClick={copy}>
              <Copy aria-hidden className="size-3.5" strokeWidth={1.75} />
              {copied ? 'Copied' : `Copy ${issue.key}`}
            </button>
          </div>
        </InboxHero>
        <InboxSection title="Details">
          <IssueDescription id={issue.id} text={issue.text} />
          <div className="mt-5">
            <PropertySidebar ref={sidebar} issue={issue} issues={issues} />
          </div>
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
