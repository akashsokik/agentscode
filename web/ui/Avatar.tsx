/**
 * Agent avatars: a soft flat shape in one colour, no outline and no gradient, with two small dark
 * eyes set a little off centre so it looks somewhere. Inline SVG on a 32px grid, crisp from 14 to
 * 40px. The eyes carry the mood (avatar.css): an occasional blink, a glance while working, a look
 * up while it waits for you, half-closed when the last turn failed. Motion stops for reduced motion.
 * Decorative: the agent's name always sits beside it.
 */
import type { Agent } from '../../shared/types.ts';
import { useId } from 'react';
import { AVATAR_FILL, AVATAR_INK, AVATAR_INK_LIGHT, AVATAR_SHADOW_PX, agentLook, avatarDelay, avatarMood, avatarParts, isSmallAvatar, type AvatarLook, type AvatarMood } from '../../shared/avatar.ts';

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
  const px = classSize(className);
  const parts = avatarParts(look, mood, isSmallAvatar(px), px >= AVATAR_SHADOW_PX);
  // Gradient ids unique to this avatar, so a hundred inline SVGs never share or clash.
  const base = `av${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const ids = { body: `${base}b`, eye: `${base}e`, shine: `${base}s`, shadow: `${base}c` };
  const body = parts.find(p => p.kind === 'body');
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      data-avatar-mood={mood}
      className={`avatar shrink-0 select-none ${animate ? 'avatar-live' : ''} ${className}`}
      style={{ ['--avatar-delay' as string]: avatarDelay(seed) }}
    >
      <defs>
        {body?.kind === 'body' ? (
          <radialGradient id={ids.body} cx="0.36" cy="0.3" r="0.78">
            <stop offset="0" stopColor={body.light} />
            <stop offset="0.55" stopColor={body.mid} />
            <stop offset="1" stopColor={body.rim} />
          </radialGradient>
        ) : null}
        <linearGradient id={ids.eye} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.45" stopColor={AVATAR_INK} />
          <stop offset="1" stopColor={AVATAR_INK_LIGHT} />
        </linearGradient>
        <radialGradient id={ids.shine}>
          <stop offset="0" stopColor="#fff" stopOpacity={0.75} />
          <stop offset="1" stopColor="#fff" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={ids.shadow}>
          <stop offset="0" stopColor="#000" stopOpacity={0.32} />
          <stop offset="1" stopColor="#000" stopOpacity={0} />
        </radialGradient>
      </defs>
      {parts.map((part, i) => {
        if (part.kind === 'shadow') return <ellipse key={i} cx={part.cx} cy={part.cy} rx={part.rx} ry={part.ry} fill={`url(#${ids.shadow})`} />;
        if (part.kind === 'body') return <path key={i} d={part.d} fill={`url(#${ids.body})`} />;
        if (part.kind === 'shine') return <ellipse key={i} cx={part.cx} cy={part.cy} rx={part.rx} ry={part.ry} transform={`rotate(${part.rotate} ${part.cx} ${part.cy})`} fill={`url(#${ids.shine})`} />;
        return null;
      })}
      {/* The face moves as one: gaze, glance and look up; each eye blinks or half-closes on its own. */}
      <g className="avatar-eyes">
        {parts.map((part, i) => {
          if (part.kind === 'eye') return <ellipse key={i} className="avatar-eye" cx={part.cx} cy={part.cy} rx={part.rx} ry={part.ry} fill={`url(#${ids.eye})`} />;
          if (part.kind === 'glint') return <circle key={i} className="avatar-glint" cx={part.cx} cy={part.cy} r={part.r} fill="#fff" />;
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
