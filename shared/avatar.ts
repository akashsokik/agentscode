// Agent avatars: a flat shape in one colour with two pill eyes, so agents tell apart at a glance
// (the engine mark made them all look alike). Each shape is a simple geometric idea (a disc, a
// pentagon, a pick, a tile...) with soft corners, its sides a little unequal, tilted; the eyes tilt
// with the body. Pure, shared by the server (validation, a new agent's look) and the app (drawing),
// so it is tested directly.

/** Every shape that can be drawn. The Cloud is the SuperAgent's; AGENT_SHAPES are the ones agents are given. */
export const AVATAR_SHAPES = ['disc', 'pentagon', 'pick', 'tile', 'dome', 'bean', 'arch', 'almond', 'slice', 'bucket', 'kite', 'cloud'] as const;
export const AVATAR_COLORS = ['teal', 'orange', 'indigo', 'violet', 'rose', 'amber', 'green', 'sky', 'coral', 'slate', 'olive', 'plum'] as const;
export const AVATAR_EYES = ['round', 'tall', 'wide'] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];
export type AvatarColor = (typeof AVATAR_COLORS)[number];
export type AvatarEyes = (typeof AVATAR_EYES)[number];

/** The shapes a new agent can get and the picker offers: every one but the SuperAgent's Cloud. */
export const AGENT_SHAPES: readonly AvatarShape[] = AVATAR_SHAPES.filter(shape => shape !== 'cloud');

export interface AvatarLook {
  shape: AvatarShape;
  color: AvatarColor;
  eyes: AvatarEyes;
}

/**
 * The first set's shape names, as agents made before this set have them stored, and the new shape
 * nearest each: Bun, Lumpy square, Gumdrop, Pebble, Bulb, Clover, Cloud and Leaf. A stored look
 * keeps its colour and eyes; only the name moves (cleanLook).
 */
export const LEGACY_SHAPES: Readonly<Record<string, AvatarShape>> = {
  circle: 'disc', squircle: 'tile', triangle: 'dome', pebble: 'bean', capsule: 'arch', pentagon: 'pentagon', blob: 'cloud', diamond: 'almond',
};

/** The SuperAgent's own look, the same everywhere: the violet Cloud. */
export const SUPER_LOOK: AvatarLook = { shape: 'cloud', color: 'violet', eyes: 'round' };

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
    shape: AGENT_SHAPES[h % AGENT_SHAPES.length],
    color: AVATAR_COLORS[Math.floor(h / AGENT_SHAPES.length) % AVATAR_COLORS.length],
    eyes: AVATAR_EYES[Math.floor(h / (AGENT_SHAPES.length * AVATAR_COLORS.length)) % AVATAR_EYES.length],
  };
}

export function isLook(value: unknown): value is AvatarLook {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (AVATAR_SHAPES as readonly unknown[]).includes(v.shape)
    && (AVATAR_COLORS as readonly unknown[]).includes(v.color)
    && (AVATAR_EYES as readonly unknown[]).includes(v.eyes);
}

/**
 * The stored look, cleaned: only the three known fields, a shape name from the first set moved to
 * the new shape nearest it (LEGACY_SHAPES), or null when it is not a valid look.
 */
export function cleanLook(value: unknown): AvatarLook | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const named = typeof v.shape === 'string' && !(AVATAR_SHAPES as readonly string[]).includes(v.shape) && Object.hasOwn(LEGACY_SHAPES, v.shape) ? LEGACY_SHAPES[v.shape] : v.shape;
  const look = { shape: named, color: v.color, eyes: v.eyes };
  return isLook(look) ? look : null;
}

/**
 * Stored looks from the first set, moved to this one: the agent id to its look under the new shape
 * name, for every agent whose stored look reads differently once cleaned. Colours and eyes are kept.
 */
export function migrateLooks(agents: { id: string; avatar?: unknown }[]): Map<string, AvatarLook> {
  const out = new Map<string, AvatarLook>();
  for (const agent of agents) {
    if (agent.avatar === undefined || isLook(agent.avatar)) continue;
    const look = cleanLook(agent.avatar);
    if (look) out.set(agent.id, look);
  }
  return out;
}

/** What an agent looks like: its chosen look, the SuperAgent's fixed one, or the one from its id. */
export function agentLook(agent: { id: string; role?: string; avatar?: unknown }): AvatarLook {
  if (agent.role === 'super') return SUPER_LOOK;
  return cleanLook(agent.avatar) ?? lookFromId(agent.id);
}

