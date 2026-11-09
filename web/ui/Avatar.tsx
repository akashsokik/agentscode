/**
 * Agent avatars: a soft flat shape in one colour, no outline and no gradient, with two small dark
 * eyes set a little off centre so it looks somewhere. Inline SVG on a 32px grid, crisp from 14 to
 * 40px. The eyes carry the mood (avatar.css): an occasional blink, a glance while working, a look
 * up while it waits for you, half-closed when the last turn failed. Motion stops for reduced motion.
 * Decorative: the agent's name always sits beside it.
 */
import type { Agent } from '../../shared/types.ts';
import { AVATAR_EYE, AVATAR_EYE_X, AVATAR_EYE_Y, AVATAR_FILL, AVATAR_PATH, agentLook, avatarMood, type AvatarLook, type AvatarMood } from '../../shared/avatar.ts';

export { AVATAR_FILL };

/** A stable delay per avatar, so a row of them never blinks in step. */
function delay(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return `${-(h % 70) / 10}s`;
}

export function AvatarGlyph({ look, mood = 'calm', seed = '', className = 'size-4', animate = true }: {
  look: AvatarLook;
  mood?: AvatarMood;
  /** Spreads blinks out between avatars (the agent id). */
  seed?: string;
  className?: string;
  animate?: boolean;
}) {
  const eye = AVATAR_EYE[look.eyes];
  const y = AVATAR_EYE_Y[look.shape];
  const x = AVATAR_EYE_X; // off centre: it looks a little to its right
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      data-avatar-mood={mood}
      className={`avatar shrink-0 select-none ${animate ? 'avatar-live' : ''} ${className}`}
      style={{ ['--avatar-delay' as string]: delay(seed) }}
    >
      <path d={AVATAR_PATH[look.shape]} fill={AVATAR_FILL[look.color]} />
      <g className="avatar-eyes" fill="#141418">
        <ellipse className="avatar-eye" cx={x - eye.gap / 2} cy={y} rx={eye.rx} ry={eye.ry} />
        <ellipse className="avatar-eye" cx={x + eye.gap / 2} cy={y} rx={eye.rx} ry={eye.ry} />
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
