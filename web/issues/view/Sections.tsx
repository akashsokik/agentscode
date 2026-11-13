/**
 * The issue view's sections under the description: Sub-issues with a quiet "3/5" (ACH-D46
 * progress A), Relations both ways, In git, and Decisions. One-line rows; a row opens its issue
 * in the full pane. In git and Decisions read through issueLinks.ts (Hal's API once it lands).
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { IssueRelationType, SuperIssue } from '../../../shared/types.ts';
import { showIssueInList } from '../openIssue.ts';
import { CornerDownRight, GitBranch, Plus, Route, StickyNote, X } from '../../mono/icons.tsx';
import { useNotes } from '../../notes/refsState.ts';
import { RefChip } from '../../notes/RefChip.tsx';
import { useApp } from '../../store.ts';
import { AgentAvatar } from '../../ui/Avatar.tsx';
import { issueLinksSource, type IssueLinks } from './issueLinks.ts';
import { dueTone, RELATION_TYPES, relationRemoval, relationsOf, subIssues, withRelation } from './issueViewModel.ts';
import { writeIssue } from './issueWrites.ts';
import { Picker } from './Picker.tsx';
import { StatusIcon, PriorityIcon } from '../issueParts.tsx';

type Icon = typeof GitBranch;

export function Section({ icon: IconC, title, meta, action, children }: { icon: Icon; title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="font-sans">
      <h3 className="mb-1 flex h-7 items-center gap-2 text-[12px] font-medium text-content/60">
        <IconC aria-hidden className="size-3.5 text-content/45" strokeWidth={1.75} />
        {title}
        {meta ? <span className="font-normal text-content/45">{meta}</span> : null}
        {action}
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
      // Shown on the Issues page, selected in its list, as everywhere else (ACH-D54): no tab of its own.
      onClick={() => showIssueInList(issue.id)}
      title={`${issue.key} ${issue.title}`}
      className="flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[7px] px-1.5 text-left font-sans text-[12.5px] outline-none transition-colors hover:bg-content/5 focus-visible:bg-content/7"
    >
      {lead}
      <StatusIcon status={issue.status} />
      <PriorityIcon priority={issue.priority} />
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
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [type, setType] = useState<IssueRelationType>('blocks');
  const remove = (row: (typeof rows)[number]) => {
    for (const write of relationRemoval(issues, row, issue.id)) void writeIssue(write.id, { relations: write.relations });
  };
  const add = (otherId: string) => {
    const relations = withRelation(issue, type, otherId);
    setAdding(null);
    if (relations) void writeIssue(issue.id, { relations });
  };
  const addButton = (
    <button type="button" aria-label="Add a relation" title="Add a relation" onClick={e => setAdding(e.currentTarget)} className="ml-auto grid size-6 place-items-center rounded-md text-content/45 outline-none hover:bg-content/5 hover:text-content/80 focus-visible:bg-content/7">
      <Plus className="size-3.5" strokeWidth={1.75} />
    </button>
  );
  return (
    <Section icon={Route} title="Relations" action={addButton}>
      {rows.length ? (
        <div>
          {rows.map(r => (
            <div key={`${r.label}:${r.issue.id}`} className="group/rel flex min-w-0 items-center">
              <span className="w-24 shrink-0 font-sans text-[12px] text-content/45">{r.label}</span>
              <div className="min-w-0 flex-1"><IssueLine issue={r.issue} /></div>
              <button type="button" aria-label={`Remove: ${r.label} ${r.issue.key}`} title="Remove" onClick={() => remove(r)}
                className="ml-1 grid size-6 shrink-0 place-items-center rounded-md text-content/40 opacity-0 outline-none hover:bg-content/5 hover:text-content/80 focus-visible:opacity-100 group-hover/rel:opacity-100">
                <X className="size-3" strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      ) : <p className="font-sans text-[12.5px] text-content/45">None. Blocks, related or duplicate issues show here.</p>}
      {adding ? (
        <Picker anchor={adding} label="Issue" width={340} current="" onClose={() => setAdding(null)} onPick={add}
          header={(
            <div role="radiogroup" aria-label="Relation" className="mb-1 flex gap-1">
              {RELATION_TYPES.map(t => (
                <button key={t.type} type="button" role="radio" aria-checked={type === t.type} onClick={() => setType(t.type)}
                  className={`h-6 flex-1 rounded-md font-sans text-[11.5px] outline-none ${type === t.type ? 'bg-selection text-content' : 'text-content/60 hover:bg-content/5'}`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          options={issues.filter(i => i.id !== issue.id && !issue.relations.some(r => r.type === type && r.issueId === i.id)).map(i => ({ value: i.id, label: `${i.key} ${i.title}`, icon: <StatusIcon status={i.status} /> }))} />
      ) : null}
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
  // The branch the issue records (an agent that started it), when the links name none.
  const git = links?.git && !links.git.branch && issue.branch ? { ...links.git, branch: { name: issue.branch } } : links?.git ?? (issue.branch ? { commits: [], branch: { name: issue.branch } } : undefined);
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
            <RefChip id={id} glyph={false} />
            <span className="truncate text-content/80">{byId.get(id)?.title ?? ''}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
