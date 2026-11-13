import { useRef } from 'react';
import type { Agent } from '../../shared/types.ts';
import { shortPath } from '../format.ts';
import { Folder, FolderOpen, GitBranch } from '../mono/icons.tsx';
import { useApp } from '../store.ts';
import { HoverCard, useHoverCard } from '../ui/HoverCard.tsx';

/*
 * The header's "first + N" for an agent on several projects (ACH-D15). Hovering or focusing it lists
 * them: the start folder (with its worktree, if any) and the others, used in place. A flat card with
 * a full hairline border, no shadow (ACH-D7), theme tokens only (ACH-D14), in the shared hover card
 * (web/ui/HoverCard.tsx) with the chips' timing (ACH-38).
 */

export function AgentProjects({ agent }: { agent: Agent }) {
  const projects = useApp(s => s.snapshot?.projects);
  const home = useApp(s => s.snapshot?.home);
  const anchor = useRef<HTMLButtonElement>(null);
  const card = useHoverCard();
  const mine = (agent.projectIds ?? []).flatMap(id => (projects ?? []).filter(p => p.id === id));
  if (mine.length < 2) return null;
  const [start, ...others] = mine;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={card.open}
        aria-describedby={card.open ? card.cardId : undefined}
        aria-label={`Projects: ${mine.map(p => p.name).join(', ')}; starts in ${start.name}`}
        {...card.chipEvents}
        onKeyDown={e => { if (e.key === 'Escape' && card.open) { e.stopPropagation(); card.close(); } }}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 text-[12px] font-normal text-content/45 transition-colors hover:text-content/70"
      >
        <span className="min-w-0 truncate">{start.name}</span>
        <span className="shrink-0 rounded-[5px] bg-content/5 px-1.5 text-[12px] tabular-nums text-content/60">+ {others.length}</span>
      </button>
      {card.open && anchor.current ? (
        <ProjectsCard
          id={card.cardId}
          anchor={anchor.current}
          onEnter={card.onCardEnter}
          onLeave={card.onCardLeave}
          onClose={card.close}
          rows={[
            { name: start.name, tag: 'Start folder', start: true, detail: agent.worktree ? `${agent.worktree.branch}, own worktree` : shortPath(start.path, home), branch: Boolean(agent.worktree) },
            ...others.map(p => ({ name: p.name, tag: 'In place', start: false, detail: shortPath(p.path, home), branch: false })),
          ]}
        />
      ) : null}
    </>
  );
}

/** The list, in the shared hover card's shell (web/ui/HoverCard.tsx, ACH-38): placement, Escape, scroll. */
function ProjectsCard({ id, anchor, rows, onEnter, onLeave, onClose }: {
  id: string;
  anchor: HTMLElement;
  rows: { name: string; tag: string; start: boolean; detail: string; branch: boolean }[];
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  return (
    <HoverCard id={id} anchor={anchor} onEnter={onEnter} onLeave={onLeave} onClose={onClose} width={300} padding="py-1.5" deps={rows.length}>
      <p className="px-3 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.04em] text-content/45">Projects</p>
      {rows.map(row => (
        <div key={row.name} className="px-3 py-1.5">
          <div className="flex items-center gap-2 text-[12.5px]">
            {row.start ? <FolderOpen aria-hidden className="size-3.5 shrink-0 text-content/60" strokeWidth={1.75} /> : <Folder aria-hidden className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />}
            <span className="min-w-0 truncate">{row.name}</span>
            <span className="ml-auto shrink-0 text-[11.5px] text-content/45">{row.tag}</span>
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1 pl-[22px] text-[11.5px] text-content/40">
            {row.branch ? <GitBranch aria-hidden className="size-3 shrink-0" strokeWidth={1.75} /> : null}
            <span className="min-w-0 truncate">{row.detail}</span>
          </p>
        </div>
      ))}
    </HoverCard>
  );
}
