/**
 * The issue's properties beside it: Status, Priority, Assignee, Due date, Labels, Project,
 * Parent, Pull request and Created by, then Copy key. A property opens a picker (mono Popover)
 * with a search field; the current value shows by its selected fill only, never a check
 * (ACH-D46 option B). ↑ ↓ move, ⏎ picks, ⎋ closes. S, P, D and L open them from the view.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { ISSUE_PRIORITY_LABEL, ISSUE_STATUS_LABEL } from '../../../shared/issues.ts';
import type { IssuePriority, IssueStatus, SuperIssue } from '../../../shared/types.ts';
import { open } from '../../layout.ts';
import { Copy, Check, Folder } from '../../mono/icons.tsx';
import { Popover } from '../../mono/Popover.tsx';
import { useApp } from '../../store.ts';
import { AgentAvatar } from '../../ui/Avatar.tsx';
import { Kbd } from '../../ui/Kbd.tsx';
import { MenuRow, MenuRowRole } from '../../ui/common.tsx';
import { CalendarGlyph } from './CalendarGlyph.tsx';
import { PriorityGlyph, StatusGlyph } from './glyphs.tsx';
import { actorName, dueTone, matchesQuery, parseLabels, PRIORITY_OPTIONS, STATUS_OPTIONS } from './issueViewModel.ts';
import { WRITABLE, writeIssue } from './issueWrites.ts';

export interface PropertySidebarHandle { open(property: 'status' | 'priority' | 'due' | 'labels'): void }

interface Option { value: string; label: string; icon?: ReactNode }

/** A picker: a search field over its options, the current one filled. */
function Picker({ anchor, label, options, current, onPick, onClose }: { anchor: HTMLElement; label: string; options: Option[]; current: string; onPick: (value: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => options.filter(o => matchesQuery(o.label, query)), [options, query]);
  const [at, setAt] = useState(() => Math.max(0, options.findIndex(o => o.value === current)));
  useEffect(() => setAt(i => Math.min(i, Math.max(0, shown.length - 1))), [shown.length]);
  return (
    <Popover anchor={anchor} side="bottom" align="start" width={240} onDismiss={onClose} className="p-1.5">
      <input
        autoFocus
        aria-label={`Find a ${label.toLowerCase()}`}
        placeholder={`${label}…`}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => (i + 1) % Math.max(1, shown.length)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => (i - 1 + shown.length) % Math.max(1, shown.length)); }
          if (e.key === 'Enter' && shown[at]) { e.preventDefault(); onPick(shown[at].value); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
        className="mb-1 h-7 w-full rounded-md bg-content/5 px-2 font-sans text-[12px] text-content outline-none placeholder:text-content/40"
      />
      <div role="listbox" aria-label={label}>
        <MenuRowRole.Provider value="option">
          {shown.map((o, i) => (
            <MenuRow
              key={o.value}
              title={<span className="flex items-center gap-2">{o.icon}<span className="truncate">{o.label}</span></span>}
              // The current value by its fill only (ACH-D46 B); the keyboard row is filled too.
              highlighted={o.value === current || i === at}
              onSelect={() => onPick(o.value)}
            />
          ))}
          {!shown.length ? <p className="px-2 py-2 font-sans text-[12px] text-content/45">No matches</p> : null}
        </MenuRowRole.Provider>
      </div>
    </Popover>
  );
}

function Row({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-3 font-sans text-[12.5px]">
      <span className="w-24 shrink-0 text-content/45">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      {shortcut ? <Kbd spec={shortcut} quiet /> : null}
    </div>
  );
}

const VALUE = 'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 -mx-1.5 text-left text-content/85 outline-none transition-colors hover:bg-content/5 focus-visible:bg-content/7 disabled:cursor-default disabled:hover:bg-transparent';

