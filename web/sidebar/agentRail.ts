import { ALL_PROJECTS, type Agent } from '../../shared/types.ts';

/** The navigation column's Agents section. Pure, so it is tested directly. */

/** What an agent with no project (it works across all of them) shows in place of a project name. */
export { ALL_PROJECTS };

/**
 * The agents with no project, by name; agents with the same name keep the order they were made in.
 * A project's agents live in that project's workspace column instead.
 */
export function railAgents<A extends Pick<Agent, 'name' | 'projectId' | 'createdAt'> & { role?: Agent['role'] }>(agents: readonly A[]): A[] {
  return agents
    // The SuperAgent has its own row at the top of the navigation column.
    .filter(agent => !agent.projectId && agent.role !== 'super')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.createdAt - b.createdAt);
}

/**
 * Whether the workspace column (Agents, Files, Changes) shows for the selected project: only when
 * the project has agents of its own, since agents with no project are listed in the navigation
 * column. With no project at all it shows the Add project prompt, until any agent exists.
 */
export function showsWorkspace(agents: readonly Pick<Agent, 'projectId'>[], projectId: string | undefined): boolean {
  return projectId ? agents.some(agent => agent.projectId === projectId) : !agents.length;
}

/** What a rail row shows at its end, in the order AgentCard's StatusMark checks them. */
export type RailAgentStatus = 'needs-you' | 'working' | 'failed' | 'unread' | null;

export function railAgentStatus(agent: Pick<Agent, 'status' | 'unread'>, pending: boolean): RailAgentStatus {
  if (pending || agent.status === 'waiting') return 'needs-you';
  if (agent.status === 'working') return 'working';
  if (agent.status === 'error') return 'failed';
  if (agent.unread) return 'unread';
  return null;
}

/** The workspace column's groups, in the order they want your attention. */
export type AgentGroupKey = 'needs-you' | 'working' | 'idle';

export const AGENT_GROUP_LABEL: Record<AgentGroupKey, string> = { 'needs-you': 'Needs you', working: 'Working', idle: 'Idle' };

/** Which group an agent is listed under: waiting on you first, then working; everything else is idle. */
export function agentGroup(agent: Pick<Agent, 'status'>, pending: boolean): AgentGroupKey {
  if (pending || agent.status === 'waiting') return 'needs-you';
  return agent.status === 'working' ? 'working' : 'idle';
}

/**
 * A project's agents under Needs you, Working and Idle, empty groups left out. Within a group the
 * agents keep the order they came in, so a card only moves when its agent's state changes.
 */
export function groupAgents<A extends Pick<Agent, 'id' | 'status'>>(agents: readonly A[], pendingIds: ReadonlySet<string>): { key: AgentGroupKey; agents: A[] }[] {
  const order: AgentGroupKey[] = ['needs-you', 'working', 'idle'];
  return order
    .map(key => ({ key, agents: agents.filter(agent => agentGroup(agent, pendingIds.has(agent.id)) === key) }))
    .filter(group => group.agents.length > 0);
}
