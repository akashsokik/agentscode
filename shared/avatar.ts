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
  for (const shape of AVATAR_SHAPES) {
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
  const base = pool.length ? pick(pool) : { shape: pick(AVATAR_SHAPES), color: pick(AVATAR_COLORS), eyes: 'round' as AvatarEyes };
  return { ...base, eyes: pick(AVATAR_EYES) };
}

/**
 * Looks for agents made before avatars: each without a stored look (the SuperAgent aside) gets a
 * free shape and colour pair once, so the team never comes out all one colour from id hashes.
 * Returns the agent id to its new look; agents with a look keep it and count as taken.
 */
export function assignLooks(agents: { id: string; role?: string; avatar?: unknown }[], random: () => number = Math.random): Map<string, AvatarLook> {
  const taken = agents.filter(a => a.role !== 'super' && isLook(a.avatar)).map(a => a.avatar as AvatarLook);
  const out = new Map<string, AvatarLook>();
  for (const agent of agents) {
    if (agent.role === 'super' || isLook(agent.avatar)) continue;
    const look = freshLook(taken, random);
    taken.push(look);
    out.set(agent.id, look);
  }
  return out;
}

/**
 * How the face looks for an agent's status: content when idle, lively while working, attentive (eyes
 * up) while it waits on you, pleased (happy closed eyes) when done, tired after a failed turn.
 */
export type AvatarMood = 'calm' | 'busy' | 'waiting' | 'pleased' | 'down';

export function avatarMood(status: string | undefined): AvatarMood {
  if (status === 'working') return 'busy';
  if (status === 'waiting') return 'waiting';
  if (status === 'done') return 'pleased';
  if (status === 'error') return 'down';
  return 'calm';
}

// ---- drawing: one list of parts that the Avatar component, the gallery and the demo all draw ----
//
// The style: FLAT. One solid colour, no gradient, highlight, shadow or outline; character comes from
// an organic, slightly wonky silhouette and two small tall near-black pill eyes, set close and off
// centre so the avatar looks somewhere. No mouth. Our own shapes.

/** Rich, slightly muted fills that hold on the dark and the light theme. */
export const AVATAR_FILL: Record<AvatarColor, string> = {
  teal: '#2a9d8f',
  orange: '#e8833a',
  indigo: '#5b63d3',
  violet: '#8b5cd6',
  rose: '#d1497f',
  amber: '#dca33a',
  green: '#4aa86b',
  sky: '#3a8cd2',
  coral: '#dd5a47',
  slate: '#7b84a6',
};

/**
 * Eight organic silhouettes on a 32-unit grid, big so there is lots of colour. The keys are the
 * stored names (they predate these drawings); AVATAR_SHAPE_NAMES says what each looks like now.
 */
