import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkBranch, WorkMerge, WorkProject, WorkTab, WorkTarget } from '../../shared/work.ts';
import { currentProjectId, open, setProject, setRightView, useLayout } from '../layout.ts';
import { CheckCircle, ChevronsUpDown, Folder, GitBranch, ListBullet, Maximize2, RefreshCw } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { useApp } from '../store.ts';
import { Empty, HeaderButton, IconTab, Loading, MenuRow, TextButton } from '../ui/common.tsx';
import { CleanupRow } from './WorkCleanup.tsx';
import { WorkDetails } from './WorkDetails.tsx';
import { WorkGraph } from './WorkGraph.tsx';
import { BranchState, branchState, MergeState, targetKey, WorkRow, WorkOwnerLabel } from './WorkParts.tsx';
import { day, DEFAULT_WORK_UI, loadWork, setWorkUi, useWork, useWorkData } from './workData.ts';
import { mergeGroups, selectedWork } from './workModel.ts';
import { workIdentity } from './workPresentation.ts';

// ACH-D19/D23/D24: current project, graph-first tabs and one selected-item inspector.
// The existing MonoCode components, graph, cleanup confirmation and diff renderer are reused.
const TABS = [{ id: 'graph', label: 'Graph', icon: GitBranch }, { id: 'active', label: 'Active', icon: ListBullet }, { id: 'merged', label: 'Merged', icon: CheckCircle }] as const;

