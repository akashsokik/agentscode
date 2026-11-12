import { useMemo } from 'react';
import type { WorkProject, WorkRef, WorkTarget } from '../../shared/work.ts';
import { edgePath } from '../../shared/graph.ts';
import { Check } from '../mono/icons.tsx';
import { useApp } from '../store.ts';
import { day } from './workData.ts';
import { BranchState, MergeState, WorkOwnerLabel, WorkRow, WorkWho as Who } from './WorkParts.tsx';
import { branchStatus, commitIdentity, mergeStatus, refWork, workIdentity, workOwner } from './workPresentation.ts';

const ROW_H = 30;
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
        cache.set(key, workOwner(agents ?? [], id, key).colour ?? 'color-mix(in srgb, var(--color-content) 45%, transparent)');
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
function Pill({ r, project }: { r: WorkRef; project: WorkProject }) {
  const agents = useApp(s => s.snapshot?.agents);
  const identity = workIdentity(refWork(project, r));
  const owner = workOwner(agents ?? [], identity.id, identity.name);
  const ownedBranch = r.kind !== 'tag' && r.name !== project.defaultBranch && r.name !== project.remote;
  const tint = owner.colour ? { borderColor: `color-mix(in srgb, ${owner.colour} 60%, transparent)`, backgroundColor: `color-mix(in srgb, ${owner.colour} 12%, transparent)` } : undefined;
  const avatar = ownedBranch ? <Who id={owner.id} name={owner.name} size="size-3" /> : null;
  const base = 'mr-1.5 inline-flex h-[17px] max-w-full items-center gap-[3px] rounded-[5px] px-[5px] align-[1px] font-mono text-[10.5px] font-medium';
  if (r.kind === 'local') {
    return (
      <span className={`${base} border border-content/20 text-content/85`} style={tint} title={`${r.name}${owner.name ? `, ${owner.name}` : ownedBranch ? ', owner not recorded' : ''}${r.remote ? `, on remote as ${r.remote} at last fetch` : ''}`}>
        <PillIcon kind="branch" />{avatar}<span className="truncate">{r.name}</span>
        {r.remote ? <span className="ml-1 inline-flex text-success"><PillIcon kind="globe" /></span> : null}
      </span>
    );
  }
  if (r.kind === 'remote') return <span className={`${base} border border-dashed border-success/40 text-success`} title={`${r.name}, on remote at last fetch`}><PillIcon kind="globe" />{avatar}<span className="truncate">{r.name}</span></span>;
  return <span className={`${base} bg-content/7 text-content/70`}><PillIcon kind="tag" />{r.name}</span>;
}

/** In the panel, at most two pills and "+N"; the pane shows them all. */
function Pills({ refs, wide, project }: { refs: WorkRef[]; wide: boolean; project: WorkProject }) {
  const shown = wide || refs.length <= 2 ? refs : refs.slice(0, 2);
  const more = refs.length - shown.length;
  return (
    <>
      {shown.map(r => <Pill key={`${r.kind}:${r.name}`} r={r} project={project} />)}
      {more ? <span className="mr-1.5 align-[1px] font-mono text-[10.5px] text-content/45" title={refs.slice(2).map(r => r.remote ?? r.name).join(', ')}>+{more}</span> : null}
    </>
  );
}

export function WorkGraph({ project, wide, selected, onSelect }: { project: WorkProject; wide: boolean; selected: WorkTarget | null; onSelect: (target: WorkTarget) => void }) {
  const agents = useApp(s => s.snapshot?.agents);
  const gutter = LANE_PAD * 2 + Math.max(0, project.graphLanes - 1) * LANE_W;
  return <><div className="flex h-8 items-center justify-between px-1.5 text-[11px] text-content/50"><span>Recent commits</span><span>{project.inProgress.length} open branches</span></div>
    <div className="relative"><div className="pointer-events-none absolute left-1.5 top-0"><Lanes project={project} /></div>
      {project.graph.map(c => {
        const target: WorkTarget = { kind: 'commit', id: c.hash };
        const identity = commitIdentity(project, c);
        const owner = workOwner(agents ?? [], identity.id, identity.name);
        const work = c.refs.map(r => refWork(project, r)).find(Boolean) ?? project.merged.find(m => m.hash === c.hash);
        const status = work ? 'state' in work ? branchStatus(work) : mergeStatus(work) : undefined;
        const label = [c.subject, c.refs.map(r => r.name).join(', '), owner.name ?? (work || c.lane !== 0 ? 'Owner not recorded' : undefined), status?.title, c.hash.slice(0, 7)].filter(Boolean).join(', ');
        return <WorkRow key={c.hash} target={target} selected={selected?.kind === 'commit' && selected.id === c.hash} title={label} onSelect={onSelect}>
          <span aria-hidden className="shrink-0" style={{ width: gutter }} />
          <span className="min-w-0 flex-1 truncate text-content/90">{c.head ? <Check aria-label="HEAD" className="mr-1 inline-block size-3" /> : null}<Pills refs={c.refs} wide={wide} project={project} />{c.subject}</span>
          {owner.id || owner.name || c.lane !== 0 || work ? <WorkOwnerLabel id={owner.id} name={owner.name} /> : null}
          {work ? 'state' in work ? <BranchState branch={work} compact /> : <MergeState merge={work} compact /> : null}
          {wide ? <span className="shrink-0 text-[11px] text-content/45">{day(c.at)}</span> : null}
        </WorkRow>;
      })}
    </div><p className="px-1.5 pt-4 text-[11px] text-content/50">Select a commit to inspect its changes.</p></>;
}
