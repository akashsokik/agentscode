/** Naming an agent's project. Pure, so it is tested directly. */

import { ALL_PROJECTS } from '../shared/types.ts';

/**
 * What an agent with no project shows where a project name would go: it works across every project.
 * One wording everywhere, server and app, so it comes from shared/types.ts.
 */
export { ALL_PROJECTS };

/** What an agent whose project choice could not be read shows: it has none until you pick some. */
export const NO_PROJECTS = 'No projects';

/**
 * The projects an agent works on, as one label: ALL_PROJECTS for every project, the project's name
 * for one, "first + N" for several (the start folder first, ACH-D15), or `missing` when its projects
 * are gone. A single id (a goal's, a terminal's) reads as that project.
 */
export function projectLabel(projectIds: string[] | string | null, projects: readonly { id: string; name: string }[] | undefined, missing = ''): string {
  if (projectIds === null) return ALL_PROJECTS;
  const ids = typeof projectIds === 'string' ? [projectIds] : projectIds;
  if (!ids.length) return NO_PROJECTS;
  const names = ids.flatMap(id => projects?.filter(p => p.id === id).map(p => p.name) ?? []);
  if (!names.length) return missing;
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1}`;
}

/** Every project name an agent works on, in order, for a hover list or a search; [] for every project. */
export function projectNames(projectIds: string[] | null, projects: readonly { id: string; name: string }[] | undefined): string[] {
  return (projectIds ?? []).flatMap(id => projects?.filter(p => p.id === id).map(p => p.name) ?? []);
}

/**
 * Agents grouped under their start folders, in the projects' order, with the agents that have no
 * project first under ALL_PROJECTS. Each agent is listed once. Empty groups are left out.
 */
export function groupByProject<A extends { projectIds: string[] | null }>(
  agents: readonly A[],
  projects: readonly { id: string; name: string }[],
): { id: string | null; name: string; agents: A[] }[] {
  const groups = [{ id: null as string | null, name: ALL_PROJECTS }, ...projects.map(p => ({ id: p.id as string | null, name: p.name }))];
  return groups
    .map(group => ({ ...group, agents: agents.filter(a => (a.projectIds?.[0] ?? null) === group.id) }))
    .filter(group => group.agents.length);
}
