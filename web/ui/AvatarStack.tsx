import type { Agent } from '../../shared/types.ts';
import { AgentAvatar } from './Avatar.tsx';

/**
 * A group of agents at a glance: up to `max` avatars overlapping a little, each on a disc in the
 * surface colour (`ring`) so neighbours separate cleanly, then "+N". Decorative: the caller says
 * who they are in text or a title. Used for channel members, thread participants and the status bar.
 */
export function AvatarStack({ agents, max = 4, size = 'size-4', ring = 'bg-background-base', animate = false }: {
  /** An agent, or just an id for one that was removed (it keeps the look its id gives it). */
  agents: { id: string; role?: Agent['role']; avatar?: Agent['avatar']; status?: Agent['status'] }[];
  max?: number;
  /** The avatar's size class; the disc is a pixel wider all round. */
  size?: string;
  /** The background behind the stack, so each disc reads as a gap. */
  ring?: string;
  animate?: boolean;
}) {
  const shown = agents.slice(0, max);
  const more = agents.length - shown.length;
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((agent, i) => (
        <span key={agent.id} className={`grid place-items-center rounded-full p-px ${ring} ${i ? '-ml-1.5' : ''}`} style={{ zIndex: shown.length - i }}>
          <AgentAvatar agent={agent} className={size} animate={animate} />
        </span>
      ))}
      {more > 0 ? (
        <span className={`-ml-1 grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-medium tabular-nums text-content/70 ${ring}`}>
          <span className="rounded-full bg-content/10 px-1 leading-4">+{more}</span>
        </span>
      ) : null}
    </span>
  );
}
