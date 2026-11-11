/**
 * The Projects picker in New agent and Agent settings (ACH-D15): All projects, or Choose, with the
 * chosen ones in order, the first being the start folder. Pure, so it is tested directly; the
 * dialogs (web/dialogs/ProjectsPicker.tsx) only draw it.
 */

export type ProjectsMode = 'all' | 'choose';

export interface ProjectsChoice {
  mode: ProjectsMode;
  /** The chosen projects, start folder first. Kept while All projects is on, so switching back restores them. */
  ids: string[];
  /** A start folder that may not move (the agent's worktree is a branch of it). */
  lockedStart?: string;
}

/** The picker for an agent's projects as stored: null is All projects. */
export function choiceFrom(projectIds: string[] | null, lockedStart?: string): ProjectsChoice {
  return projectIds === null ? { mode: 'all', ids: [] } : { mode: 'choose', ids: [...projectIds], ...(lockedStart ? { lockedStart } : {}) };
}

/** A new agent's picker: Choose with one project picked, or All projects. */
export function initialChoice(projectId: string | null | undefined, firstProject: string | undefined): ProjectsChoice {
  if (projectId === null) return { mode: 'all', ids: [] };
  const id = projectId ?? firstProject;
  return id ? { mode: 'choose', ids: [id] } : { mode: 'all', ids: [] };
}

export function setMode(choice: ProjectsChoice, mode: ProjectsMode): ProjectsChoice {
  return { ...choice, mode };
}

/** Tick or untick a project: a new one goes last; the locked start folder stays. */
export function toggleProject(choice: ProjectsChoice, id: string): ProjectsChoice {
  if (choice.ids.includes(id)) return removeProject(choice, id);
  return { ...choice, mode: 'choose', ids: [...choice.ids, id] };
}

export function removeProject(choice: ProjectsChoice, id: string): ProjectsChoice {
  if (id === choice.lockedStart) return choice;
  return { ...choice, ids: choice.ids.filter(x => x !== id) };
}

/** Move a chosen project to the front, making it the start folder; not while the start is locked. */
export function makeStart(choice: ProjectsChoice, id: string): ProjectsChoice {
  if (!choice.ids.includes(id) || choice.lockedStart) return choice;
  return { ...choice, ids: [id, ...choice.ids.filter(x => x !== id)] };
}

/** What to send: null for All projects, the list for Choose, undefined when Choose has nothing picked yet. */
export function choiceValue(choice: ProjectsChoice): string[] | null | undefined {
  if (choice.mode === 'all') return null;
  return choice.ids.length ? [...choice.ids] : undefined;
}

/** Whether the choice reaches more than one folder (every project, or several): for OrcaCode's --add-dir and the Codex note. */
export function beyondOneFolder(choice: ProjectsChoice): boolean {
  return choice.mode === 'all' || choice.ids.length > 1;
}

/** Same choice, so Save has nothing to do. */
export function sameChoice(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Projects whose name or folder has every word of the query; all of them for an empty query. */
export function filterProjects<P extends { name: string; path: string }>(projects: readonly P[], query: string): P[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...projects];
  return projects.filter(p => words.every(w => p.name.toLowerCase().includes(w) || p.path.toLowerCase().includes(w)));
}