const key = (look: AvatarLook) => `${look.shape}:${look.color}`;

/** The SuperAgent's shape and colour pair, which no other agent may take. */
export function isSuperPair(look: Pick<AvatarLook, 'shape' | 'color'>): boolean {
  return look.shape === SUPER_LOOK.shape && look.color === SUPER_LOOK.color;
}

/**
 * A look for a new agent: random, avoiding a shape and colour pair another agent already has (and
 * the SuperAgent's) while any is free. `random` returns [0, 1), for tests.
 */
export function freshLook(taken: AvatarLook[], random: () => number = Math.random): AvatarLook {
  const used = new Set([...taken, SUPER_LOOK].map(key));
  const free: AvatarLook[] = [];
  for (const shape of AGENT_SHAPES) {
    for (const color of AVATAR_COLORS) if (!used.has(`${shape}:${color}`)) free.push({ shape, color, eyes: 'round' });
  }
  const pick = <T,>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  // Prefer the colours (then shapes) fewest agents have, so a team reads apart at a glance.
  const uses = (field: 'color' | 'shape', value: string) => taken.filter(l => l[field] === value).length;
  const least = (list: AvatarLook[], field: 'color' | 'shape') => {
    const min = Math.min(...list.map(l => uses(field, l[field])));
    return list.filter(l => uses(field, l[field]) === min);
  };
  const pool = free.length ? least(least(free, 'color'), 'shape') : [];
  let base = pool.length ? pick(pool) : { shape: pick(AGENT_SHAPES), color: pick(AVATAR_COLORS), eyes: 'round' as AvatarEyes };
  // Every pair taken: a random one, but never the SuperAgent's.
  if (isSuperPair(base)) base = { ...base, color: AVATAR_COLORS.find(c => c !== SUPER_LOOK.color)! };
  return { ...base, eyes: pick(AVATAR_EYES) };
}

/**
 * Looks for agents made before avatars: each without a stored look (the SuperAgent aside) gets a
 * free shape and colour pair once, so the team never comes out all one colour from id hashes.
 * Returns the agent id to its new look; agents with a look keep it and count as taken.
 */
export function assignLooks(agents: { id: string; role?: string; avatar?: unknown }[], random: () => number = Math.random): Map<string, AvatarLook> {
  // A look stored under a first-set shape name is a look (migrateLooks moves it); it is not replaced.
  const taken = agents.filter(a => a.role !== 'super').map(a => cleanLook(a.avatar)).filter((look): look is AvatarLook => look !== null);
  const out = new Map<string, AvatarLook>();
  for (const agent of agents) {
    if (agent.role === 'super' || cleanLook(agent.avatar)) continue;
    const look = freshLook(taken, random);
    taken.push(look);
    out.set(agent.id, look);
  }
  return out;
}

/**
 * How the face looks for an agent's status: calm when idle or done, lively while working, attentive
 * (eyes up) while it waits on you, tired after a failed turn. Only the eyes say it.
 */
export type AvatarMood = 'calm' | 'busy' | 'waiting' | 'down';

export function avatarMood(status: string | undefined): AvatarMood {
  if (status === 'working') return 'busy';
  if (status === 'waiting') return 'waiting';
  if (status === 'error') return 'down';
  return 'calm';
}

// ---- drawing: one list of parts that the Avatar component, the gallery and the demo all draw ----
//
// The style: FLAT. One solid colour, no gradient, highlight, shadow or outline; character comes from
// a clean shape with soft corners, tilted, and two tall near-black pill eyes set close together, high
// and to one side, turned with the body. No mouth. Our own shapes.

/** Rich, slightly muted fills that hold on the dark and the light theme. */
export const AVATAR_FILL: Record<AvatarColor, string> = {
  teal: '#2f9e8f',
  orange: '#df7a36',
  indigo: '#5b63d3',
  violet: '#8b5cd6',
  rose: '#d24b7f',
  amber: '#d9a02f',
  green: '#4a9f63',
  sky: '#3b8dd0',
  coral: '#d85c47',
  slate: '#737c9c',
  olive: '#93a23a',
  plum: '#a6549c',
};

