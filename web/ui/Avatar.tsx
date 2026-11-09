/**
 * Agent avatars: a soft flat shape in one colour, no outline and no gradient, with two small dark
 * eyes set a little off centre so it looks somewhere. Inline SVG on a 32px grid, crisp from 14 to
 * 40px. The eyes carry the mood (avatar.css): an occasional blink, a glance while working, a look
 * up while it waits for you, half-closed when the last turn failed. Motion stops for reduced motion.
 * Decorative: the agent's name always sits beside it.
 */
import type { Agent } from '../../shared/types.ts';
import { agentLook, avatarMood, type AvatarColor, type AvatarEyes, type AvatarLook, type AvatarMood, type AvatarShape } from '../../shared/avatar.ts';

/** Mid-tone fills that read on both the dark and the light theme. */
export const AVATAR_FILL: Record<AvatarColor, string> = {
  teal: '#2bb3a3',
  orange: '#f08a3c',
  indigo: '#5b6cf0',
  violet: '#9a63f2',
  rose: '#e8618c',
  amber: '#e2ab2f',
  green: '#4cb86a',
  sky: '#3fa7e8',
  coral: '#f26b5b',
  slate: '#7e8ca3',
};

const SHAPE: Record<AvatarShape, string> = {
  circle: 'M16 3a13 13 0 1 1 0 26 13 13 0 0 1 0-26Z',
  squircle: 'M16 3c9.4 0 13 3.6 13 13s-3.6 13-13 13S3 25.4 3 16 6.6 3 16 3Z',
  triangle: 'M16 3.6c1.5 0 2.9.8 3.7 2.2l9.1 15.8c1.6 2.8-.4 6.2-3.7 6.2H6.9c-3.3 0-5.3-3.4-3.7-6.2l9.1-15.8c.8-1.4 2.2-2.2 3.7-2.2Z',
  pebble: 'M16.4 3.6c7.3.2 12.7 5 12.6 11.9-.1 7.3-5.5 12.9-13.3 12.9C8.2 28.4 3 23.6 3 16.9 3 9.3 8.6 3.4 16.4 3.6Z',
  capsule: 'M16 2.5c5.5 0 10 4.5 10 10v7c0 5.5-4.5 10-10 10s-10-4.5-10-10v-7c0-5.5 4.5-10 10-10Z',
  pentagon: 'M13.7 3.8a3.9 3.9 0 0 1 4.6 0l9.3 6.8a3.9 3.9 0 0 1 1.4 4.4l-3.6 10.9a3.9 3.9 0 0 1-3.7 2.7H10.3a3.9 3.9 0 0 1-3.7-2.7L3 15a3.9 3.9 0 0 1 1.4-4.4Z',
  blob: 'M17.6 3.2c6 .5 11.1 5 11.4 11.1.4 6.8-4.1 13.4-11.2 14.4-6.6.9-13.6-2.8-14.6-9.4C2.2 12.6 6 6 11.6 4c1.9-.7 3.9-1 6-.8Z',
  diamond: 'M13.2 4.1a4 4 0 0 1 5.6 0l9.1 9.1a4 4 0 0 1 0 5.6l-9.1 9.1a4 4 0 0 1-5.6 0l-9.1-9.1a4 4 0 0 1 0-5.6Z',
};

/** Where the eyes sit: a little right of centre, lower in shapes that are heavier at the bottom. */
const EYE_Y: Record<AvatarShape, number> = {
  circle: 15, squircle: 15, triangle: 19.5, pebble: 15.5, capsule: 14.5, pentagon: 16.5, blob: 15.5, diamond: 16,
};

const EYE: Record<AvatarEyes, { rx: number; ry: number; gap: number }> = {
  round: { rx: 1.7, ry: 2.2, gap: 6 },
  tall: { rx: 1.4, ry: 2.9, gap: 5.6 },
  wide: { rx: 2, ry: 2.5, gap: 7 },
};

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
  const eye = EYE[look.eyes];
  const y = EYE_Y[look.shape];
  const x = 17; // off centre: it looks a little to its right
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      data-avatar-mood={mood}
      className={`avatar shrink-0 select-none ${animate ? 'avatar-live' : ''} ${className}`}
      style={{ ['--avatar-delay' as string]: delay(seed) }}
    >
      <path d={SHAPE[look.shape]} fill={AVATAR_FILL[look.color]} />
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
