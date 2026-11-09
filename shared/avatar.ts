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

// ---- drawing: the geometry the app's Avatar component and the gallery share ------------

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

export const AVATAR_PATH: Record<AvatarShape, string> = {
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
export const AVATAR_EYE_Y: Record<AvatarShape, number> = {
  circle: 15, squircle: 15, triangle: 19.5, pebble: 15.5, capsule: 14.5, pentagon: 16.5, blob: 15.5, diamond: 16,
};

export const AVATAR_EYE: Record<AvatarEyes, { rx: number; ry: number; gap: number }> = {
  round: { rx: 1.7, ry: 2.2, gap: 6 },
  tall: { rx: 1.4, ry: 2.9, gap: 5.6 },
  wide: { rx: 2, ry: 2.5, gap: 7 },
};

/** The eyes' ink, dark on every fill. */
export const AVATAR_INK = '#141418';

/** Where the eyes sit horizontally: a little right of centre, so the avatar looks somewhere. */
export const AVATAR_EYE_X = 17;

/** How a mood changes the eyes in a still frame (the app animates between these with CSS). */
export function moodEyes(mood: AvatarMood): { dy: number; scaleX: number; scaleY: number } {
  if (mood === 'waiting') return { dy: -1.6, scaleX: 1.15, scaleY: 1.15 };
  if (mood === 'down') return { dy: 0, scaleX: 1, scaleY: 0.4 };
  return { dy: 0, scaleX: 1, scaleY: 1 };
}

/** One avatar as an SVG fragment at (x, y), `size` px wide: a still frame, for the gallery. */
export function avatarSvg(look: AvatarLook, mood: AvatarMood, x: number, y: number, size: number): string {
  const eye = AVATAR_EYE[look.eyes];
  const m = moodEyes(mood);
  const cy = AVATAR_EYE_Y[look.shape] + m.dy;
  const eyes = [AVATAR_EYE_X - eye.gap / 2, AVATAR_EYE_X + eye.gap / 2]
    .map(cx => `<ellipse cx="${cx}" cy="${cy}" rx="${+(eye.rx * m.scaleX).toFixed(2)}" ry="${+(eye.ry * m.scaleY).toFixed(2)}"/>`).join('');
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 32 32"><path d="${AVATAR_PATH[look.shape]}" fill="${AVATAR_FILL[look.color]}"/><g fill="${AVATAR_INK}">${eyes}</g></svg>`;
}

/**
 * Every shape, colour, eye style and mood on a dark and a light panel, at the sizes the app uses:
 * the reviewer's view of the whole set without running the app (tests/fixtures/avatar-gallery.svg).
 */
export function avatarGallery(): string {
  const sizes = [14, 16, 20, 24, 40];
  const moods: AvatarMood[] = ['calm', 'busy', 'waiting', 'down'];
  const panel = (ox: number, bg: string, ink: string) => {
    const out = [`<rect x="${ox}" y="0" width="560" height="700" fill="${bg}"/>`];
    AVATAR_SHAPES.forEach((shape, row) => {
      const y = 20 + row * 46;
      out.push(`<text x="${ox + 16}" y="${y + 24}" fill="${ink}" font-family="system-ui" font-size="12">${shape}</text>`);
      let x = ox + 96;
      for (const size of sizes) {
        out.push(avatarSvg({ shape, color: AVATAR_COLORS[row % AVATAR_COLORS.length], eyes: AVATAR_EYES[row % AVATAR_EYES.length] }, 'calm', x, y + 20 - size / 2, size));
        x += size + 14;
      }
      AVATAR_EYES.forEach((eyes, i) => out.push(avatarSvg({ shape, color: AVATAR_COLORS[(row + 3 + i) % AVATAR_COLORS.length], eyes }, 'calm', x + 10 + i * 46, y, 40)));
    });
    const colorsY = 20 + AVATAR_SHAPES.length * 46 + 10;
    AVATAR_COLORS.forEach((color, i) => out.push(avatarSvg({ shape: 'circle', color, eyes: 'round' }, 'calm', ox + 16 + i * 34, colorsY, 24)));
    const moodY = colorsY + 44;
    moods.forEach((mood, i) => {
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 130, moodY, 40));
      out.push(`<text x="${ox + 62 + i * 130}" y="${moodY + 24}" fill="${ink}" font-family="system-ui" font-size="12">${mood}</text>`);
    });
    return out.join('\n');
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="700" viewBox="0 0 1120 700">\n${panel(0, '#171717', '#ebebeb')}\n${panel(560, '#f7f7f7', '#2e2e2e')}\n</svg>\n`;
}
