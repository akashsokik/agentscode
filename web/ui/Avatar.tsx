/**
 * Agent avatars: a soft flat shape in one colour, no outline and no gradient, with two small dark
 * eyes set a little off centre so it looks somewhere. Inline SVG on a 32px grid, crisp from 14 to
 * 40px. The eyes carry the mood (avatar.css): an occasional blink, a glance while working, a look
 * up while it waits for you, half-closed when the last turn failed. Motion stops for reduced motion.
 * Decorative: the agent's name always sits beside it.
 */
import type { Agent } from '../../shared/types.ts';
import { AVATAR_FILL, AVATAR_INK, agentLook, avatarDelay, avatarMood, avatarParts, isSmallAvatar, type AvatarLook, type AvatarMood } from '../../shared/avatar.ts';

export { AVATAR_FILL };


/**
 * The px size a Tailwind size class asks for (size-4 is 16px, size-[18px] is 18px); 1em and
 * anything unknown count as small, so text-sized avatars get the simplified face.
 */
export function classSize(className: string): number {
  const step = /(?:^|\s)size-(\d+(?:\.\d+)?)(?:\s|$)/.exec(className);
  if (step) return Number(step[1]) * 4;
  const px = /(?:^|\s)size-\[(\d+(?:\.\d+)?)px\]/.exec(className);
  return px ? Number(px[1]) : 16;
}

export function AvatarGlyph({ look, mood = 'calm', seed = '', className = 'size-4', animate = true }: {
  look: AvatarLook;
  mood?: AvatarMood;
  /** Spreads blinks out between avatars (the agent id). */
  seed?: string;
  className?: string;
  animate?: boolean;
}) {
  const parts = avatarParts(look, mood, isSmallAvatar(classSize(className)));
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      data-avatar-mood={mood}
      className={`avatar shrink-0 select-none ${animate ? 'avatar-live' : ''} ${className}`}
      style={{ ['--avatar-delay' as string]: avatarDelay(seed) }}
    >
      {parts.map((part, i) => (part.kind === 'body' ? <path key={i} d={part.d} fill={part.fill} /> : null))}
      {/* The pills move as one (glance, look up); each blinks or flattens to a dash on its own. */}
      <g className="avatar-eyes">
        {parts.map((part, i) => {
          if (part.kind === 'eye') return <rect key={i} className="avatar-eye" x={part.x} y={part.y} width={part.w} height={part.h} rx={part.w / 2} fill={AVATAR_INK} />;
          if (part.kind === 'happy') return <path key={i} d={part.d} fill="none" stroke={AVATAR_INK} strokeWidth={part.width} strokeLinecap="round" />;
          return null;
        })}
      </g>
    </svg>
  );
}

/** An agent's avatar: its own look and the mood of its status. */
export function AgentAvatar({ agent, className = 'size-4', animate = true }: {
  /** Just an id is enough (a removed agent keeps the look its id gives it). */
  agent: { id: string; role?: Agent['role']; avatar?: Agent['avatar']; status?: Agent['status'] };
  className?: string;
  animate?: boolean;
}) {
  return <AvatarGlyph look={agentLook(agent)} mood={avatarMood(agent.status)} seed={agent.id} className={className} animate={animate} />;
}
