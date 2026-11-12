import type { ReactNode } from 'react';
import type { WorkBranch, WorkTarget } from '../../shared/work.ts';
import { WhoAvatar } from '../notes/parts.tsx';
import { StatusLabel } from '../ui/common.tsx';

export const targetKey = (target: WorkTarget) => `${target.kind}:${target.id}`;

/** Work's existing single-line row, now with controlled selection (ACH-D24). */
export function WorkRow({ target, selected, title, onSelect, children }: {
  target: WorkTarget; selected: boolean; title: string; onSelect: (target: WorkTarget) => void; children: ReactNode;
}) {
  return <button type="button" data-work-row={targetKey(target)} aria-pressed={selected} aria-label={title} title={title} onClick={() => onSelect(target)}
    className={`flex h-[30px] w-full min-w-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-1.5 text-left font-sans text-[12px] transition-colors ${selected ? 'bg-selection' : 'hover:bg-content/5'}`}>{children}</button>;
}

export function WorkWho({ id, name, size = 'size-4' }: { id?: string; name?: string; size?: string }) {
  return <WhoAvatar name={name ?? '?'} agentId={id} className={size} />;
}

export function WorkLabel({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return <h4 className="flex items-center justify-between px-1 pb-1 pt-3.5 font-sans text-[11px] font-medium text-content/50"><span>{children}</span>{count !== undefined ? <span className="font-normal">{count}</span> : null}</h4>;
}

export function branchState(branch: WorkBranch): string {
  return { working: 'Working', reviewing: 'In review', approved: 'Approved', open: 'Open' }[branch.state];
}

export function BranchState({ branch }: { branch: WorkBranch }) {
  return <StatusLabel tone={branch.state === 'approved' ? 'success' : branch.state === 'reviewing' ? 'info' : 'neutral'} className="text-[11px]">{branchState(branch)}</StatusLabel>;
}
