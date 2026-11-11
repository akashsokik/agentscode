import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { Agent, EngineKind, Project } from '../../shared/types.ts';
import { AlertCircle, Check, Folder, FolderOpen, Plus, Search, X } from '../mono/icons.tsx';
import { Segmented } from '../mono/settings.tsx';
import { filterProjects, makeStart, removeProject, setMode, toggleProject, type ProjectsChoice, type ProjectsMode } from '../projectPicker.ts';

/*
 * The Projects picker (ACH-D15): All projects, or Choose. Chosen projects show as chips, the first
 * marked Start folder (where the agent's sessions run and its worktree, if any, is made); Make start
 * moves another to the front. Below, a search-and-tick list of every project with how many agents
 * work there, and Add project. Theme tokens only (ACH-D14): the highlighted row is the selection
 * fill, the Start folder tag a stronger content fill. No shadows.
 */

const MODES: { value: ProjectsMode; label: string }[] = [
  { value: 'all', label: 'All projects' },
  { value: 'choose', label: 'Choose' },
];

export function ProjectsPicker({ choice, onChange, projects, agents, engine, onAddProject, note }: {
  choice: ProjectsChoice;
  onChange: (next: ProjectsChoice) => void;
  projects: readonly Project[];
  /** Every agent, for each project's count; the agent being edited is left out by the caller. */
  agents: readonly Pick<Agent, 'projectIds'>[];
  engine: EngineKind;
  onAddProject?: () => void;
  /** Under the list, for settings: when changes apply. */
  note?: string;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const shown = useMemo(() => filterProjects(projects, query), [projects, query]);
  const rows = shown.length + (onAddProject ? 1 : 0);
  const at = Math.min(active, Math.max(0, rows - 1));
  const byId = new Map(projects.map(p => [p.id, p]));
  const count = (id: string) => agents.filter(a => a.projectIds?.includes(id)).length;
  const pick = (index: number) => {
    if (index < shown.length) onChange(toggleProject(choice, shown[index].id));
    else onAddProject?.();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((at + (event.key === 'ArrowDown' ? 1 : rows - 1)) % Math.max(1, rows));
    } else if (event.key === 'Enter' && rows) {
      event.preventDefault();
      event.stopPropagation();
      pick(at);
    }
  };
  const several = choice.mode === 'choose' && choice.ids.length > 1;

  return (
    <div className="min-w-0 font-sans">
      <div className="flex items-start gap-5">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-content">Projects</p>
          <p className="mt-0.5 text-[12px] leading-snug text-content/50">
            {choice.mode === 'all' ? 'Works from its own folder and can reach every project you have added.' : 'Where it may read and write. It starts in the first one.'}
          </p>
        </div>
        <Segmented label="Projects" value={choice.mode} options={MODES} onChange={mode => onChange(setMode(choice, mode))} />
      </div>
      {choice.mode === 'choose' ? (
        <>
          {choice.ids.length ? (
            <div className="mb-2 mt-2.5 flex flex-wrap gap-1.5">
              {choice.ids.map((id, i) => {
                const project = byId.get(id);
                const start = i === 0;
                const locked = choice.lockedStart === id;
                return (
                  <span key={id} className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-[7px] bg-content/7 pl-2 pr-1 text-[12.5px] text-content">
                    {start ? <FolderOpen aria-hidden className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} /> : <Folder aria-hidden className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />}
                    <span className="min-w-0 truncate">{project?.name ?? 'Removed project'}</span>
                    {start ? (
                      <span className="shrink-0 rounded-[5px] bg-content/12 px-1.5 py-px text-[11px] font-medium text-content" title={locked ? 'Its worktree is a branch of this project, so it stays the start folder.' : 'Its sessions run here, and its worktree (if any) is made here.'}>Start folder</span>
                    ) : (
                      <button
                        type="button"
                        disabled={Boolean(choice.lockedStart)}
                        onClick={() => onChange(makeStart(choice, id))}
                        title={choice.lockedStart ? 'Its worktree keeps the start folder where it is.' : `Start in ${project?.name ?? 'this project'} instead`}
                        className="shrink-0 rounded-[5px] bg-content/7 px-1.5 py-px text-[11px] text-content/50 transition-colors hover:bg-content/12 hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Make start
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${project?.name ?? 'project'}`}
                      disabled={locked}
                      onClick={() => onChange(removeProject(choice, id))}
                      className="grid size-4 shrink-0 place-items-center rounded text-content/40 transition-colors hover:text-content disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <X className="size-3" strokeWidth={1.8} />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : <p className="mb-2 mt-2.5 text-[12px] text-content/50">Tick at least one project.</p>}
          <div className="overflow-hidden rounded-[9px] border border-content/10 bg-content/5">
            <label className="flex items-center gap-2 px-2.5 py-[7px] text-[12.5px] text-content/35 focus-within:text-content">
              <Search aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
              <input
                value={query}
                onChange={e => { setQuery(e.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
                placeholder="Search projects"
                aria-label="Search projects"
                aria-controls={listId}
                aria-activedescendant={rows ? `${listId}-${at}` : undefined}
                className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/35"
              />
            </label>
            <div id={listId} role="listbox" aria-label="Projects" aria-multiselectable className="max-h-56 overflow-y-auto p-1 pt-0">
              {shown.map((project, i) => {
                const on = choice.ids.includes(project.id);
                const n = count(project.id);
                return (
                  <div
                    key={project.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={on}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => pick(i)}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-[7px] text-[12.5px] ${i === at ? 'bg-selection text-content' : 'text-content/75'}`}
                  >
                    <span aria-hidden className={`grid size-3.5 shrink-0 place-items-center rounded-[4px] ${on ? 'bg-content text-background-base' : 'border border-content/30'}`}>
                      {on ? <Check className="size-2.5" strokeWidth={2.6} /> : null}
                    </span>
                    <Folder aria-hidden className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />
                    <span className="min-w-0 truncate">{project.name}</span>
                    {project.isGit ? <span className="shrink-0 text-[11px] text-content/35">git</span> : null}
                    {n ? <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-content/40">{n} {n === 1 ? 'agent' : 'agents'}</span> : null}
                  </div>
                );
              })}
              {!shown.length ? <p className="px-2 py-[7px] text-[12.5px] text-content/40">No project matches "{query.trim()}".</p> : null}
              {onAddProject ? (
                <div
                  id={`${listId}-${shown.length}`}
                  role="option"
                  aria-selected={false}
                  onMouseEnter={() => setActive(shown.length)}
                  onMouseDown={e => e.preventDefault()}
                  onClick={onAddProject}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-[7px] text-[12.5px] ${at === shown.length ? 'bg-selection text-content' : 'text-content/55'}`}
                >
                  <Plus aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                  Add project…
                </div>
              ) : null}
            </div>
          </div>
          {note ? <p className="mt-2 text-[12px] leading-normal text-content/50">{note}</p> : null}
          {several && engine === 'codex' ? (
            <p className="mt-2 flex items-start gap-2 rounded-lg bg-content/5 px-2.5 py-2 text-[12px] leading-normal text-content/60">
              <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
              <span>Codex agents are sandboxed to their start folder: with several projects they can read the others but write only in the start folder (at Full access there is no sandbox). Claude and OrcaCode agents can write in all of them.</span>
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
