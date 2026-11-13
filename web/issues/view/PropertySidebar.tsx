/**
 * The issue's properties beside it: Status, Priority, Assignee, Due date, Labels, Project,
 * Parent, Pull request and Created by, then Copy key. A property opens a picker (mono Popover)
 * with a search field; the current value shows by its selected fill only, never a check
 * (ACH-D46 option B). ↑ ↓ move, ⏎ picks, ⎋ closes. S, P, D and L open them from the view.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { ISSUE_PRIORITY_LABEL, ISSUE_STATUS_LABEL } from '../../../shared/issues.ts';
import type { IssuePriority, IssueStatus, SuperIssue } from '../../../shared/types.ts';
import { Copy, Check, Folder } from '../../mono/icons.tsx';
import { Popover } from '../../mono/Popover.tsx';
import { useApp } from '../../store.ts';
import { AgentAvatar } from '../../ui/Avatar.tsx';
import { Kbd } from '../../ui/Kbd.tsx';
import { CalendarGlyph } from './CalendarGlyph.tsx';
import { Picker, useFocusWhenPlaced } from './Picker.tsx';
import { actorName, assigneeOf, commitEdit, parentCandidates, dueToSave, dueTone, parseLabels, PRIORITY_OPTIONS, STATUS_OPTIONS } from './issueViewModel.ts';
import { writeIssue } from './issueWrites.ts';
import { StatusIcon, PriorityIcon } from '../issueParts.tsx';

export interface PropertySidebarHandle { open(property: 'status' | 'priority' | 'due' | 'labels'): void }

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

export const PropertySidebar = forwardRef<PropertySidebarHandle, {
  issue: SuperIssue;
  issues: SuperIssue[];
  /** The Copy key row; the Issues page's detail has it in its bar instead (ACH-23). */
  copyKey?: boolean;
}>(function PropertySidebar({ issue, issues, copyKey = true }, ref) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const projects = useApp(s => s.snapshot?.projects) ?? [];
  type MenuKind = 'status' | 'priority' | 'project' | 'labels' | 'assignee' | 'parent';
  const [menu, setMenuState] = useState<{ kind: MenuKind; anchor: HTMLElement } | null>(null);
  // What had focus when a picker opened (its row, or the list's card for S/P/L there): it gets
  // focus back when the picker closes or picks, so the keys keep working (the Popover leaves it).
  const opener = useRef<HTMLElement | null>(null);
  const setMenu = (next: { kind: MenuKind; anchor: HTMLElement } | null) => {
    if (next) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : next.anchor;
    } else if (menu) {
      const back = opener.current?.isConnected ? opener.current : menu.anchor;
      requestAnimationFrame(() => { if (back.isConnected) back.focus({ preventScroll: true }); });
    }
    setMenuState(next);
  };
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
  const [dueDraft, setDueDraft] = useState(issue.dueDate ?? '');
  useEffect(() => setDueDraft(issue.dueDate ?? ''), [issue.dueDate]);
  const saveDue = () => {
    void commitEdit(dueToSave(dueDraft, issue.dueDate), dueDate => writeIssue(issue.id, { dueDate })).then(r => { if (r === 'reverted') setDueDraft(issue.dueDate ?? ''); });
  };
  // What the row reads: the day being picked while the field is open, else the stored one.
  const shownDue = dueDraft === '' ? undefined : /^2\d{3}-\d{2}-\d{2}$/.test(dueDraft) ? dueDraft : issue.dueDate;
  const due = dueTone(shownDue, issue.status, new Date());
  const save = (patch: Parameters<typeof writeIssue>[1]) => { setMenu(null); void writeIssue(issue.id, patch); };
  return (
    <aside aria-label="Properties" className="flex flex-col gap-0.5 font-sans">
      <Row label="Status" shortcut="S">
        <button ref={statusRef} type="button" className={VALUE} aria-haspopup="listbox" onClick={e => setMenu({ kind: 'status', anchor: e.currentTarget })}>
          <StatusIcon status={issue.status} /><span className="truncate">{ISSUE_STATUS_LABEL[issue.status]}</span>
        </button>
      </Row>
      <Row label="Priority" shortcut="P">
        <button ref={priorityRef} type="button" className={VALUE} aria-haspopup="listbox" onClick={e => setMenu({ kind: 'priority', anchor: e.currentTarget })}>
          <PriorityIcon priority={issue.priority} /><span className="truncate">{ISSUE_PRIORITY_LABEL[issue.priority]}</span>
        </button>
      </Row>
      <Row label="Assignee">
        <button type="button" className={VALUE} aria-haspopup="listbox" onClick={e => setMenu({ kind: 'assignee', anchor: e.currentTarget })}>
          {agent ? <><AgentAvatar agent={agent} animate={false} className="size-4" /><span className="truncate">{agent.name}</span></>
            : issue.forUser ? <span className="truncate">You</span> : <span className="text-content/45">Unassigned</span>}
        </button>
      </Row>
      <Row label="Due date" shortcut="D">
        <label className={`${VALUE} relative cursor-pointer`}>
          <CalendarGlyph className={due?.tone === 'danger' ? 'text-danger' : due?.tone === 'warning' ? 'text-warning' : 'text-content/50'} />
          <span className={`min-w-0 flex-1 truncate text-[12.5px] ${due?.tone === 'danger' ? 'text-danger' : due?.tone === 'warning' ? 'text-warning' : shownDue ? 'text-content/85' : 'text-content/45'}`}>{due?.text ?? 'Set due date'}</span>
          <input
            ref={dueRef}
            type="date"
            aria-label="Due date"
            value={dueDraft}
            // Saved when the field is left (or Enter), never per keystroke: a year typed by hand
            // passes through days like 0002-11-13, which would each be refused with a toast.
            onChange={e => setDueDraft(e.target.value)}
            onBlur={() => saveDue()}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDueDraft(issue.dueDate ?? ''); const el = e.currentTarget; requestAnimationFrame(() => el.blur()); }
            }}
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
        <button type="button" className={VALUE} aria-haspopup="listbox" title={parent?.title} onClick={e => setMenu({ kind: 'parent', anchor: e.currentTarget })}>
          {parent ? <><StatusIcon status={parent.status} /><span className="shrink-0 text-content/45">{parent.key}</span><span className="truncate">{parent.title}</span></> : <span className="text-content/45">None</span>}
        </button>
      </Row>
      <Row label="Pull request">
        <span className="truncate text-content/45" title={`A pull request whose branch, title or body names ${issue.key} links here.`}>None yet</span>
      </Row>
      <Row label="Created by"><span className="truncate text-content/75">{creator}{created ? `, ${new Date(created.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span></Row>
      {copyKey ? <>
      <div className="my-2 border-t border-content/7" />
      <Row label="Copy key">
        <button type="button" className={VALUE} onClick={() => void navigator.clipboard?.writeText(issue.key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })} aria-label={`Copy ${issue.key}`}>
          <span className="font-mono text-[12px]">{issue.key}</span>
          {copied ? <Check className="size-3 text-success" strokeWidth={2} /> : <Copy className="size-3 text-content/45" strokeWidth={1.75} />}
        </button>
      </Row>
      </> : null}
      {menu?.kind === 'status' ? <Picker anchor={menu.anchor} label="Status" current={issue.status} onClose={() => setMenu(null)}
        options={STATUS_OPTIONS.map(s => ({ value: s, label: ISSUE_STATUS_LABEL[s], icon: <StatusIcon status={s} /> }))} onPick={v => save({ status: v as IssueStatus })} /> : null}
      {menu?.kind === 'priority' ? <Picker anchor={menu.anchor} label="Priority" current={issue.priority} onClose={() => setMenu(null)}
        options={PRIORITY_OPTIONS.map(p => ({ value: p, label: ISSUE_PRIORITY_LABEL[p], icon: <PriorityIcon priority={p} /> }))} onPick={v => save({ priority: v as IssuePriority })} /> : null}
      {menu?.kind === 'project' ? <Picker anchor={menu.anchor} label="Project" current={issue.projectId ?? ''} onClose={() => setMenu(null)}
        options={[{ value: '', label: 'No project' }, ...projects.map(p => ({ value: p.id, label: p.name }))]} onPick={v => save({ projectId: v || null })} /> : null}
      {menu?.kind === 'assignee' ? <Picker anchor={menu.anchor} label="Assignee" current={assigneeOf(issue)} onClose={() => setMenu(null)}
        options={[
          { value: 'none', label: 'Unassigned' },
          { value: 'user', label: 'You' },
          ...agents.filter(a => a.role !== 'super').map(a => ({ value: a.id, label: a.name, icon: <AgentAvatar agent={a} animate={false} className="size-4" /> })),
        ]}
        onPick={v => save({ assignee: v === 'none' ? null : v })} /> : null}
      {menu?.kind === 'parent' ? <Picker anchor={menu.anchor} label="Parent" width={320} current={issue.parentId ?? 'none'} onClose={() => setMenu(null)}
        options={[{ value: 'none', label: 'No parent' }, ...parentCandidates(issues, issue).map(i => ({ value: i.id, label: `${i.key} ${i.title}`, icon: <StatusIcon status={i.status} /> }))]}
        onPick={v => save({ parentId: v === 'none' ? null : v })} /> : null}
      {menu?.kind === 'labels' ? <LabelsEditor anchor={menu.anchor} labels={issue.labels} onClose={() => setMenu(null)} onSave={labels => save({ labels })} /> : null}
    </aside>
  );
});

/** Labels as text, one per comma or line: ⏎ saves, ⎋ closes. */
function LabelsEditor({ anchor, labels, onSave, onClose }: { anchor: HTMLElement; labels: string[]; onSave: (labels: string[]) => void; onClose: () => void }) {
  const [text, setText] = useState(labels.join(', '));
  const field = useRef<HTMLInputElement>(null);
  useFocusWhenPlaced(field);
  return (
    <Popover anchor={anchor} side="bottom" align="start" width={260} onDismiss={onClose} className="p-2">
      <input
        ref={field}
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