export const AVATAR_PATH: Record<AvatarShape, string> = {
  // A bun, leaning, fuller low on the left.
  circle: 'M14.6 2.6C21.4 1.6 28.8 6 29.8 13.8 30.8 22 25.6 29.2 17.4 29.8 9.4 30.4 2.8 25.8 2.2 18 1.6 10.4 7.4 3.6 14.6 2.6Z',
  // A soft lumpy square, a little tilted.
  squircle: 'M6.8 4.6C11.8 2.2 21.8 2 26.8 4.4c3.6 1.8 3.4 7.8 3.2 12.4-.2 5.2.4 9.8-3.4 11.8-4.6 2.4-14.8 2.6-19.8.6C3 27.4 2.2 21.8 2.4 16.4 2.6 11 2.6 6.6 6.8 4.6Z',
  // A gumdrop, its top leaning left.
  triangle: 'M12.8 3.6c2.4-1.8 5.4 0 7.2 2.6 3.4 4.8 7.8 11 9 15.8 1.2 4.8-1.8 8-7.8 8.4-4.2.3-9 .4-12.8-.4C3.8 29.1 1.4 25.8 2.6 21.2c1.6-6.2 6.8-15.2 10.2-17.6Z',
  // A wide pebble, heavier on the right.
  pebble: 'M9.2 5.4C14.2 2.4 23.2 2 27.6 6.8c3.4 3.6 3 10.8 1.4 15.6-1.8 5.2-6.6 7.8-12.8 7.6-6.4-.2-12-2.2-13.6-7.2C1 17 4 8.4 9.2 5.4Z',
  // A tall bulb, leaning right.
  capsule: 'M15.4 2.2c5.6-.6 10 4 11.2 9.8 1.4 6.6 1.4 13-2.4 16.2-3.6 3-11.6 2.8-15.2.2-3.8-2.8-3.8-9.4-2.2-15.6C8 7.2 10.2 2.8 15.4 2.2Z',
  // A four-lobe clover.
  pentagon: 'M16.4 2.2c4.6 0 7.2 3.2 6.8 7 4.4-.6 7.8 2.6 7.4 7.2-.4 4.6-4.2 7-7.8 6.4.6 4-2.6 7.2-6.8 7-4.2-.2-6.8-3.4-6.4-7.2-3.6.6-7.4-1.8-7.8-6.4-.4-4.6 3.2-7.6 7.4-7-.2-3.8 2.6-7 7.2-7Z',
  // A cloud with two bumps on top.
  blob: 'M7.8 10.4c.2-4.4 3.8-7.4 7.6-6.6 1.8-2.2 5.2-2.8 8-1.2 3.8 2 4.8 6 4.2 9 2.8 2.6 3.2 7.6.8 11.2-2.8 4.2-8.4 5.8-14 5.6-5.6-.2-10.6-2.8-12-7.8-1.2-4.8 1.6-8.8 5.4-10.2Z',
  // A leaf, tilted.
  diamond: 'M28.2 3.2c1.6 6.6.4 15.8-5.2 21.8-5.8 6.2-14 6.4-18.8 4.2C2.6 22.6 5 13.2 11.2 8 16.8 3.2 23.8 2.2 28.2 3.2Z',
};

/** What each stored shape key looks like now, for the picker. */
export const AVATAR_SHAPE_NAMES: Record<AvatarShape, string> = {
  circle: 'Bun', squircle: 'Lumpy square', triangle: 'Gumdrop', pebble: 'Pebble', capsule: 'Bulb', pentagon: 'Clover', blob: 'Cloud', diamond: 'Leaf',
};

/** Where the eyes sit on each silhouette: a point in its mass (the eye style moves them off it). */
export const AVATAR_EYE_AT: Record<AvatarShape, { x: number; y: number }> = {
  circle: { x: 17.2, y: 14.6 }, squircle: { x: 17, y: 14.8 }, triangle: { x: 15.4, y: 18.6 }, pebble: { x: 17.6, y: 15.4 },
  capsule: { x: 17.2, y: 15.2 }, pentagon: { x: 16.6, y: 15.8 }, blob: { x: 17.6, y: 16.6 }, diamond: { x: 18.2, y: 15.2 },
};

/** Eye placements: the gaze. Centred a touch right, low and left, or high and right. */
export const AVATAR_EYE: Record<AvatarEyes, { dx: number; dy: number }> = {
  round: { dx: 0.6, dy: 0 },
  tall: { dx: -2.6, dy: 2.4 },
  wide: { dx: 2.8, dy: -1.6 },
};

/** The pill eyes: tall, narrow, rounded, near-black, close together. */
export const AVATAR_PILL = { w: 2.3, h: 5.6, gap: 4.6 };
export const AVATAR_INK = '#141416';
/** Below this many px the pills are drawn bigger so they stay visible at 14 to 16px. */
export const AVATAR_SMALL_PX = 18;

export type AvatarPart =
  | { kind: 'body'; d: string; fill: string }
  /** A pill eye: a rounded rect (rx is half the width). */
  | { kind: 'eye'; x: number; y: number; w: number; h: number }
  /** A pleased eye: a small upward arc. */
  | { kind: 'happy'; d: string; width: number };

/**
 * Everything one avatar draws: a flat body and two pill eyes. A pleased face turns the pills into
 * small upward arcs; the other moods move the pills with CSS (glance, look up, tired dashes).
 * `small` (under 18px) draws the pills about a third bigger.
 */
