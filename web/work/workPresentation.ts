import { agentLook, AVATAR_FILL } from '../../shared/avatar.ts';
import type { Agent } from '../../shared/types.ts';
import type { WorkBranch, WorkCommit, WorkMerge, WorkProject, WorkRef } from '../../shared/work.ts';

type AgentIdentity = Pick<Agent, 'id' | 'name' | 'role' | 'avatar'>;
export interface WorkOwner { id?: string; name?: string; colour?: string }

/** Resolve the same stored avatar as WhoAvatar; never invent a colour for an unowned branch. */
export function workOwner(agents: readonly AgentIdentity[], id?: string, name?: string): WorkOwner {
  const agent = agents.find(a => id ? a.id === id : name && a.name.toLowerCase() === name.trim().toLowerCase());
  return { id: agent?.id ?? id, name: agent?.name ?? name, colour: agent || id ? AVATAR_FILL[agentLook(agent ?? { id: id! }).color] : undefined };
}

export function refWork(project: WorkProject, ref: WorkRef): WorkBranch | WorkMerge | undefined {
  if (ref.kind === 'tag') return undefined;
  const name = ref.kind === 'remote' ? ref.name.slice(ref.name.indexOf('/') + 1) : ref.name;
  if (name === project.defaultBranch) return undefined;
  return project.inProgress.find(b => b.branch === name) ?? project.merged.find(m => m.branch === name);
}

export function workIdentity(item: WorkBranch | WorkMerge | undefined): { id?: string; name?: string } {
  // The API omits IDs for removed agents, so these arrays are not always aligned.
  return item && 'agentIds' in item ? { id: !item.names.length || item.names.length === item.agentIds.length ? item.agentIds[0] : undefined, name: item.names[0] } : { id: item?.agentId, name: item?.agentName };
}

export function commitIdentity(project: WorkProject, commit: WorkCommit): { id?: string; name?: string } {
  if (commit.names.length) return { id: commit.names.length === commit.agentIds.length ? commit.agentIds[0] : undefined, name: commit.names[0] };
  if (commit.agentIds.length) return { id: commit.agentIds[0] };
  const ref = commit.refs.map(r => refWork(project, r)).find(Boolean);
  const merge = project.merged.find(m => m.hash === commit.hash);
  const recorded = workIdentity(ref ?? merge);
  if (recorded.id || recorded.name) return recorded;
  return { id: project.laneOwners[commit.key ?? ''], name: project.laneOwners[commit.key ?? ''] ? commit.key ?? undefined : undefined };
}

export function branchStatus(branch: WorkBranch) {
  if (branch.changed || branch.untracked) return { label: 'Changes', tone: 'warning' as const, title: `${branch.changed + branch.untracked} uncommitted files` };
  const state = {
    approved: { label: 'Approved', tone: 'success' as const, title: 'Approved for merge' },
    reviewing: { label: 'In review', tone: 'info' as const, title: 'Review in progress' },
    working: { label: 'Working', tone: 'info' as const, title: 'Agent working on this branch' },
    open: { label: 'Open', tone: 'neutral' as const, title: 'Open branch' },
  };
  return state[branch.state];
}

export function mergeStatus(merge: WorkMerge) {
  return merge.pushed === true ? { label: 'On remote', tone: 'success' as const, title: 'Merged; present on remote at last fetch' }
    : merge.pushed === false ? { label: 'Local only', tone: 'info' as const, title: 'Merged locally; absent on remote at last fetch' }
      : { label: 'Unknown', tone: 'neutral' as const, title: 'Merged; remote status unknown' };
}