function Scope({ project, projects }: { project?: WorkProject; projects: WorkProject[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return <>
    <button type="button" aria-label="Work project" aria-haspopup="listbox" aria-expanded={Boolean(anchor)} onClick={e => { const el = e.currentTarget; setAnchor(a => a ? null : el); }} className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-[13px] font-medium text-content hover:bg-content/5">
      <Folder className="size-3.5 shrink-0 text-content/45" /><span className="truncate">{project?.name ?? 'Choose a project'}</span><ChevronsUpDown className="size-3.5 shrink-0 text-content/45" />
    </button>
    {anchor ? <Popover anchor={anchor} side="bottom" align="start" width={240} onDismiss={() => setAnchor(null)} className="p-1.5"><div role="listbox" aria-label="Work project">{projects.map(p => <MenuRow key={p.projectId} selected={p.projectId === project?.projectId} title={p.name} onSelect={() => { setAnchor(null); setProject(p.projectId); }} />)}</div></Popover> : null}
  </>;
}

function useProject() {
  const layout = useLayout(), view = useWork(s => s.view), live = useApp(s => s.snapshot?.projects);
  const all = view?.projects ?? [];
  const id = currentProjectId(layout, live?.map(p => p.id) ?? all.map(p => p.projectId));
  return { all, project: all.find(p => p.projectId === id), view };
}

function BranchRows({ branches, selected, onSelect }: { branches: WorkBranch[]; selected: WorkTarget | null; onSelect: (target: WorkTarget) => void }) {
  return <>{branches.map(b => <WorkRow key={b.folder} target={{ kind: 'branch', id: b.folder }} selected={selected?.kind === 'branch' && selected.id === b.folder} onSelect={onSelect} title={`${b.branch}, ${b.agentName ?? 'no owner'}, ${branchState(b)}`}>
    <WorkOwnerLabel id={b.agentId} name={b.agentName} /><span className="min-w-0 flex-1 truncate text-content/90" title={b.last?.subject}>{b.branch}</span><BranchState branch={b} />
  </WorkRow>)}</>;
}

function MergeRows({ merges, selected, onSelect, remote }: { merges: WorkMerge[]; selected: WorkTarget | null; onSelect: (target: WorkTarget) => void; remote: string }) {
  return <>{merges.map(m => <WorkRow key={m.originalHash} target={{ kind: 'merge', id: m.originalHash }} selected={selected?.kind === 'merge' && selected.id === m.originalHash} onSelect={onSelect} title={`${m.branch}, ${m.names.join(', ') || 'owner not recorded'}, ${remote}`}>
    <WorkOwnerLabel {...workIdentity(m)} /><span className="min-w-0 flex-1 truncate text-content/90">{m.branch}</span><MergeState merge={m} />
  </WorkRow>)}</>;
}

/** Exported separately so a standalone preview can exercise the actual view with fixture data. */
export function WorkBody({ project, wide, at }: { project: WorkProject; wide: boolean; at: number }) {
  const ui = useWork(s => s.ui[project.projectId] ?? DEFAULT_WORK_UI);
  const area = useRef<HTMLDivElement>(null), focusRequest = useRef<'detail' | string | null>(null);
  const [split, setSplit] = useState(false);
  const item = selectedWork(project, ui.selected);
  const groups = mergeGroups(project);
  const known = project.inProgress.filter(b => b.agentId || b.agentName), other = project.inProgress.filter(b => !b.agentId && !b.agentName);
  const select = (target: WorkTarget) => { focusRequest.current = 'detail'; setWorkUi(project.projectId, { selected: target }); };
  const back = () => { focusRequest.current = ui.selected ? targetKey(ui.selected) : null; setWorkUi(project.projectId, { selected: null }); };
  const pickTab = (tab: WorkTab) => setWorkUi(project.projectId, { tab, selected: null });
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const resize = () => setSplit(wide && el.clientWidth >= 700);
    resize(); const observer = new ResizeObserver(resize); observer.observe(el); return () => observer.disconnect();
  }, [wide]);
  useLayoutEffect(() => {
    if (focusRequest.current === 'detail') area.current?.querySelector<HTMLElement>('[data-work-heading]')?.focus();
    else if (focusRequest.current) Array.from(area.current?.querySelectorAll<HTMLButtonElement>('[data-work-row]') ?? []).find(el => el.dataset.workRow === focusRequest.current)?.focus();
    focusRequest.current = null;
  }, [ui.selected]);
  const onTabsKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex(t => t.id === ui.tab);
    const next = e.key === 'ArrowRight' ? (index + 1) % TABS.length : e.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault(); pickTab(TABS[next].id); e.currentTarget.querySelector<HTMLButtonElement>(`[data-work-tab="${TABS[next].id}"]`)?.focus();
  };
  return <div ref={area} className="flex min-h-0 flex-1 flex-col" onKeyDown={e => { if (e.key === 'Escape' && ui.selected) { e.stopPropagation(); back(); } }}>
    <div role="tablist" aria-label="Work views" onKeyDown={onTabsKey} className="flex shrink-0 items-center gap-0.5 px-2 pb-2">{TABS.map(t => <IconTab key={t.id} data-work-tab={t.id} role="tab" aria-selected={ui.tab === t.id} tabIndex={ui.tab === t.id ? 0 : -1} icon={t.icon} label={t.label} selected={ui.tab === t.id} labelled onClick={() => pickTab(t.id)} />)}</div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
      <div role="tabpanel" aria-label={TABS.find(t => t.id === ui.tab)!.label} className="grid items-start gap-7" style={{ gridTemplateColumns: split ? 'minmax(0, 1.45fr) minmax(260px, 1fr)' : 'minmax(0, 1fr)' }}>
        {!ui.selected || split ? <section aria-label="Work list" className="min-w-0">
          {ui.tab === 'graph' ? project.graph.length ? <WorkGraph project={project} wide={split} selected={ui.selected} onSelect={select} /> : <Empty title="No commits yet">This project has no commit history to show.</Empty>
            : ui.tab === 'active' ? <><div className="flex h-8 items-center justify-between px-1.5 text-[11px] text-content/50"><span>Open branches</span><span>{known.length}</span></div>{known.length ? <BranchRows branches={known} selected={ui.selected} onSelect={select} /> : <p className="px-1.5 py-2 text-[12px] text-content/50">No active agent branches.</p>}{other.length ? <details open={ui.otherOpen} onToggle={e => setWorkUi(project.projectId, { otherOpen: e.currentTarget.open })} className="mt-5 text-[12px] text-content/55"><summary className="cursor-pointer px-1.5 py-1">Other worktrees ({other.length})</summary><BranchRows branches={other} selected={ui.selected} onSelect={select} /></details> : null}</>
            : <><div className="flex h-8 items-center justify-between px-1.5 text-[11px] text-content/50"><span>On local {project.defaultBranch}</span><span>{project.remote ? `${project.notPushed} local ${project.notPushed === 1 ? 'commit' : 'commits'}` : 'Remote unknown'}</span></div><MergeRows merges={groups.local} selected={ui.selected} onSelect={select} remote="Local only" />{!groups.local.length ? <p className="px-1.5 py-2 text-[12px] text-content/50">No recorded merges confirmed local-only.</p> : null}<p className="px-1.5 pt-3 text-[11px] text-content/55">Remote status is based on local remote refs, not a live GitHub check.</p>
              {groups.unknown.length ? <details open={ui.unknownOpen} onToggle={e => setWorkUi(project.projectId, { unknownOpen: e.currentTarget.open })} className="mt-5 text-[12px] text-content/55"><summary className="cursor-pointer px-1.5 py-1">Remote status unknown ({groups.unknown.length})</summary><MergeRows merges={groups.unknown} selected={ui.selected} onSelect={select} remote="Unknown" /></details> : null}
              {groups.pushed.length ? <details open={ui.pushedOpen} onToggle={e => setWorkUi(project.projectId, { pushedOpen: e.currentTarget.open })} className="mt-5 text-[12px] text-content/55"><summary className="cursor-pointer px-1.5 py-1">On remote at last check ({groups.pushed.length})</summary><MergeRows merges={groups.pushed} selected={ui.selected} onSelect={select} remote="On remote" /></details> : null}
            </>}
        </section> : null}
        {item && ui.selected ? <WorkDetails key={targetKey(ui.selected)} project={project} target={ui.selected} item={item} wide={split} at={at} onBack={back} /> : ui.selected ? <Empty title="This item is no longer in Work" action={<TextButton onClick={back}>Back to Work</TextButton>}>Its branch or history may have changed.</Empty> : split ? <Empty title="Select a branch or commit">Its owner, review and changed files appear here.</Empty> : null}
      </div>
    </div>
    <footer className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-[10.5px] text-content/50"><span title="Refreshing Work does not fetch from the remote">{!project.remote ? 'Remote status unavailable' : project.fetchedAt ? `Remote fetched ${day(project.fetchedAt)}` : 'Remote: last fetch unknown'}</span><CleanupRow projects={[project]} /></footer>
  </div>;
}

