// Agent avatars: a soft flat shape in one colour with two small eyes, so agents tell apart at a
// glance (the engine mark made them all look alike). Pure, shared by the server (validation, a new
// agent's look) and the app (drawing), so it is tested directly.

export const AVATAR_SHAPES = ['circle', 'squircle', 'triangle', 'pebble', 'capsule', 'pentagon', 'blob', 'diamond'] as const;
export const AVATAR_COLORS = ['teal', 'orange', 'indigo', 'violet', 'rose', 'amber', 'green', 'sky', 'coral', 'slate'] as const;
export const AVATAR_EYES = ['round', 'tall', 'wide'] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
export type AvatarEyes = (typeof AVATAR_EYES)[number];

export interface AvatarLook {
  shape: AvatarShape;
  color: AvatarColor;
  eyes: AvatarEyes;
}

/** The SuperAgent's own look, the same everywhere: a violet blob with wide eyes. */
export const SUPER_LOOK: AvatarLook = { shape: 'blob', color: 'violet', eyes: 'wide' };

/** FNV-1a over the id: small, stable across restarts and platforms. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The look an agent has until one is chosen: from its id, so it never changes on its own. */
export function lookFromId(id: string): AvatarLook {
  const h = hash(id);
  return {
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length],
    color: AVATAR_COLORS[Math.floor(h / AVATAR_SHAPES.length) % AVATAR_COLORS.length],
    eyes: AVATAR_EYES[Math.floor(h / (AVATAR_SHAPES.length * AVATAR_COLORS.length)) % AVATAR_EYES.length],
  };
}

export function isLook(value: unknown): value is AvatarLook {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (AVATAR_SHAPES as readonly unknown[]).includes(v.shape)
    && (AVATAR_COLORS as readonly unknown[]).includes(v.color)
    && (AVATAR_EYES as readonly unknown[]).includes(v.eyes);
}

/** The stored look, cleaned: only the three known fields, or null when it is not a valid look. */
export function cleanLook(value: unknown): AvatarLook | null {
  if (!isLook(value)) return null;
  return { shape: value.shape, color: value.color, eyes: value.eyes };
}

/** What an agent looks like: its chosen look, the SuperAgent's fixed one, or the one from its id. */
export function agentLook(agent: { id: string; role?: string; avatar?: unknown }): AvatarLook {
  if (agent.role === 'super') return SUPER_LOOK;
  return cleanLook(agent.avatar) ?? lookFromId(agent.id);
}

const key = (look: AvatarLook) => `${look.shape}:${look.color}`;

/**
 * A look for a new agent: random, avoiding a shape and colour pair another agent already has (and
 * the SuperAgent's) while any is free. `random` returns [0, 1), for tests.
 */
export function freshLook(taken: AvatarLook[], random: () => number = Math.random): AvatarLook {
  const used = new Set([...taken, SUPER_LOOK].map(key));
  const free: AvatarLook[] = [];
  for (const shape of AVATAR_SHAPES) {
    for (const color of AVATAR_COLORS) if (!used.has(`${shape}:${color}`)) free.push({ shape, color, eyes: 'round' });
  }
  const pick = <T,>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const base = free.length ? pick(free) : { shape: pick(AVATAR_SHAPES), color: pick(AVATAR_COLORS), eyes: 'round' as AvatarEyes };
  return { ...base, eyes: pick(AVATAR_EYES) };
}

/** How the eyes look for an agent's status: calm, busy (glancing), waiting on you (looking up), or down. */
export type AvatarMood = 'calm' | 'busy' | 'waiting' | 'down';

export function avatarMood(status: string | undefined): AvatarMood {
  if (status === 'working') return 'busy';
  if (status === 'waiting') return 'waiting';
  if (status === 'error') return 'down';
  return 'calm';
}
