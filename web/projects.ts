/** Naming an agent's project. Pure, so it is tested directly. */

import { ALL_PROJECTS } from '../shared/types.ts';

/**
 * What an agent with no project shows where a project name would go: it works across every project.
 * One wording everywhere, server and app, so it comes from shared/types.ts.
 */
export { ALL_PROJECTS };

/**
 * The name of the project an agent works on, ALL_PROJECTS for one with no project, or `missing`
 * when the project is gone.
 */
export function projectLabel(projectId: string | null, projects: readonly { id: string; name: string }[] | undefined, missing = ''): string {
  if (projectId === null) return ALL_PROJECTS;
  return projects?.find(p => p.id === projectId)?.name ?? missing;
}

/**
 * Agents grouped under their projects, in the projects' order, with the agents that have no project
 * first under ALL_PROJECTS. Empty groups are left out.
 */
export function groupByProject<A extends { projectId: string | null }>(
  agents: readonly A[],
  projects: readonly { id: string; name: string }[],
): { id: string | null; name: string; agents: A[] }[] {
  const groups = [{ id: null as string | null, name: ALL_PROJECTS }, ...projects.map(p => ({ id: p.id as string | null, name: p.name }))];
  return groups
    .map(group => ({ ...group, agents: agents.filter(a => a.projectId === group.id) }))
    .filter(group => group.agents.length);
}
