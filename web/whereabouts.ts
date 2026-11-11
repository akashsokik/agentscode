import type { Agent, Project } from '../shared/types.ts';
import { startProjectId } from '../shared/agentProjects.ts';

export interface Whereabouts {
  /** The project's name, or the folder's when the project was removed. */
  project: string;
  branch: string | null;
  /** Whether it is one of the agent's own projects; an agent's card sits under each of them already. */
  own: boolean;
}

/** Which codebase an agent is in and on which branch, from its last tool calls; null until known. */
export function whereabouts(agent: Agent, projects: readonly Pick<Project, 'id' | 'name'>[] | undefined): Whereabouts | null {
  const place = agent.workingIn;
  if (!place) return agent.worktree ? { project: projects?.find(p => p.id === startProjectId(agent))?.name ?? '', branch: agent.worktree.branch, own: true } : null;
  const project = projects?.find(p => p.id === place.projectId)?.name ?? place.root.split('/').filter(Boolean).pop() ?? place.root;
  return { project, branch: place.branch, own: Boolean(agent.projectIds?.includes(place.projectId)) };
}