function Content({ project, wide, at }: { project?: WorkProject; wide: boolean; at: number }) {
  const view = useWork(s => s.view), error = useWork(s => s.error);
  if (!view) return error ? <p role="status" className="p-3 text-[12px] text-danger">{error}<TextButton onClick={() => void loadWork(true)}>Retry</TextButton></p> : <Loading className="px-3 py-4" />;
  if (!project) return <Empty title="Choose a project">Work shows one project at a time.</Empty>;
  if (project.error) return <Empty title="Could not read this project" action={<TextButton onClick={() => void loadWork(true)}>Retry</TextButton>}>{project.error}</Empty>;
  if (!project.defaultBranch) return <Empty title="Not a Git repository">This project has no Git history to show.</Empty>;
  return <>{error ? <p role="status" className="px-3 py-1 text-[11px] text-danger">Refresh failed; showing the previous snapshot. <TextButton onClick={() => void loadWork(true)}>Retry</TextButton></p> : null}<WorkBody key={project.projectId} project={project} wide={wide} at={at} /></>;
}

export function WorkPanel() {
  useWorkData(); const { all, project, view } = useProject(); const loading = useWork(s => s.loading);
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex h-10 shrink-0 items-center gap-1 pl-2 pr-1.5"><Scope project={project} projects={all} /><HeaderButton icon={RefreshCw} label="Refresh Work" className="ml-auto" disabled={loading} onClick={() => void loadWork(true)} /><HeaderButton icon={Maximize2} label="Open Work as a pane" onClick={() => open({ kind: 'work' })} /></div><Content project={project} wide={false} at={view?.at ?? 0} /></div>;
}

export function WorkPane({ chrome }: { chrome: PaneChrome }) {
  useWorkData(); const { all, project, view } = useProject(); const layout = useLayout(); const loading = useWork(s => s.loading);
  return <PaneFrame chrome={chrome} title={<span className="flex min-w-0 items-center gap-2"><GitBranch className="size-3.5 shrink-0" /><span className="text-[13px]">Work</span><Scope project={project} projects={all} /></span>} actions={<><HeaderButton icon={RefreshCw} label="Refresh Work" disabled={loading} onClick={() => void loadWork(true)} />{layout.rightPanel && layout.rightView === 'work' ? null : <HeaderButton icon={GitBranch} label="Open in the panel" onClick={() => setRightView('work')} />}</>}><div className="flex min-h-0 flex-1 flex-col pt-2"><Content project={project} wide at={view?.at ?? 0} /></div></PaneFrame>;
}