/** Twelve silhouettes on a 32-unit grid: polygons with rounded corners, already tilted. */
export const AVATAR_PATH: Record<AvatarShape, string> = {
  // A slightly squashed circle.
  disc: 'M8.52 4.35C11.38 2.77 15.14 1.97 18.40 2.25L18.40 2.25C21.66 2.53 24.84 4.20 26.78 6.65L26.78 6.65C28.72 9.10 30.04 12.47 30.25 15.50L30.25 15.50C30.47 18.54 29.43 22.00 27.51 24.61L27.51 24.61C25.60 27.22 22.44 29.08 19.19 29.51L19.19 29.51C15.94 29.94 12.16 29.42 9.24 28.15L9.24 28.15C6.32 26.87 3.93 24.30 2.96 21.38L2.96 21.38C1.99 18.46 1.87 14.81 2.65 11.78L2.65 11.78C3.42 8.76 5.65 5.93 8.52 4.35Z',
  // A house shape: one point up, flat base.
  pentagon: 'M13.38 3.70C16.11 2.27 19.12 2.73 21.30 4.89L26.37 9.90C28.56 12.07 29.11 15.10 27.82 17.89L24.02 26.10C22.73 28.89 20.07 30.33 17.03 29.89L9.23 28.75C6.19 28.31 4.10 26.17 3.73 23.12L2.69 14.51C2.33 11.46 3.77 8.71 6.50 7.29Z',
  // A guitar pick: wide flat top narrowing to a point.
  pick: 'M4.70 8.01C3.41 3.91 5.21 1.89 9.43 2.68L21.52 4.95C26.39 5.86 27.59 8.88 24.68 12.89L15.57 25.43C13.24 28.63 11.09 28.28 9.90 24.50Z',
  // A soft square, tilted, no two sides the same.
  tile: 'M3.31 14.49C2.28 9.91 4.44 6.41 9.00 5.27L17.22 3.23C21.78 2.09 25.26 4.19 26.38 8.75L28.53 17.47C29.66 22.03 27.56 25.51 23.00 26.63L14.28 28.79C9.72 29.91 6.30 27.79 5.27 23.22Z',
  // Round on top, flat on the bottom.
  dome: 'M4.95 25.29C2.75 24.94 1.66 23.38 2.08 21.20L2.53 18.84C3.23 15.19 5.02 11.32 7.23 8.66L7.23 8.66C9.45 6.01 12.48 4.10 15.20 3.64L15.20 3.64C17.92 3.17 20.99 3.80 23.28 5.28L23.28 5.28C25.57 6.75 27.67 9.58 28.79 12.70L28.79 12.70C29.91 15.83 30.30 19.90 29.80 23.43L29.50 25.55C29.19 27.76 27.65 28.89 25.45 28.54Z',
  // A lying-down capsule, tilted up to the right.
  bean: 'M2.64 19.08C1.87 15.99 2.48 13.05 4.25 11.36L4.25 11.36C6.02 9.67 9.48 8.04 13.37 7.07L14.13 6.88C18.02 5.91 21.86 5.82 24.26 6.63L24.26 6.63C26.65 7.44 28.59 9.83 29.36 12.92L29.36 12.92C30.13 16.01 29.52 18.95 27.75 20.64L27.75 20.64C25.98 22.33 22.52 23.96 18.63 24.93L17.87 25.12C13.98 26.09 10.14 26.18 7.74 25.37L7.74 25.37C5.35 24.56 3.41 22.17 2.64 19.08Z',
  // A tall arch: narrow, round head, square feet.
  arch: 'M13.39 29.68C11.41 30.25 9.81 29.40 9.18 27.43L6.72 19.70C5.55 16.02 5.08 12.15 5.50 9.52L5.50 9.52C5.92 6.89 7.09 4.54 8.59 3.34L8.59 3.34C10.09 2.14 12.18 1.54 14.08 1.76L14.08 1.76C15.99 1.98 18.23 3.35 19.98 5.37L19.98 5.37C21.73 7.38 23.39 10.91 24.35 14.65L26.35 22.51C26.86 24.51 25.96 26.08 23.98 26.65Z',
  // A leaf with two soft points.
  almond: 'M4.32 29.38C2.51 29.44 1.52 28.37 1.71 26.57L2.24 21.62C2.76 16.74 5.11 11.94 8.42 8.98L8.42 8.98C11.73 6.02 16.95 3.89 22.18 3.37L27.69 2.81C29.50 2.63 30.49 3.63 30.30 5.43L29.76 10.67C29.24 15.71 26.99 20.73 23.86 23.86L23.86 23.86C20.73 26.99 15.50 29.02 10.10 29.20Z',
  // A quarter of a pie: two straight sides, one long curve.
  slice: 'M3.99 5.29C4.19 2.88 5.80 1.42 8.22 1.45L10.31 1.48C14.02 1.54 18.16 2.59 21.19 4.26L21.19 4.26C24.23 5.93 26.80 9.00 27.98 12.34L27.98 12.34C29.15 15.67 29.50 20.16 28.91 24.16L28.53 26.74C28.18 29.13 26.49 30.41 24.09 30.11L6.01 27.83C3.61 27.53 2.26 25.86 2.46 23.45Z',
  // A trapezoid: narrow shoulders, wide base.
  bucket: 'M4.21 9.77C4.65 6.08 7.16 3.46 10.83 2.89L14.32 2.33C17.99 1.75 21.09 3.51 22.49 6.95L27.68 19.68C29.28 23.61 27.69 26.43 23.50 27.11L8.50 29.52C4.31 30.19 2.05 28.02 2.55 23.81Z',
  // A leaning diamond with four soft corners.
  kite: 'M10.11 6.72C11.75 3.42 14.80 2.37 18.13 3.96L23.82 6.67C27.50 8.43 28.65 11.75 26.82 15.40L21.89 25.28C20.25 28.58 17.20 29.63 13.87 28.04L8.18 25.33C4.50 23.57 3.35 20.25 5.18 16.60Z',
  // Three bumps over a flat-ish base. The SuperAgent's.
  cloud: 'M5.50 25.25C3.95 23.23 3.10 20.67 3.25 18.50L3.26 18.39C3.41 16.29 4.36 14.34 5.75 13.25L6.26 12.85C7.34 12.01 8.20 10.69 8.53 9.37L8.75 8.50C9.21 6.64 10.54 5.03 12.25 4.25L12.25 4.25C13.96 3.48 15.86 3.48 17.25 4.25L17.93 4.63C18.90 5.17 19.98 5.33 20.75 5.05L20.75 5.05C21.52 4.77 22.95 5.15 24.50 6.05L24.50 6.05C26.05 6.95 27.04 8.54 27.10 10.25L27.11 10.60C27.17 12.09 27.68 13.77 28.47 15.04L28.60 15.25C29.47 16.64 29.81 18.73 29.50 20.75L29.50 20.75C29.19 22.77 28.05 24.76 26.50 26.00L26.50 26.00C24.95 27.24 22.10 28.06 19.00 28.16L13.00 28.34C9.90 28.44 7.05 27.27 5.50 25.25Z',
};

