/**
 * One issue in the full pane (ACH-D41, ACH-D43 phase 4), as in the approved demo: a breadcrumb,
 * the title and description (edited in place), sub-issues with a quiet "3/5", relations both
 * ways, In git, Decisions, and the activity; the properties beside it. Built from MonoCode's
 * primitives and our shared components (ACH-D23): PaneFrame, Popover and MenuRow, Markdown,
 * AgentAvatar, RefChip, Kbd. Flat, theme colours only, one-line rows.
 *
 * S, P, D and L open Status, Priority, Due date and Labels while focus is not in a text field.
 */
import { useRef } from 'react';
import { Folder } from '../mono/icons.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { useApp } from '../store.ts';
import { Empty } from '../ui/common.tsx';
import { Activity } from './view/Activity.tsx';
import { IssueDescription, IssueTitle } from './view/EditableText.tsx';
import { StatusGlyph } from './view/glyphs.tsx';
import { parentOf, propertyKey } from './view/issueViewModel.ts';
import { PropertySidebar, type PropertySidebarHandle } from './view/PropertySidebar.tsx';
import { Decisions, InGit, Relations, SubIssues, useIssueLinks } from './view/Sections.tsx';
import { open } from '../layout.ts';
import type { SuperIssue } from '../../shared/types.ts';
import { CircleDashed } from '../mono/icons.tsx';

export function IssueView({ issueId, chrome }: { issueId: string; chrome: PaneChrome }) {
  const issues = useApp(s => s.snapshot?.super.issues) ?? [];
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  const issue = issues.find(i => i.id === issueId);
  const sidebar = useRef<PropertySidebarHandle>(null);
  if (!issue) {
    return (
      <PaneFrame chrome={chrome} title={<span className="text-content/60">Issue</span>}>
        <Empty icon={CircleDashed} title="This issue is gone">It was removed, or it lives on another PodCode.</Empty>
      </PaneFrame>
    );
  }
  return <IssueBody issue={issue} issues={issues} projectName={projects.find(p => p.id === issue.projectId)?.name} chrome={chrome} sidebar={sidebar} />;
}

function IssueBody({ issue, issues, projectName, chrome, sidebar }: { issue: SuperIssue; issues: SuperIssue[]; projectName?: string; chrome: PaneChrome; sidebar: React.RefObject<PropertySidebarHandle | null> }) {
  const links = useIssueLinks(issue);
  const parent = parentOf(issues, issue);
  const title = (
    <span className="flex min-w-0 items-center gap-2 font-sans text-[12.5px]">
      <StatusGlyph status={issue.status} />
      <span className="shrink-0 font-mono text-[12px] text-content/55">{issue.key}</span>
      <span className="truncate text-content">{issue.title}</span>
    </span>
  );
  return (
    <PaneFrame chrome={chrome} title={title}>
      <div
        className="flex min-h-0 flex-1 overflow-hidden"
        onKeyDown={e => {
          const property = propertyKey(e, e.target);
          if (!property) return;
          e.preventDefault();
          sidebar.current?.open(property);
        }}
      >
        <article aria-label={`${issue.key} ${issue.title}`} className="min-w-0 flex-1 overflow-y-auto px-8 pb-12 pt-6">
          <div className="mx-auto flex max-w-[760px] flex-col gap-6">
            <div className="flex flex-col gap-2">
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 font-sans text-[12px] text-content/50">
                <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{projectName ?? 'No project'}</span>
                {parent ? (
                  <>
                    <span aria-hidden>›</span>
                    <button type="button" onClick={() => open({ kind: 'issue', issueId: parent.id })} className="truncate rounded px-0.5 hover:text-content/80" title={parent.title}>{parent.key}</button>
                  </>
                ) : null}
                <span aria-hidden>›</span>
                <span className="shrink-0 font-mono">{issue.key}</span>
              </nav>
              <IssueTitle id={issue.id} title={issue.title} />
              <IssueDescription id={issue.id} text={issue.text} />
            </div>
            <SubIssues issue={issue} issues={issues} />
            <Relations issue={issue} issues={issues} />
            <InGit issue={issue} links={links} />
            <Decisions links={links} />
            <Activity issue={issue} />
          </div>
        </article>
        <div className="w-[320px] shrink-0 overflow-y-auto border-l border-content/7 px-5 pb-8 pt-6">
          <PropertySidebar ref={sidebar} issue={issue} issues={issues} />
        </div>
      </div>
    </PaneFrame>
  );
}
