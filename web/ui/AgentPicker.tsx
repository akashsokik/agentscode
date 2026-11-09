/**
 * Picks agents out of many: a search field, the picked agents as removable chips, and the
 * matches grouped by project with MonoCode's MenuRow, each project with Add all.
 * Search matches name, project, role, engine and branch. Arrow keys move, Enter toggles,
 * Backspace in an empty field removes the last pick.
 */
import { useMemo, useRef, useState } from 'react';
import type { Agent } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { groupByProject, projectLabel } from '../projects.ts';
import { useApp } from '../store.ts';
import { ENGINE_NAMES } from './EngineIcon.tsx';
import { MenuRow } from './common.tsx';
import { Search, X } from '../mono/icons.tsx';
import { AgentAvatar } from './Avatar.tsx';

/** Rendering hundreds of rows helps nobody; past this, typing narrows the list. */
const SHOWN = 80;

export function AgentPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const agents = useApp(s => s.snapshot?.agents);
  const projects = useApp(s => s.snapshot?.projects);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const selected = new Set(value);

  const projectName = (id: string | null) => projectLabel(id, projects, 'Unknown project');
  const describe = (a: Agent) => [projectName(a.projectId), rolePreset(a.role).name, a.worktree ? `branch ${a.worktree.branch}` : ''].filter(Boolean).join(', ');

  const { groups, rows, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (a: Agent) => !q || [a.name, projectName(a.projectId), rolePreset(a.role).name, ENGINE_NAMES[a.engine], a.worktree?.branch ?? '']
      .some(field => field.toLowerCase().includes(q));
    // Agents with no project come first, under All projects.
    const all = groupByProject((agents ?? []).filter(matches), projects ?? []).map(({ id, name, agents: inGroup }) => ({
      project: { id, name },
      agents: [...inGroup].sort((a, b) => a.name.localeCompare(b.name)),
    }));
    // Names that start with the query come first, the way a mention list sorts.
    if (q) all.sort((a, b) => Number(b.agents.some(x => x.name.toLowerCase().startsWith(q))) - Number(a.agents.some(x => x.name.toLowerCase().startsWith(q))));
    let budget = SHOWN;
    const shown = all.map(g => {
      const take = g.agents.slice(0, Math.max(0, budget));
      budget -= take.length;
      return { ...g, shown: take };
    }).filter(g => g.shown.length);
    return { groups: shown, rows: shown.flatMap(g => g.shown), total: all.reduce((n, g) => n + g.agents.length, 0) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, projects, query]);

  const current = Math.min(active, Math.max(0, rows.length - 1));
  const toggle = (id: string) => onChange(selected.has(id) ? value.filter(v => v !== id) : [...value, id]);
  const setMany = (ids: string[], on: boolean) => onChange(on ? [...value, ...ids.filter(id => !selected.has(id))] : value.filter(id => !ids.includes(id)));
  const picked = value.map(id => agents?.find(a => a.id === id)).filter((a): a is Agent => Boolean(a));

  const move = (step: number) => {
    if (!rows.length) return;
    const next = (current + step + rows.length) % rows.length;
    setActive(next);
    list.current?.querySelector(`[data-picker-row="${rows[next].id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className="font-sans">
      <div className="flex items-center gap-2 border-b border-content/5 px-3 py-2.5">
        <Search className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'ArrowDown' ? 1 : -1); }
            else if (e.key === 'Enter') { e.preventDefault(); if (rows[current]) toggle(rows[current].id); }
            else if (e.key === 'Backspace' && !query && value.length) onChange(value.slice(0, -1));
          }}
          placeholder={`Search ${agents?.length ?? 0} agents by name, project or role`}
          aria-label="Search agents"
          role="combobox"
          aria-expanded
          aria-controls="agent-picker-list"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/35"
        />
        <span className="shrink-0 text-[12px] text-content/45">{value.length} picked</span>
      </div>

      {picked.length ? (
        <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto border-b border-content/5 px-3 py-2.5">
          {picked.map(agent => (
            <span key={agent.id} title={describe(agent)} className="inline-flex h-6.5 max-w-full items-center gap-1 rounded-md bg-selection pl-1.5 pr-0.5 text-[12px] text-content">
              <AgentAvatar agent={agent} className="size-3.5" />
              <span className="min-w-0 truncate">{agent.name}</span>
              <span className="min-w-0 truncate text-content/40">{projectName(agent.projectId)}</span>
              <button type="button" aria-label={`Remove ${agent.name}`} onClick={() => toggle(agent.id)} className="grid size-5 shrink-0 place-items-center rounded text-content/45 hover:bg-content/10 hover:text-content">
                <X className="size-3" strokeWidth={1.8} />
              </button>
            </span>
          ))}
          {picked.length > 1 ? (
            <button type="button" onClick={() => onChange([])} className="h-6.5 rounded px-1.5 text-[12px] text-content/45 hover:text-content">Clear</button>
          ) : null}
        </div>
      ) : null}

      <div ref={list} id="agent-picker-list" role="listbox" aria-multiselectable className="max-h-72 overflow-y-auto overscroll-contain p-1">
        {groups.map(({ project, agents: inProject, shown }) => {
          const ids = inProject.map(a => a.id);
          const allIn = ids.every(id => selected.has(id));
          return (
            <div key={project.id ?? 'all-projects'}>
              <div className="flex items-center gap-2 px-2 pb-1 pt-2">
                <span className="min-w-0 truncate text-[10px] font-medium uppercase tracking-wide text-content/40">{project.name}</span>
                <span className="text-[11px] text-content/30">{inProject.length}</span>
                {inProject.length > 1 ? (
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => setMany(ids, !allIn)} className="ml-auto rounded px-1 text-[11px] text-content/50 hover:text-content">
                    {allIn ? 'Remove all' : query.trim() ? `Add these ${inProject.length}` : 'Add all'}
                  </button>
                ) : null}
              </div>
              {shown.map(agent => (
                <div key={agent.id} data-picker-row={agent.id} onMouseEnter={() => setActive(rows.indexOf(agent))}>
                  <MenuRow
                    title={<span className="flex items-center gap-1.5"><AgentAvatar agent={agent} className="size-3.5" />{agent.name}</span>}
                    hint={describe(agent)}
                    checked={selected.has(agent.id)}
                    highlighted={rows[current]?.id === agent.id}
                    onSelect={() => toggle(agent.id)}
                  />
                </div>
              ))}
            </div>
          );
        })}
        {!rows.length ? (
          <p className="px-2 py-3 text-[12px] text-content/45">{agents?.length ? `No agents match "${query.trim()}".` : 'No agents yet.'}</p>
        ) : null}
        {total > rows.length ? (
          <p className="px-2 py-2 text-[11px] text-content/40">Showing {rows.length} of {total}. Keep typing to narrow the list.</p>
        ) : null}
      </div>
    </div>
  );
}
