import { useMemo, useState } from 'react';
import type { WorkBranch, WorkProject, WorkTarget } from '../../shared/work.ts';
import { edgePath } from '../../shared/graph.ts';
import { ChevronDown, ChevronRight } from '../mono/icons.tsx';
import { useApp } from '../store.ts';
import { day } from './workData.ts';
import { WorkRow, WorkWho as Who } from './WorkParts.tsx';
import { branchStatus, workOwner } from './workPresentation.ts';
import { branchCount, rowOwners, rowText, shortBranch, splitBranches, tagNames, tipLabels } from './graphRows.ts';

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

/** An open branch tip's label (ACH-D34): a dot in its owner's colour and the short name; the full name on hover. */
function TipLabel({ branch }: { branch: WorkBranch }) {
  const agents = useApp(s => s.snapshot?.agents);
  const owner = workOwner(agents ?? [], branch.agentId, branch.agentName);
  const status = branchStatus(branch);
  return (
    <span className="inline-flex min-w-0 max-w-[108px] shrink-0 items-center gap-[5px] text-[11.5px] text-content/80" title={`${branch.branch}${owner.name ? ` · ${owner.name}` : ''} · ${status.label}${branch.ahead ? ` · ${branch.ahead} ahead` : ''}`}>
      <span aria-hidden className="size-[7px] shrink-0 rounded-full" style={{ background: owner.colour ?? 'color-mix(in srgb, var(--color-content) 45%, transparent)' }} />
      <span className="truncate">{shortBranch(branch.branch)}</span>
    </span>
  );
}

/** Who made a row's commit: up to three avatars, the name when there is one; nothing when nobody was recorded. */
function RowOwners({ owners }: { owners: { id?: string; name: string }[] }) {
  if (!owners.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center" title={owners.map(o => o.name).join(', ')}>
      {owners.map((o, i) => <span key={`${o.id ?? o.name}:${i}`} className={i ? '-ml-1' : ''}><Who id={o.id} name={o.name} size="size-3.5" /></span>)}
      {owners.length === 1 ? <span className="ml-1.5 max-w-14 truncate text-content/55">{owners[0].name}</span> : null}
    </span>
  );
}

/** Stale open branches (ACH-D34), folded into one row at the bottom that opens to list them. */
function OlderBranches({ branches, selected, onSelect }: { branches: WorkBranch[]; selected: WorkTarget | null; onSelect: (target: WorkTarget) => void }) {
  const [open, setOpen] = useState(false);
  if (!branches.length) return null;
  const names = [...new Set(branches.map(b => b.agentName).filter((n): n is string => Boolean(n)))];
  return <>
    <button type="button" aria-expanded={open} onClick={() => setOpen(v => !v)} className="flex h-[30px] w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-1.5 text-left font-sans text-[12px] text-content/55 transition-colors hover:bg-content/5">
      {open ? <ChevronDown className="size-3 shrink-0 text-content/40" /> : <ChevronRight className="size-3 shrink-0 text-content/40" />}
      <span className="shrink-0">{branches.length} older {branches.length === 1 ? 'branch' : 'branches'}</span>
      {names.length ? <span className="min-w-0 flex-1 truncate text-content/40">· {names.join(', ')}</span> : <span className="flex-1" />}
      <span className="inline-flex shrink-0 items-center">{names.slice(0, 4).map((n, i) => { const b = branches.find(x => x.agentName === n)!; return <span key={n} className={i ? '-ml-1' : ''}><Who id={b.agentId} name={n} size="size-3.5" /></span>; })}</span>
    </button>
    {open ? branches.map(b => (
      <WorkRow key={b.folder} target={{ kind: 'branch', id: b.folder }} selected={selected?.kind === 'branch' && selected.id === b.folder} title={`${b.branch}, ${b.agentName ?? 'owner not recorded'}, ${b.behind} behind main`} onSelect={onSelect}>
        <span aria-hidden className="w-3 shrink-0" />
        {b.agentName || b.agentId ? <Who id={b.agentId} name={b.agentName} size="size-3.5" /> : null}
        <span className="min-w-0 flex-1 truncate text-content/80">{shortBranch(b.branch)}</span>
        <span className="shrink-0 text-[11px] text-content/45">{b.agentName ? `${b.agentName} · ` : ''}{b.behind} behind</span>
      </WorkRow>
    )) : null}
  </>;
}

export function WorkGraph({ project, wide, selected, onSelect }: { project: WorkProject; wide: boolean; selected: WorkTarget | null; onSelect: (target: WorkTarget) => void }) {
  const { open, older } = useMemo(() => splitBranches(project, Date.now()), [project]);
  const gutter = LANE_PAD * 2 + Math.max(0, project.graphLanes - 1) * LANE_W;
  return <><div className="flex h-8 items-center justify-between px-1.5 text-[11px] text-content/50"><span>Recent commits</span><span>{branchCount(open.length, older.length)}</span></div>
    <div className="relative"><div className="pointer-events-none absolute left-1.5 top-0"><Lanes project={project} /></div>
      {project.graph.map(c => {
        const target: WorkTarget = { kind: 'commit', id: c.hash };
        const row = rowText(project, c);
        const labels = tipLabels(c, open, project.graph);
        const owners = rowOwners(c);
        const tags = tagNames(c);
        const label = [c.subject, ...labels.map(b => b.branch), ...tags, owners.map(o => o.name).join(', '), ...labels.map(b => branchStatus(b).title), c.hash.slice(0, 7)].filter(Boolean).join(', ');
        return <WorkRow key={c.hash} target={target} selected={selected?.kind === 'commit' && selected.id === c.hash} title={label} onSelect={onSelect}>
          <span aria-hidden className="shrink-0" style={{ width: gutter }} />
          <span className={`min-w-0 flex-1 truncate ${row.merge ? 'text-content/55' : 'text-content/90'}`}>{row.text}</span>
          {labels.map(b => <TipLabel key={b.branch} branch={b} />)}
          {tags.map(name => <span key={name} className="shrink-0 text-[11px] text-content/45">{name}</span>)}
          <RowOwners owners={owners} />
          {wide ? <span className="shrink-0 text-[11px] text-content/45">{day(c.at)}</span> : null}
        </WorkRow>;
      })}
    </div>
    <OlderBranches branches={older} selected={selected} onSelect={onSelect} />
    <p className="px-1.5 pt-4 text-[11px] text-content/50">Select a commit to inspect its changes.</p></>;
}
