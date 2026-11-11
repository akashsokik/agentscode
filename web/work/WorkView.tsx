import { useMemo, useState, type ReactNode } from 'react';
import type { CleanupFolder, WorkBranch, WorkCommit, WorkMerge, WorkProject, WorkRef } from '../../shared/work.ts';
import { edgePath } from '../../shared/graph.ts';
import { agentLook, AVATAR_FILL } from '../../shared/avatar.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { open, openToSide, setRightView, useLayout } from '../layout.ts';
import { AlertCircle, ChevronsUpDown, GitBranch, Maximize2 } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { Popover } from '../mono/Popover.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { RefChip } from '../notes/RefChip.tsx';
import { WhoAvatar } from '../notes/parts.tsx';
import { attempt, useApp } from '../store.ts';
import { HeaderButton, Loading, MenuRow, PRIMARY } from '../ui/common.tsx';
import { PaneFrame, type PaneChrome } from '../panes/PaneFrame.tsx';
import { day, graphProject, loadWork, scoped, setWorkScope, toggleWorkRow, useWork, useWorkData } from './workData.ts';

/*
 * The Work view (ACH-D17), as in the approved demo: what each agent is working on, what was merged
 * into main and whether it is on GitHub, a graph of main and its open branches (ACH-D18), and cleanup. One-line rows (ACH-D8)
 * that open to their details; ID chips (ACH-D13); theme tokens only (ACH-D14); no shadows (ACH-D7);
 * branch lanes in their owner's avatar colour (ACH-D18). A right-panel tab and a full pane share these pieces.
 */

const STATE: Record<WorkBranch['state'], { dot: string; text: string }> = {
  working: { dot: 'bg-accent', text: 'text-content/70' },
  reviewing: { dot: 'bg-info', text: 'text-info' },
  approved: { dot: 'bg-success', text: 'text-success' },
  open: { dot: 'bg-content/30', text: 'text-content/45' },
};

function stateWords(b: WorkBranch): string {
  if (b.state === 'reviewing') return `${b.reviewer ?? 'Review'} reviewing`;
  if (b.state === 'approved') return 'approved';
  return b.state;
}

