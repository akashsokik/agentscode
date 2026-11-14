/**
 * Agent avatars: a flat tilted shape in one colour, no outline and no gradient, with two dark pill
 * eyes set high and to one side, turned with the body. Inline SVG on a 32px grid, crisp from 14 to
 * 96px. The eyes carry the mood (styles.css): an occasional blink, a glance while working, a look
 * up while it waits for you, flattened to dashes when the last turn failed. Motion stops for reduced motion.
 * Decorative: the agent's name always sits beside it.
 */
import type { Agent } from '../../shared/types.ts';
import { useAvatarStyle } from '../avatarStyle.ts';
import { colourParts, inkParts } from '../avatarStylePreference.ts';
import { avatarFitTransform } from './avatarFit.ts';
import { AVATAR_FILL, agentLook, avatarDelay, avatarEyeTransform, avatarMood, avatarParts, isSmallAvatar, type AvatarLook, type AvatarMood } from '../../shared/avatar.ts';

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

export function AvatarGlyph({ look, mood = 'calm', seed = '', className = 'size-4', animate = true, colour = false, ink: alwaysInk = false, fit = false }: {
  look: AvatarLook;
  mood?: AvatarMood;
  /** Spreads blinks out between avatars (the agent id). */
  seed?: string;
  className?: string;
  animate?: boolean;
  /** Always in colour, whatever the Avatars setting: where a colour is being chosen (the avatar picker). */
  colour?: boolean;
  /** Always in ink, whatever the Avatars setting: the app's logo (BrandMark, ACH-D63). */
  ink?: boolean;
  /** Every shape at one visual size, centred: for a column of rows (the sidebar's Agents, ACH-49). */
  fit?: boolean;
}) {
  // Appearance > Avatars (ACH-46, ACH-D64): every avatar follows it, the SuperAgent included: all
  // in ink, or all in colour (the SuperAgent's Block in its violet, with the usual dark pills).
  const ink = alwaysInk || (useAvatarStyle() === 'ink' && !colour);
  const drawn = avatarParts(look, mood, isSmallAvatar(classSize(className)));
  const parts = ink ? inkParts(drawn) : colourParts(look, drawn);
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden
      focusable="false"
      data-avatar-mood={mood}
      className={`avatar shrink-0 select-none ${animate ? 'avatar-live' : ''} ${className}`}
      style={{ ['--avatar-delay' as string]: avatarDelay(seed) }}
    >
      <g transform={fit ? avatarFitTransform(look.shape) : undefined}>
        {parts.map((part, i) => (part.kind === 'body' ? <path key={i} d={part.d} fill={part.fill} /> : null))}
        {/* The pills move as one (glance, look up) in the outer group; the inner one turns them with the body. Each blinks or flattens to a dash on its own. */}
        <g className="avatar-eyes">
          <g transform={avatarEyeTransform(look)}>
            {parts.map((part, i) => (part.kind === 'eye' ? <rect key={i} className="avatar-eye" x={part.x} y={part.y} width={part.w} height={part.h} rx={part.w / 2} fill={part.fill} /> : null))}
          </g>
        </g>
      </g>
    </svg>
  );
}

/** An agent's avatar: its own look and the mood of its status. */
export function AgentAvatar({ agent, className = 'size-4', animate = true, fit = false }: {
  /** Just an id is enough (a removed agent keeps the look its id gives it). */
  agent: { id: string; role?: Agent['role']; avatar?: Agent['avatar']; status?: Agent['status'] };
  className?: string;
  animate?: boolean;
  /** One visual size for every shape (AvatarGlyph's fit). */
  fit?: boolean;
}) {
  return <AvatarGlyph look={agentLook(agent)} mood={avatarMood(agent.status)} seed={agent.id} className={className} animate={animate} fit={fit} />;
}
