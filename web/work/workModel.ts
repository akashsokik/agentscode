import type { WorkBranch, WorkCommit, WorkMerge, WorkProject, WorkTarget } from '../../shared/work.ts';

export type WorkItem = { kind: 'branch'; data: WorkBranch } | { kind: 'commit'; data: WorkCommit } | { kind: 'merge'; data: WorkMerge };

export function selectedWork(project: WorkProject, target: WorkTarget | null): WorkItem | null {
  if (target?.kind === 'branch') { const data = project.inProgress.find(b => b.folder === target.id); return data ? { kind: 'branch', data } : null; }
  if (target?.kind === 'commit') { const data = project.graph.find(c => c.hash === target.id); return data ? { kind: 'commit', data } : null; }
  if (target?.kind === 'merge') { const data = project.merged.find(m => m.originalHash === target.id); return data ? { kind: 'merge', data } : null; }
  return null;
}

/** Unknown remote state must never appear under the confirmed local-only heading. */
export function mergeGroups(project: WorkProject) {
  return { local: project.merged.filter(m => m.pushed === false), pushed: project.merged.filter(m => m.pushed === true), unknown: project.merged.filter(m => m.pushed === null) };
}
