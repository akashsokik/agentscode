import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '../../shared/types.ts';
import { shortPath } from '../format.ts';
import { Folder, FolderOpen, GitBranch } from '../mono/icons.tsx';
import { LAYER } from '../mono/layers.ts';
import { useApp } from '../store.ts';

/*
 * The header's "first + N" for an agent on several projects (ACH-D15). Hovering or focusing it lists
 * them: the start folder (with its worktree, if any) and the others, used in place. A flat card with
 * a full hairline border, no shadow (ACH-D7), theme tokens only (ACH-D14).
 */

const OPEN_DELAY = 200;
const CLOSE_DELAY = 160;

export function AgentProjects({ agent }: { agent: Agent }) {
  const projects = useApp(s => s.snapshot?.projects);
  const home = useApp(s => s.snapshot?.home);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = useId();
  const later = (next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const mine = (agent.projectIds ?? []).flatMap(id => (projects ?? []).filter(p => p.id === id));
  if (mine.length < 2) return null;
  const [start, ...others] = mine;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        aria-describedby={open ? cardId : undefined}
        aria-label={`Projects: ${mine.map(p => p.name).join(', ')}; starts in ${start.name}`}
        onMouseEnter={() => later(true, OPEN_DELAY)}
        onMouseLeave={() => later(false, CLOSE_DELAY)}
        onFocus={() => later(true, 0)}
        onBlur={() => later(false, CLOSE_DELAY)}
        onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 text-[12px] font-normal text-content/45 transition-colors hover:text-content/70"
      >
        <span className="min-w-0 truncate">{start.name}</span>
        <span className="shrink-0 rounded-[5px] bg-content/5 px-1.5 text-[12px] tabular-nums text-content/60">+ {others.length}</span>
      </button>
      {open && anchor.current ? (
        <ProjectsCard
          id={cardId}
          anchor={anchor.current}
          onEnter={() => later(true, 0)}
          onLeave={() => later(false, CLOSE_DELAY)}
          onClose={() => setOpen(false)}
          rows={[
            { name: start.name, tag: 'Start folder', start: true, detail: agent.worktree ? `${agent.worktree.branch}, own worktree` : shortPath(start.path, home), branch: Boolean(agent.worktree) },
            ...others.map(p => ({ name: p.name, tag: 'In place', start: false, detail: shortPath(p.path, home), branch: false })),
          ]}
        />
      ) : null}
    </>
  );
}

function ProjectsCard({ id, anchor, rows, onEnter, onLeave, onClose }: {
  id: string;
  anchor: HTMLElement;
  rows: { name: string; tag: string; start: boolean; detail: string; branch: boolean }[];
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = card.current?.offsetWidth ?? 300;
    setPlace({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 6 });
  }, [anchor]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  return createPortal(
    <div
      ref={card}
      id={id}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: 'fixed', left: place?.left ?? -9999, top: place?.top ?? -9999, zIndex: LAYER.popover }}
      className="w-[300px] max-w-[calc(100vw-16px)] rounded-[10px] border border-content/10 bg-background-base py-1.5 font-sans text-content"
    >
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
    </div>,
    document.body,
  );
}