/** What each shape is called, for the picker. */
export const AVATAR_SHAPE_NAMES: Record<AvatarShape, string> = {
  disc: 'Disc', pentagon: 'Pentagon', pick: 'Pick', tile: 'Tile', dome: 'Dome', bean: 'Bean', arch: 'Arch', almond: 'Almond', slice: 'Slice', bucket: 'Bucket', kite: 'Kite', cloud: 'Cloud',
};

/** How far each body is tilted, in degrees; its eyes turn with it (avatarEyeTurn). */
export const AVATAR_TILT: Record<AvatarShape, number> = { disc: -12, pentagon: 10, pick: 14, tile: -9, dome: 8, bean: -14, arch: -16, almond: 0, slice: 6, bucket: -7, kite: 4, cloud: -6 };

/** Where the eyes sit on each silhouette: high and to one side (the eye style moves them off it). */
export const AVATAR_EYE_AT: Record<AvatarShape, { x: number; y: number }> = {
  disc: { x: 19.24, y: 11.3 }, pentagon: { x: 18.8, y: 15.48 }, pick: { x: 16.2, y: 10.83 }, tile: { x: 18.66, y: 12.48 }, dome: { x: 20.93, y: 14.87 }, bean: { x: 20.63, y: 12.32 }, arch: { x: 15.27, y: 9.47 }, almond: { x: 19.14, y: 13.08 }, slice: { x: 11.39, y: 19.15 }, bucket: { x: 16.67, y: 12.72 }, kite: { x: 18.95, y: 13.44 }, cloud: { x: 19, y: 16.6 },
};