export function avatarParts(look: AvatarLook, mood: AvatarMood, small: boolean): AvatarPart[] {
  const grow = small ? 1.35 : 1;
  const w = +(AVATAR_PILL.w * grow).toFixed(2);
  const h = +(AVATAR_PILL.h * grow).toFixed(2);
  const gap = AVATAR_PILL.gap * (small ? 1.25 : 1);
  const at = AVATAR_EYE_AT[look.shape];
  const place = AVATAR_EYE[look.eyes];
  const cx = at.x + place.dx;
  const cy = at.y + place.dy;
  const xs = [cx - gap / 2, cx + gap / 2];
  const parts: AvatarPart[] = [{ kind: 'body', d: AVATAR_PATH[look.shape], fill: AVATAR_FILL[look.color] }];
  if (mood === 'pleased') {
    for (const x of xs) parts.push({ kind: 'happy', d: `M${+(x - w * 0.95).toFixed(2)} ${+(cy + 0.8).toFixed(2)}q${+(w * 0.95).toFixed(2)} -${+(h * 0.5).toFixed(2)} ${+(w * 1.9).toFixed(2)} 0`, width: +(w * 0.85).toFixed(2) });
  } else {
    for (const x of xs) parts.push({ kind: 'eye', x: +(x - w / 2).toFixed(2), y: +(cy - h / 2).toFixed(2), w, h });
  }
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
    if (p.kind === 'eye') {
      const h = +(p.h * m.scaleY).toFixed(2);
      const y = +(p.y + (p.h - h) / 2).toFixed(2);
      return `<rect class="avatar-eye" x="${p.x}" y="${y}" width="${p.w}" height="${h}" rx="${+(p.w / 2).toFixed(2)}" fill="${AVATAR_INK}"/>`;
    }
    if (p.kind === 'happy') return `<path d="${p.d}" fill="none" stroke="${AVATAR_INK}" stroke-width="${p.width}" stroke-linecap="round"/>`;
    return '';
  }).join('');
  const pos = options.x !== undefined ? ` x="${options.x}" y="${options.y ?? 0}"` : '';
  const live = options.live ? ' avatar-live' : '';
  const gaze = options.still && m.dy ? ` transform="translate(0 ${m.dy})"` : '';
  const style = options.seed ? ` style="--avatar-delay:${avatarDelay(options.seed)}"` : '';
  return `<svg${pos} width="${size}" height="${size}" viewBox="0 0 32 32" class="avatar${live}" data-avatar-mood="${mood}" aria-hidden="true"${style}>${body}<g class="avatar-eyes"${gaze}>${face}</g></svg>`;
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
  const moods: AvatarMood[] = ['calm', 'busy', 'waiting', 'pleased', 'down'];
  const panel = (ox: number, bg: string, ink: string) => {
    const out = [`<rect x="${ox}" y="0" width="660" height="740" fill="${bg}"/>`];
    AVATAR_SHAPES.forEach((shape, row) => {
      const y = 20 + row * 50;
      out.push(`<text x="${ox + 16}" y="${y + 24}" fill="${ink}" font-family="system-ui" font-size="12">${AVATAR_SHAPE_NAMES[shape]}</text>`);
      let x = ox + 110;
      for (const size of sizes) {
        out.push(avatarSvg({ shape, color: AVATAR_COLORS[row % AVATAR_COLORS.length], eyes: AVATAR_EYES[row % AVATAR_EYES.length] }, 'calm', x, y + 20 - size / 2, size));
        x += size + 14;
      }
      AVATAR_EYES.forEach((eyes, i) => out.push(avatarSvg({ shape, color: AVATAR_COLORS[(row + 3 + i) % AVATAR_COLORS.length], eyes }, 'calm', x + 10 + i * 48, y, 40)));
    });
    const colorsY = 20 + AVATAR_SHAPES.length * 50 + 10;
    AVATAR_COLORS.forEach((color, i) => out.push(avatarSvg({ shape: 'circle', color, eyes: 'round' }, 'calm', ox + 16 + i * 34, colorsY, 24)));
    const moodY = colorsY + 44;
    moods.forEach((mood, i) => {
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 126, moodY, 40));
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 126, moodY + 48, 16));
      out.push(`<text x="${ox + 62 + i * 126}" y="${moodY + 24}" fill="${ink}" font-family="system-ui" font-size="12">${mood}</text>`);
    });
    return out.join('\n');
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="740" viewBox="0 0 1320 740">\n${panel(0, '#171717', '#ebebeb')}\n${panel(660, '#f7f7f7', '#2e2e2e')}\n</svg>\n`;
}