export const PropertySidebar = forwardRef<PropertySidebarHandle, { issue: SuperIssue; issues: SuperIssue[] }>(function PropertySidebar({ issue, issues }, ref) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  const [menu, setMenu] = useState<{ kind: 'status' | 'priority' | 'project' | 'labels'; anchor: HTMLElement } | null>(null);
  const statusRef = useRef<HTMLButtonElement>(null);
  const priorityRef = useRef<HTMLButtonElement>(null);
  const labelsRef = useRef<HTMLButtonElement>(null);
  const dueRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  useImperativeHandle(ref, () => ({
    open(property) {
      if (property === 'due') { dueRef.current?.focus(); dueRef.current?.showPicker?.(); return; }
      const anchor = property === 'status' ? statusRef.current : property === 'priority' ? priorityRef.current : labelsRef.current;
      if (anchor) setMenu({ kind: property, anchor });
    },
  }));
  const agent = issue.agentId ? agents.find(a => a.id === issue.agentId) : undefined;
  const project = projects.find(p => p.id === issue.projectId);
  const parent = issue.parentId ? issues.find(i => i.id === issue.parentId) : undefined;
  const created = issue.activity?.find(e => e.kind === 'created');
  const creator = created ? actorName(created.by, id => agents.find(a => a.id === id)?.name) : issue.by === 'user' ? 'You' : 'SuperAgent';
  const due = dueTone(issue.dueDate, issue.status, new Date());
  const save = (patch: Parameters<typeof writeIssue>[1]) => { setMenu(null); void writeIssue(issue.id, patch); };
  const notYet = 'Changed from here once the issue API takes it; agents and the SuperAgent set it today.';
  return (
    <aside aria-label="Properties" className="flex flex-col gap-0.5 font-sans">
      <Row label="Status" shortcut="S">
        <button ref={statusRef} type="button" className={VALUE} aria-haspopup="listbox" onClick={e => setMenu({ kind: 'status', anchor: e.currentTarget })}>
          <StatusGlyph status={issue.status} /><span className="truncate">{ISSUE_STATUS_LABEL[issue.status]}</span>
        </button>
      </Row>
      <Row label="Priority" shortcut="P">
        <button ref={priorityRef} type="button" className={VALUE} aria-haspopup="listbox" onClick={e => setMenu({ kind: 'priority', anchor: e.currentTarget })}>
          <PriorityGlyph priority={issue.priority} /><span className="truncate">{ISSUE_PRIORITY_LABEL[issue.priority]}</span>
        </button>
      </Row>
      <Row label="Assignee">
        <button type="button" className={VALUE} disabled={!WRITABLE.assignee} title={WRITABLE.assignee ? undefined : notYet}>
          {agent ? <><AgentAvatar agent={agent} animate={false} className="size-4" /><span className="truncate">{agent.name}</span></>
            : issue.forUser ? <span className="truncate">You</span> : <span className="text-content/45">Unassigned</span>}
        </button>
      </Row>
      <Row label="Due date" shortcut="D">
        <label className={`${VALUE} relative cursor-pointer`}>
          <CalendarGlyph className={due?.tone === 'danger' ? 'text-danger' : due?.tone === 'warning' ? 'text-warning' : 'text-content/50'} />
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${due?.tone === 'danger' ? 'text-danger' : due?.tone === 'warning' ? 'text-warning' : issue.dueDate ? 'text-content/85' : 'text-content/45'}`}>{due?.text ?? 'Set due date'}</span>
          <input
            ref={dueRef}
            type="date"
            aria-label="Due date"
            value={issue.dueDate ?? ''}
            onChange={e => save({ dueDate: e.target.value || null })}
            // ACH-D46 date A: the native picker, dark, opened from our row; the field itself stays
            // invisible over the row so the date reads in words ("Today, 13 Nov") rather than 13/11/2026.
            onClick={e => { try { e.currentTarget.showPicker?.(); } catch { /* not allowed here */ } }}
            className="absolute inset-0 cursor-pointer opacity-0 [color-scheme:light] dark:[color-scheme:dark]"
          />
        </label>
      </Row>
      <Row label="Labels" shortcut="L">
        <button ref={labelsRef} type="button" className={`${VALUE} flex-wrap`} onClick={e => setMenu({ kind: 'labels', anchor: e.currentTarget })}>
          {issue.labels.length ? issue.labels.map(l => <span key={l} className="rounded-full border border-content/12 px-1.5 text-[11.5px] leading-[18px] text-content/75">{l}</span>) : <span className="text-content/45">Add labels</span>}
        </button>
      </Row>
      <Row label="Project">
        <button type="button" className={VALUE} aria-haspopup="listbox" onClick={e => setMenu({ kind: 'project', anchor: e.currentTarget })}>
          <Folder className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} /><span className="truncate">{project?.name ?? 'No project'}</span>
        </button>
      </Row>
      <Row label="Parent">
        {parent ? (
          <button type="button" className={VALUE} onClick={() => open({ kind: 'issue', issueId: parent.id })} title={parent.title}>
            <StatusGlyph status={parent.status} /><span className="shrink-0 text-content/45">{parent.key}</span><span className="truncate">{parent.title}</span>
          </button>
        ) : <span className="px-0 text-content/45" title={WRITABLE.parent ? undefined : notYet}>None</span>}
      </Row>
      <Row label="Pull request">
        <span className="truncate text-content/45" title={`A pull request whose branch, title or body names ${issue.key} links here.`}>None yet</span>
      </Row>
      <Row label="Created by"><span className="truncate text-content/75">{creator}{created ? `, ${new Date(created.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span></Row>
      <div className="my-2 border-t border-content/7" />
      <Row label="Copy key">
        <button type="button" className={VALUE} onClick={() => void navigator.clipboard?.writeText(issue.key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} aria-label={`Copy ${issue.key}`}>
          <span className="font-mono text-[12px]">{issue.key}</span>
          {copied ? <Check className="size-3 text-success" strokeWidth={2} /> : <Copy className="size-3 text-content/45" strokeWidth={1.75} />}
        </button>
      </Row>
      {menu?.kind === 'status' ? <Picker anchor={menu.anchor} label="Status" current={issue.status} onClose={() => setMenu(null)}
        options={STATUS_OPTIONS.map(s => ({ value: s, label: ISSUE_STATUS_LABEL[s], icon: <StatusGlyph status={s} /> }))} onPick={v => save({ status: v as IssueStatus })} /> : null}
      {menu?.kind === 'priority' ? <Picker anchor={menu.anchor} label="Priority" current={issue.priority} onClose={() => setMenu(null)}
        options={PRIORITY_OPTIONS.map(p => ({ value: p, label: ISSUE_PRIORITY_LABEL[p], icon: <PriorityGlyph priority={p} /> }))} onPick={v => save({ priority: v as IssuePriority })} /> : null}
      {menu?.kind === 'project' ? <Picker anchor={menu.anchor} label="Project" current={issue.projectId ?? ''} onClose={() => setMenu(null)}
        options={[{ value: '', label: 'No project' }, ...projects.map(p => ({ value: p.id, label: p.name }))]} onPick={v => save({ projectId: v || null })} /> : null}
      {menu?.kind === 'labels' ? <LabelsEditor anchor={menu.anchor} labels={issue.labels} onClose={() => setMenu(null)} onSave={labels => save({ labels })} /> : null}
    </aside>
  );
});

/** Labels as text, one per comma or line: ⏎ saves, ⎋ closes. */
function LabelsEditor({ anchor, labels, onSave, onClose }: { anchor: HTMLElement; labels: string[]; onSave: (labels: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState(labels.join(', '));
  return (
    <Popover anchor={anchor} side="bottom" align="start" width={260} onDismiss={onClose} className="p-2">
      <input
        autoFocus
        aria-label="Labels, separated by commas"
        value={text}
        placeholder="ui, issues"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); onSave(parseLabels(text)); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
        className="h-7 w-full rounded-md bg-content/5 px-2 font-sans text-[12px] text-content outline-none placeholder:text-content/40"
      />
      <p className="mt-1.5 flex items-center gap-1 font-sans text-[11px] text-content/45">Separate with commas. <Kbd spec="Enter" quiet /> save</p>
    </Popover>
  );
}