function State({ branch }: { branch: WorkBranch }) {
  const look = STATE[branch.state];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 text-[11.5px] ${look.text}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${look.dot}`} />
      {stateWords(branch)}
    </span>
  );
}

/** An agent's avatar by id, or a quiet initial for a name that is not an agent now. */
function Who({ id, name, size = 'size-4' }: { id?: string; name?: string; size?: string }) {
  return <WhoAvatar name={name ?? '?'} agentId={id} className={size} />;
}

function Label({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <h4 className="flex items-center justify-between px-1 pb-1 pt-3.5 font-sans text-[11px] font-medium uppercase tracking-[0.04em] text-content/40">
      <span>{children}</span>
      {count !== undefined ? <span className="font-normal normal-case tracking-normal text-content/35">{count}</span> : null}
    </h4>
  );
}

/** One line (ACH-D8); clicking opens the details under it. */
function Row({ rowKey, title, children }: { rowKey: string; title: string; children: ReactNode }) {
  const isOpen = useWork(s => s.open.has(rowKey));
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      title={title}
      onClick={() => toggleWorkRow(rowKey)}
      className={`flex h-[30px] w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-1.5 text-left font-sans text-[12px] transition-colors ${isOpen ? 'bg-selection' : 'hover:bg-content/5'}`}
    >
      {children}
    </button>
  );
}

function Details({ rows, chips }: { rows: [string, ReactNode][]; chips?: ReactNode }) {
  return (
    <div className="mb-2 ml-[30px] mt-0.5 font-sans">
      <dl className="grid grid-cols-[74px_minmax(0,1fr)] gap-y-px text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="flex min-h-[22px] items-center text-content/45">{k}</dt>
            <dd className="flex min-h-[22px] min-w-0 items-center gap-1.5 text-content/85">{v}</dd>
          </div>
        ))}
      </dl>
      {chips ? <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</div> : null}
    </div>
  );
}

function TaskChip({ conversationId, label = 'Task' }: { conversationId?: string; label?: string }) {
  if (!conversationId) return null;
  return (
    <button type="button" onClick={() => openToSide({ kind: 'comms', conversationId })} className="h-[18px] rounded-[5px] bg-content/7 px-1.5 text-[11px] text-content/60 hover:bg-content/12 hover:text-content">
      {label}
    </button>
  );
}

function OpenChat({ agentId }: { agentId?: string }) {
  const exists = useApp(s => Boolean(agentId && s.snapshot?.agents.some(a => a.id === agentId)));
  if (!agentId || !exists) return null;
  return <button type="button" onClick={() => open({ kind: 'agent', agentId })} className="ml-1 text-[var(--link-color)] hover:underline">Open chat</button>;
}

function BranchRow({ b, project, wide }: { b: WorkBranch; project: WorkProject; wide: boolean }) {
  const key = `b:${project.projectId}:${b.folder}`;
  const isOpen = useWork(s => s.open.has(key));
  const home = useApp(s => s.snapshot?.home);
  return (
    <>
      <Row rowKey={key} title={`${b.branch} in ${project.name}`}>
        <Who id={b.agentId} name={b.agentName} />
        <span className="min-w-0 truncate text-content/90">{b.branch}</span>
        {wide ? <span className="min-w-0 truncate text-content/40">{project.name}</span> : null}
        <span className="ml-auto shrink-0 font-mono text-[11.5px] tabular-nums text-content/45">↑{b.ahead}</span>
        <State branch={b} />
      </Row>
      {isOpen ? (
        <Details
          rows={[
            ['Branch', <span className="truncate font-mono text-[11.5px]">{b.branch}</span>],
            ['Agent', b.agentName ? <><Who id={b.agentId} name={b.agentName} size="size-3.5" />{b.agentName}<OpenChat agentId={b.agentId} /></> : <span className="text-content/45">Not known</span>],
            ['Project', project.name],
            ['Status', <State branch={b} />],
            ['vs main', <><span className="font-mono">↑{b.ahead} ↓{b.behind}</span><span className="text-content/45">{b.behind ? `${b.behind} behind ${project.defaultBranch}` : 'nothing to pull'}</span></>],
            ['Changes', b.changed || b.untracked ? `${b.changed + b.untracked} ${b.changed + b.untracked === 1 ? 'file' : 'files'}, uncommitted` : 'none uncommitted'],
            ['Folder', <span className="truncate text-content/45" title={b.folder}>{shortPath(b.folder, home)}{b.inPlace ? ' (in place)' : ''}</span>],
            ['Last', b.last ? <><span className="shrink-0 font-mono text-content/45">{b.last.hash}</span><span className="min-w-0 truncate">{b.last.subject}</span><span className="ml-auto shrink-0 text-content/35">{day(b.last.at)}</span></> : '-'],
          ]}
          chips={b.refs.length || b.conversationId ? <>{b.refs.map(id => <RefChip key={id} id={id} />)}<TaskChip conversationId={b.conversationId} /></> : undefined}
        />
      ) : null}
    </>
  );
}

function MergeRow({ m, project, wide }: { m: WorkMerge; project: WorkProject; wide: boolean }) {
  const key = `m:${project.projectId}:${m.originalHash}`;
  const isOpen = useWork(s => s.open.has(key));
  const who = m.names.join(', ');
  return (
    <>
      <Row rowKey={key} title={`${m.branch}, merged ${new Date(m.at).toLocaleString()}${m.reviewer ? `, reviewed by ${m.reviewer}` : ''}`}>
        <Who id={m.agentIds[0]} name={m.names[0]} />
        <span className="min-w-0 truncate text-content/90">{m.branch}</span>
        {/* Inside the row's button: an inert chip (its card on hover), not a second button. */}
        {wide && m.refs[0] ? <RefChip id={m.refs[0]} inert /> : null}
        <span className="ml-auto shrink-0 font-mono text-[11.5px] text-content/45">{m.hash ? m.hash.slice(0, 7) : 'rewritten'}</span>
        <span className="shrink-0 text-[11.5px] tabular-nums text-content/35">{day(m.at)}</span>
        {wide ? <span className="w-[150px] shrink-0 truncate text-right text-[11.5px] text-content/40">{m.reviewer ? `reviewed by ${m.reviewer}` : ''}</span> : null}
      </Row>
      {isOpen ? (
        <Details
          rows={[
            ['Merged', <>{new Date(m.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} into {project.defaultBranch}{m.hash ? <span className="font-mono text-content/45">{m.hash.slice(0, 7)}</span> : null}</>],
            ['By', who ? <><Who id={m.agentIds[0]} name={m.names[0]} size="size-3.5" />{who}<OpenChat agentId={m.agentIds[0]} /></> : <span className="text-content/45">Not recorded</span>],
            ['Review', m.reviewer ? `${m.reviewer}, approved` : <span className="text-content/45">Not recorded</span>],
            ['History', m.evidence.kind === 'backup' ? `rewritten; the original is kept in ${m.evidence.backup}` : m.rewritten ? (m.hash ? `rewritten; now ${m.hash.slice(0, 7)}, same files` : 'rewritten; its files are on main') : 'as merged'],
            ['GitHub', m.pushed === true ? <span className="text-success">pushed</span> : m.pushed === false ? 'not pushed yet' : <span className="text-content/45">not known</span>],
          ]}
          chips={m.refs.length || m.conversationId ? <>{m.refs.map(id => <RefChip key={id} id={id} />)}<TaskChip conversationId={m.conversationId} /></> : undefined}
        />
      ) : null}
    </>
  );
}

// ---- the graph (ACH-D18) ------------------------------------------------------------------------

const ROW_H = 24;
const LANE_W = 13;
const LANE_PAD = 8;

/** A lane's colour: main's neutral tone, else its owner's avatar colour (the app's palette, ACH-D14). */
function useLaneColour(project: WorkProject): (key: string | null) => string {
  const agents = useApp(s => s.snapshot?.agents);
  return useMemo(() => {
    const cache = new Map<string, string>();
    return (key: string | null) => {
      if (!key || key === 'main') return 'color-mix(in srgb, var(--color-content) 45%, transparent)';
      if (!cache.has(key)) {
        const id = project.laneOwners[key];
        const agent = agents?.find(a => a.id === id);
        // An owner who is not an agent now still gets a steady colour from its name.
        cache.set(key, AVATAR_FILL[agentLook(agent ?? { id: `lane:${key}` }).color]);
      }
      return cache.get(key)!;
    };
  }, [agents, project.laneOwners]);
}

function Lanes({ project }: { project: WorkProject }) {
  const colour = useLaneColour(project);
  const rows = project.graph.length;
  const width = LANE_PAD * 2 + Math.max(0, project.graphLanes - 1) * LANE_W;
  return (
    <svg aria-hidden width={width} height={rows * ROW_H} viewBox={`0 0 ${width} ${rows * ROW_H}`} className="pointer-events-none absolute left-0 top-0 overflow-visible">
      {project.graphEdges.map((e, i) => (
        <path key={i} d={edgePath(e, rows, LANE_W, ROW_H, LANE_PAD)} fill="none" stroke={colour(e.key)} strokeWidth={1.6} strokeLinecap="round" />
      ))}
      {project.graph.map((c, i) => (
        <circle key={c.hash} cx={LANE_PAD + c.lane * LANE_W} cy={i * ROW_H + ROW_H / 2} r={c.lane ? 3.6 : 3.8} fill={c.key === 'main' || !c.key ? 'color-mix(in srgb, var(--color-content) 60%, transparent)' : colour(c.key)} className="stroke-background-base" strokeWidth={1.5} />
      ))}
    </svg>
  );
}

function PillIcon({ kind }: { kind: 'branch' | 'globe' | 'tag' }) {
  const paths = {
    branch: <><circle cx="4.5" cy="3.5" r="1.6" /><circle cx="4.5" cy="12.5" r="1.6" /><circle cx="11.5" cy="5" r="1.6" /><path d="M4.5 5.1v5.8M11.5 6.6c0 3-3 3-7 4.3" /></>,
    globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>,
    tag: <><path d="M2.5 2.5h5.5l6 6-5.5 5.5-6-6Z" /><circle cx="5.5" cy="5.5" r="1" /></>,
  };
  return <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className="size-2.5 shrink-0">{paths[kind]}</svg>;
}

/** Ref pills (ACH-D18): local solid with a branch icon (and a globe when its GitHub copy is here too), GitHub dashed with a globe, tags filled. */
function Pill({ r }: { r: WorkRef }) {
  const base = 'mr-1.5 inline-flex h-[17px] items-center gap-[3px] rounded-[5px] px-[5px] align-[1px] font-mono text-[10.5px] font-medium';
  if (r.kind === 'local') {
    return (
      <span className={`${base} border border-content/20 text-content/85`} title={r.remote ? `${r.name}, also on GitHub as ${r.remote}` : r.name}>
        <PillIcon kind="branch" />{r.name}
        {r.remote ? <span className="ml-1 inline-flex text-content/55"><PillIcon kind="globe" /></span> : null}
      </span>
    );
  }
  if (r.kind === 'remote') return <span className={`${base} border border-dashed border-content/30 text-content/70`} title={`${r.name}, on GitHub`}><PillIcon kind="globe" />{r.name}</span>;
  return <span className={`${base} bg-content/7 text-content/70`}><PillIcon kind="tag" />{r.name}</span>;
}

/** In the panel, at most two pills and "+N"; the pane shows them all. */
function Pills({ refs, wide }: { refs: WorkRef[]; wide: boolean }) {
  const shown = wide || refs.length <= 2 ? refs : refs.slice(0, 2);
  const more = refs.length - shown.length;
  return (
    <>
      {shown.map(r => <Pill key={`${r.kind}:${r.name}`} r={r} />)}
      {more ? <span className="mr-1.5 align-[1px] font-mono text-[10.5px] text-content/45" title={refs.slice(2).map(r => r.remote ?? r.name).join(', ')}>+{more}</span> : null}
    </>
  );
}

function GraphLine({ c, wide, gutter }: { c: WorkCommit; wide: boolean; gutter: number }) {
  return (
    <div
      className="grid h-6 min-w-0 items-center gap-x-1.5 whitespace-nowrap font-sans text-[12px]"
      style={{ gridTemplateColumns: `${gutter}px 16px minmax(0,1fr) auto${wide ? ' auto' : ''}` }}
      title={`${c.hash.slice(0, 7)} ${c.subject}${c.reviewer ? `, reviewed by ${c.reviewer}` : ''}`}
    >
      <span />
      {c.names.length ? <Who id={c.agentIds[0]} name={c.names[0]} /> : <span />}
      <span className={`min-w-0 truncate ${c.head ? 'text-content' : 'text-content/85'}`}>
        {c.head ? <span title="Checked out (HEAD)" className="mr-1 inline-flex align-[-2px] text-content"><svg aria-hidden viewBox="0 0 16 16" className="size-[11px]" fill="none" stroke="currentColor" strokeWidth={2.4}><path d="m3 8.5 3 3 7-7" /></svg></span> : null}
        <Pills refs={c.refs} wide={wide} />
        {c.subject}
        {wide && c.names.length && c.lane === 0 ? <span className="text-content/40"> · {c.names.join(', ')}{c.reviewer ? `, reviewed by ${c.reviewer}` : ''}</span> : null}
      </span>
      {wide ? <span className="shrink-0 font-mono text-[11px] text-content/40">{c.hash.slice(0, 7)}</span> : null}
      <span className="shrink-0 text-[11px] tabular-nums text-content/35">{day(c.at)}</span>
    </div>
  );
}

function Lists({ projects, wide }: { projects: WorkProject[]; wide: boolean }) {
  const branches = projects.flatMap(p => p.inProgress.map(b => ({ b, p })));
  const local = projects.flatMap(p => p.merged.filter(m => m.pushed !== true).map(m => ({ m, p })));
  const pushed = projects.flatMap(p => p.merged.filter(m => m.pushed === true).map(m => ({ m, p }))).slice(0, 8);
  const notPushed = projects.reduce((n, p) => n + p.notPushed, 0);
  return (
    <>
      <Label count={branches.length}>In progress</Label>
      {branches.length ? branches.map(({ b, p }) => <BranchRow key={`${p.projectId}:${b.folder}`} b={b} project={p} wide={wide} />)
        : <p className="px-1.5 py-1 font-sans text-[12px] text-content/40">Nothing in progress.</p>}
      <Label count={local.length || undefined}>Merged, not on GitHub</Label>
      {notPushed ? (
        <div className="mb-0.5 flex h-8 items-center gap-2 overflow-hidden whitespace-nowrap rounded-lg bg-content/5 px-2 font-sans text-[12px]">
          <GitBranch aria-hidden className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
          <span className="shrink-0 text-content/85">{notPushed} {notPushed === 1 ? 'change' : 'changes'} on main</span>
          <span className="ml-auto min-w-0 truncate text-content/45">not pushed to GitHub</span>
        </div>
      ) : null}
      {local.length ? local.map(({ m, p }) => <MergeRow key={`${p.projectId}:${m.originalHash}`} m={m} project={p} wide={wide} />)
        : <p className="px-1.5 py-1 font-sans text-[12px] text-content/40">Everything merged is on GitHub.</p>}
      {pushed.length ? (
        <>
          <Label>On GitHub</Label>
          {pushed.map(({ m, p }) => <MergeRow key={`${p.projectId}:${m.originalHash}`} m={m} project={p} wide={wide} />)}
        </>
      ) : null}
    </>
  );
}

function Graph({ project, wide }: { project: WorkProject | undefined; wide: boolean }) {
  if (!project || !project.graph.length) return null;
  const gutter = LANE_PAD * 2 + Math.max(0, project.graphLanes - 1) * LANE_W - 6;
  return (
    <>
      <Label>Graph, {project.name}</Label>
      <div className="relative">
        <Lanes project={project} />
        {project.graph.map(c => <GraphLine key={c.hash} c={c} wide={wide} gutter={gutter} />)}
      </div>
    </>
  );
}

function CleanupRow({ projects }: { projects: WorkProject[] }) {
  const [dialog, setDialog] = useState(false);
  const branches = projects.reduce((n, p) => n + p.cleanup.branches.length, 0);
  const folders = projects.reduce((n, p) => n + p.cleanup.folders.length, 0);
  if (!branches && !folders) return null;
  return (
    <>
      <div className="mt-2.5 flex h-[34px] items-center gap-2 overflow-hidden whitespace-nowrap rounded-lg bg-content/5 px-2 font-sans text-[12.5px] text-content/70">
        <span className="min-w-0 truncate">{branches} merged {branches === 1 ? 'branch' : 'branches'}, {folders} leftover {folders === 1 ? 'folder' : 'folders'}</span>
        <button type="button" onClick={() => setDialog(true)} className="ml-auto shrink-0 text-[12px] text-[var(--link-color)] hover:underline">Review</button>
      </div>
      {dialog ? <CleanupDialog projects={projects.filter(p => p.cleanup.branches.length || p.cleanup.folders.length)} onClose={() => setDialog(false)} /> : null}
    </>
  );
}

function Box({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`grid size-3.5 shrink-0 place-items-center rounded-[4px] ${on ? 'bg-content text-background-base' : 'border border-content/30'} disabled:opacity-40`}
    >
      {on ? <svg aria-hidden viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={2.6}><path d="m3 8.5 3 3 7-7" /></svg> : null}
    </button>
  );
}

function folderNote(f: CleanupFolder): string {
  if (f.reason === 'missing') return 'folder already gone';
  const real = f.changes.changed + f.changes.untracked - f.changes.links;
  if (real) return `${real} ${real === 1 ? 'file' : 'files'} uncommitted`;
  // Ignored files git never saw (.env and the like) go with the folder: name them.
  if (f.changes.ignored.length) return `ignored: ${f.changes.ignored.slice(0, 2).join(', ')}${f.changes.ignored.length > 2 ? ` +${f.changes.ignored.length - 2}` : ''}`;
  if (f.changes.built) return 'clean (build output)';
  if (f.changes.links) return 'clean (a linked folder)';
  return f.reason === 'detached' ? 'detached, clean' : 'clean';
}

/**
 * The confirm list. Branches start ticked; folders start ticked unless they have uncommitted
 * changes, and ticking one of those asks again. Nothing is removed until Delete.
 */
function CleanupDialog({ projects, onClose }: { projects: WorkProject[]; onClose: () => void }) {
  const home = useApp(s => s.snapshot?.home);
  const [branches, setBranches] = useState(() => new Set(projects.flatMap(p => p.cleanup.branches.map(b => `${p.projectId}\n${b.name}`))));
  const [folders, setFolders] = useState(() => new Set(projects.flatMap(p => p.cleanup.folders.filter(f => !f.dirty).map(f => `${p.projectId}\n${f.path}`))));
  const [confirmDirty, setConfirmDirty] = useState<string | null>(null);
  const [forced, setForced] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const flip = (set: Set<string>, key: string, update: (next: Set<string>) => void) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); update(next); };
  const byRecord = projects.some(p => p.cleanup.branches.some(b => b.by === 'record'));
  const run = async (withFolders: boolean) => {
    setBusy(true);
    let removed = 0;
    let skipped = 0;
    for (const p of projects) {
      const pick = (set: Set<string>) => [...set].filter(k => k.startsWith(`${p.projectId}\n`)).map(k => k.slice(p.projectId.length + 1));
      const result = await attempt(() => api.workCleanup({ projectId: p.projectId, branches: pick(branches), folders: withFolders ? pick(folders) : [], forceFolders: withFolders ? pick(forced) : [] }));
      if (result) { removed += result.removed.branches.length + result.removed.folders.length; skipped += result.skipped.length; }
    }
    setBusy(false);
    await loadWork(true);
    setDone(`Removed ${removed}${skipped ? `; ${skipped} left as they were` : ''}.`);
  };
  const nBranches = branches.size;
  const nFolders = folders.size;
  return (
    <Modal
      title="Clean up merged work"
      description="Branches whose work is on main, and the folders agents made for them. Main, backup branches and folders in use are never listed."
      size="md"
      fitViewport
      onClose={onClose}
      footer={done ? <button type="button" className={PRIMARY} onClick={onClose}>Done</button> : (
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <SecondaryButton disabled={busy || !nBranches} onClick={() => void run(false)}>Delete {nBranches} {nBranches === 1 ? 'branch' : 'branches'} only</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || (!nBranches && !nFolders)} onClick={() => void run(true)}>{busy ? 'Removing…' : `Delete ${nBranches ? 'branches and ' : ''}${nFolders} ${nFolders === 1 ? 'folder' : 'folders'}`}</button>
        </>
      )}
    >
      <div className="px-4 pb-4 pt-1 font-sans">
        {done ? <p className="py-3 text-[13px] text-content/80">{done}</p> : projects.map(p => (
          <section key={p.projectId} className="pt-2">
            {projects.length > 1 ? <p className="pb-1 text-[12.5px] font-medium text-content">{p.name}</p> : null}
            {p.cleanup.branches.length ? (
              <>
                <Label count={`${p.cleanup.branches.length}${p.cleanup.branches.some(b => b.by === 'record' && b.evidence !== 'main') ? ', some merged by our records' : ''}`}>Branches</Label>
                {p.cleanup.branches.map(b => {
                  const key = `${p.projectId}\n${b.name}`;
                  return (
                    <div key={b.name} className="flex h-7 items-center gap-2 whitespace-nowrap text-[12px]">
                      <Box on={branches.has(key)} label={`Delete branch ${b.name}`} onToggle={() => flip(branches, key, setBranches)} />
                      <Who name={b.agentName} size="size-3.5" />
                      <span className="min-w-0 truncate font-mono text-[11.5px]">{b.name}</span>
                      <span className="ml-auto shrink-0 text-content/40" title={b.backup ? `Its commits stay in ${b.backup}` : undefined}>{b.inFolder ? 'goes with its folder' : b.backup ? `kept in ${b.backup}` : b.evidence === 'content' ? 'merged, history rewritten' : 'merged'}</span>
                    </div>
                  );
                })}
              </>
            ) : null}
            {p.cleanup.folders.length ? (
              <>
                <Label count={`${p.cleanup.folders.length}, need your OK`}>Folders</Label>
                {p.cleanup.folders.map(f => {
                  const key = `${p.projectId}\n${f.path}`;
                  const asking = confirmDirty === key;
                  return (
                    <div key={f.path}>
                      <div className="flex h-7 items-center gap-2 whitespace-nowrap text-[12px]">
                        <Box
                          on={folders.has(key)}
                          label={`Remove folder ${f.path}`}
                          onToggle={() => {
                            if (f.dirty && !folders.has(key)) { setConfirmDirty(key); return; }
                            flip(folders, key, setFolders);
                            if (f.dirty) flip(forced, key, setForced);
                          }}
                        />
                        <Who id={f.agentId} name={f.agentName} size="size-3.5" />
                        <span className="min-w-0 truncate font-mono text-[11.5px] text-content/70" title={f.path}>{shortPath(f.path, home)}</span>
                        <span className={`ml-auto shrink-0 ${f.dirty ? 'text-content/70' : 'text-content/40'}`}>{folderNote(f)}</span>
                      </div>
                      {asking ? (
                        <div className="mb-1 ml-6 flex items-center gap-2 rounded-md bg-content/5 px-2 py-1.5 text-[12px] text-content/70">
                          <span className="min-w-0 flex-1">Remove it with its uncommitted changes? They are lost.</span>
                          <SecondaryButton onClick={() => setConfirmDirty(null)}>Keep</SecondaryButton>
                          <SecondaryButton danger onClick={() => { flip(folders, key, setFolders); flip(forced, key, setForced); setConfirmDirty(null); }}>Remove anyway</SecondaryButton>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </>
            ) : null}
          </section>
        ))}
        {!done ? (
          <p className="mt-3 flex gap-2 rounded-lg bg-content/5 px-2.5 py-2 text-[12px] leading-normal text-content/60">
            <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span>
              {byRecord ? 'After a history rewrite, git no longer sees some of these branches as merged; AgentsCode knows from its merge and review records, so they wait for your OK here. ' : ''}
              Only merges with proof their work is on main are listed. Removing a folder deletes its files, ignored ones too (a linked node_modules is only unlinked), so it always waits for you; folders with uncommitted or ignored files ask twice. Nothing here is pushed, and main is never touched.
            </span>
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function Scope({ projects }: { projects: WorkProject[] }) {
  const scope = useWork(s => s.scope);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = projects.find(p => p.projectId === scope);
  return (
    <>
      <button type="button" aria-haspopup="listbox" aria-expanded={Boolean(anchor)} onClick={e => { const el = e.currentTarget; setAnchor(a => (a ? null : el)); }} className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 text-[13px] font-medium text-content hover:bg-content/5">
        <span className="truncate">{current?.name ?? 'All projects'}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
      </button>
      {anchor ? (
        <Popover anchor={anchor} side="bottom" align="start" width={240} onDismiss={() => setAnchor(null)} className="p-1.5">
          <div role="listbox" aria-label="Projects">
            <MenuRow selected={!scope} title="All projects" onSelect={() => { setAnchor(null); setWorkScope(null); }} />
            {projects.map(p => <MenuRow key={p.projectId} selected={scope === p.projectId} title={p.name} onSelect={() => { setAnchor(null); setWorkScope(p.projectId); }} />)}
          </div>
        </Popover>
      ) : null}
    </>
  );
}

function useScoped() {
  const view = useWork(s => s.view);
  const scope = useWork(s => s.scope);
  const all = view?.projects ?? [];
  const projects = useMemo(() => scoped(view, scope), [view, scope]);
  return { all, projects, graph: useMemo(() => graphProject(projects), [projects]) };
}

function Status() {
  const error = useWork(s => s.error);
  const view = useWork(s => s.view);
  if (error && !view) return <p className="p-3 font-sans text-[12px] text-danger">{error}</p>;
  if (!view) return <Loading className="px-3 py-4" />;
  return null;
}

/** The right panel's Work tab: lists, then the graph of main, then cleanup. */
export function WorkPanel() {
  useWorkData();
  const view = useWork(s => s.view);
  const { all, projects, graph } = useScoped();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 pl-2 pr-1.5 font-sans">
        <Scope projects={all} />
        <HeaderButton icon={Maximize2} label="Open Work as a pane" className="ml-auto" onClick={() => open({ kind: 'work' })} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {!view ? <Status /> : (
          <>
            <Lists projects={projects} wide={false} />
            <Graph project={graph} wide={false} />
            <CleanupRow projects={projects} />
          </>
        )}
      </div>
    </div>
  );
}

/** Work as a full pane: lists on the left, the graph on the right, side by side when there is room. */
export function WorkPane({ chrome }: { chrome: PaneChrome }) {
  useWorkData();
  const view = useWork(s => s.view);
  const layout = useLayout();
  const { all, projects, graph } = useScoped();
  return (
    <PaneFrame
      chrome={chrome}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <GitBranch aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="shrink-0 text-[13px] text-content">Work</span>
          <Scope projects={all} />
        </span>
      }
      actions={layout.rightPanel && layout.rightView === 'work' ? undefined : <HeaderButton icon={GitBranch} label="Open in the panel" onClick={() => setRightView('work')} />}
    >
      <div className="@container/work min-h-0 flex-1 overflow-y-auto">
        {!view ? <Status /> : (
          <div className="grid grid-cols-1 gap-7 px-7 py-4 @min-[52rem]/work:grid-cols-2">
            <div className="min-w-0">
              <Lists projects={projects} wide />
              <CleanupRow projects={projects} />
            </div>
            <div className="min-w-0"><Graph project={graph} wide /></div>
          </div>
        )}
      </div>
    </PaneFrame>
  );
}
