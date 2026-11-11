// Which projects an agent works on (ACH-D15): every project (null), or a chosen list whose first
// entry is its start folder, the one its sessions run in (and its worktree's, if it has one). The
// others it reads and writes in place. Server and app both use these, so who sees whom and where
// an agent shows can never disagree.

export interface HasProjects {
  projectIds: string[] | null;
}

/** The folder it starts in: the first chosen project, or null for an agent on every project. */
export function startProjectId(agent: HasProjects): string | null {
  return agent.projectIds?.[0] ?? null;
}

/** It works across every project. */
export function isAllProjects(agent: HasProjects): boolean {
  return agent.projectIds === null;
}

/** It works on this project: one of its chosen ones, or any, for an agent on every project. */
export function worksOn(agent: HasProjects, projectId: string): boolean {
  return agent.projectIds === null || agent.projectIds.includes(projectId);
}

/** Two agents share a project: either works on every project, or their lists overlap. */
export function sharesProject(a: HasProjects, b: HasProjects): boolean {
  if (a.projectIds === null || b.projectIds === null) return true;
  return a.projectIds.some(id => b.projectIds!.includes(id));
}

/** Its projects besides the start folder, in order. */
export function otherProjectIds(agent: HasProjects): string[] {
  return agent.projectIds ? agent.projectIds.slice(1) : [];
}

/**
 * A stored or requested project choice as a list: null stays null (every project), a single id (the
 * old projectId) becomes [id], a list keeps its order without blanks or repeats. undefined when
 * there is nothing usable, so the caller can say what is missing.
 */
export function normalizeProjectIds(raw: unknown, legacy?: unknown): string[] | null | undefined {
  const value = raw === undefined ? legacy : raw;
  if (value === null) return null;
  if (typeof value === 'string') return value ? [value] : undefined;
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item && !ids.includes(item)) ids.push(item);
  }
  return ids.length ? ids : undefined;
}