/** Eye placements: the gaze. Where the shape puts them, a little down and left, or a little up and right. */
export const AVATAR_EYE: Record<AvatarEyes, { dx: number; dy: number }> = {
  round: { dx: 0, dy: 0 },
  tall: { dx: -1.6, dy: 1.4 },
  wide: { dx: 0.9, dy: -0.8 },
};

/**
 * Two bodies are too narrow where their eyes sit for the usual up-and-right gaze to stay inside at
 * small sizes: the Bean looks less far, and the Arch, whose eyes are already at the top, looks right
 * and down instead.
 */
const AVATAR_EYE_WIDE: Partial<Record<AvatarShape, { dx: number; dy: number }>> = {
  bean: { dx: 0.7, dy: -0.3 },
  arch: { dx: 0.8, dy: 1.2 },
};

/** The pill eyes: tall, narrow, rounded, near-black, close together. */
export const AVATAR_PILL = { w: 2.5, h: 6.4, gap: 4.9 };
export const AVATAR_INK = '#141416';
/** Below this many px the pills are drawn bigger so they stay visible at 14 to 16px. */
export const AVATAR_SMALL_PX = 18;
/** The eyes lean a touch more than the body does. */
const EYE_LEAN = 8;

export type AvatarPart =
  | { kind: 'body'; d: string; fill: string }
  /** A pill eye: a rounded rect (rx is half the width), before the pair is turned (avatarEyeTurn). */
  | { kind: 'eye'; x: number; y: number; w: number; h: number };

/** Where a look's pair of eyes is centred. */
function eyeCentre(look: AvatarLook): { x: number; y: number } {
  const at = AVATAR_EYE_AT[look.shape];
  const place = (look.eyes === 'wide' ? AVATAR_EYE_WIDE[look.shape] : undefined) ?? AVATAR_EYE[look.eyes];
  return { x: +(at.x + place.dx).toFixed(2), y: +(at.y + place.dy).toFixed(2) };
}

/** The turn the pair of eyes takes with its body: degrees about the pair's centre. */
export function avatarEyeTurn(look: AvatarLook): { deg: number; x: number; y: number } {
  return { deg: AVATAR_TILT[look.shape] + EYE_LEAN, ...eyeCentre(look) };
}

/** The turn as an SVG transform, for the group that holds the two pills. */
export function avatarEyeTransform(look: AvatarLook): string {
  const turn = avatarEyeTurn(look);
  return `rotate(${turn.deg} ${turn.x} ${turn.y})`;
}

/**
 * Everything one avatar draws: a flat body and two pill eyes. The moods move the pills with CSS
 * (glance, look up, tired dashes); none changes their shape. `small` (under 18px) draws the pills
 * about a third bigger.
 */
export function avatarParts(look: AvatarLook, _mood: AvatarMood, small: boolean): AvatarPart[] {
  const w = +(AVATAR_PILL.w * (small ? 1.32 : 1)).toFixed(2);
  const h = +(AVATAR_PILL.h * (small ? 1.32 : 1)).toFixed(2);
  const gap = AVATAR_PILL.gap * (small ? 1.18 : 1);
  const { x: cx, y: cy } = eyeCentre(look);
  const parts: AvatarPart[] = [{ kind: 'body', d: AVATAR_PATH[look.shape], fill: AVATAR_FILL[look.color] }];
  for (const x of [cx - gap / 2, cx + gap / 2]) parts.push({ kind: 'eye', x: +(x - w / 2).toFixed(2), y: +(cy - h / 2).toFixed(2), w, h });
  return parts;
}

/** Whether a size in px gets the bigger pills. */
export const isSmallAvatar = (px: number) => px < AVATAR_SMALL_PX;

/** A stable blink delay per avatar, so a row of them never blinks in step. */
export function avatarDelay(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return `${-(h % 70) / 10}s`;
}

/** How the CSS moods sit in a still frame: the gaze offset and the pill height (the CSS animates these). */
export function moodEyes(mood: AvatarMood): { dy: number; scaleY: number } {
  if (mood === 'waiting') return { dy: -1.8, scaleY: 1 };
  if (mood === 'down') return { dy: 0.6, scaleY: 0.28 };
  return { dy: 0, scaleY: 1 };
}

/**
 * One avatar as SVG markup, the same structure the app's component renders (classes for the CSS
 * moods). `still` bakes the mood's resting pose in, for galleries and PNGs.
 */
export function avatarMarkup(look: AvatarLook, mood: AvatarMood, size: number, options: { x?: number; y?: number; seed?: string; live?: boolean; still?: boolean } = {}): string {
  const parts = avatarParts(look, mood, isSmallAvatar(size));
  const m = options.still ? moodEyes(mood) : { dy: 0, scaleY: 1 };
  const body = parts.filter(p => p.kind === 'body').map(p => `<path d="${(p as Extract<AvatarPart, { kind: 'body' }>).d}" fill="${(p as Extract<AvatarPart, { kind: 'body' }>).fill}"/>`).join('');
  const face = parts.map(p => {
    if (p.kind !== 'eye') return '';
    const h = +(p.h * m.scaleY).toFixed(2);
    const y = +(p.y + (p.h - h) / 2).toFixed(2);
    return `<rect class="avatar-eye" x="${p.x}" y="${y}" width="${p.w}" height="${h}" rx="${+(Math.min(p.w, h) / 2).toFixed(2)}" fill="${AVATAR_INK}"/>`;
  }).join('');
  const pos = options.x !== undefined ? ` x="${options.x}" y="${options.y ?? 0}"` : '';
  const live = options.live ? ' avatar-live' : '';
  const gaze = options.still && m.dy ? ` transform="translate(0 ${m.dy})"` : '';
  const style = options.seed ? ` style="--avatar-delay:${avatarDelay(options.seed)}"` : '';
  // The outer group is the one the moods move; the inner one turns the pair with its body.
  return `<svg${pos} width="${size}" height="${size}" viewBox="0 0 32 32" class="avatar${live}" data-avatar-mood="${mood}" aria-hidden="true"${style}>${body}<g class="avatar-eyes"${gaze}><g transform="${avatarEyeTransform(look)}">${face}</g></g></svg>`;
}

/** One avatar as a still SVG fragment at (x, y), `size` px wide (the gallery). */
export function avatarSvg(look: AvatarLook, mood: AvatarMood, x: number, y: number, size: number): string {
  return avatarMarkup(look, mood, size, { x, y, still: true });
}

/**
 * Every shape, colour, eye placement and mood on a dark and a light panel, at the sizes the app
 * uses: the reviewer's view of the whole set without running the app (tests/fixtures/avatar-gallery.svg).
 */
export function avatarGallery(): string {
  const sizes = [14, 16, 18, 20, 24, 40];
  const moods: AvatarMood[] = ['calm', 'busy', 'waiting', 'down'];
  const rows = AVATAR_SHAPES.length;
  const height = 20 + rows * 50 + 10 + 44 + 110;
  const panel = (ox: number, bg: string, ink: string) => {
    const out = [`<rect x="${ox}" y="0" width="660" height="${height}" fill="${bg}"/>`];
    AVATAR_SHAPES.forEach((shape, row) => {
      const y = 20 + row * 50;
      out.push(`<text x="${ox + 16}" y="${y + 24}" fill="${ink}" font-family="system-ui" font-size="12">${AVATAR_SHAPE_NAMES[shape]}</text>`);
      let x = ox + 110;
      for (const size of sizes) {
        out.push(avatarSvg({ shape, color: AVATAR_COLORS[row % AVATAR_COLORS.length], eyes: 'round' }, 'calm', x, y + 20 - size / 2, size));
        x += size + 14;
      }
      AVATAR_EYES.forEach((eyes, i) => out.push(avatarSvg({ shape, color: AVATAR_COLORS[(row + 3 + i) % AVATAR_COLORS.length], eyes }, 'calm', x + 10 + i * 48, y, 40)));
    });
    const colorsY = 20 + rows * 50 + 10;
    AVATAR_COLORS.forEach((color, i) => out.push(avatarSvg({ shape: 'disc', color, eyes: 'round' }, 'calm', ox + 16 + i * 34, colorsY, 24)));
    const moodY = colorsY + 44;
    moods.forEach((mood, i) => {
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 126, moodY, 40));
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 126, moodY + 48, 16));
      out.push(`<text x="${ox + 62 + i * 126}" y="${moodY + 24}" fill="${ink}" font-family="system-ui" font-size="12">${mood}</text>`);
    });
    return out.join('\n');
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="${height}" viewBox="0 0 1320 ${height}">\n${panel(0, '#171717', '#ebebeb')}\n${panel(660, '#f7f7f7', '#2e2e2e')}\n</svg>\n`;
}
