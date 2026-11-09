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

// ---- drawing: one list of parts that both the Avatar component and the gallery draw ---------

/** Bright, saturated but soft fills that hold up on the dark and the light theme. */
export const AVATAR_FILL: Record<AvatarColor, string> = {
  teal: '#22c8b4',
  orange: '#ff8e3c',
  indigo: '#6577ff',
  violet: '#a66cff',
  rose: '#ff6ba0',
  amber: '#ffbf2f',
  green: '#3fcf78',
  sky: '#3bb4ff',
  coral: '#ff6e5e',
  slate: '#8d9cc2',
};

/** Plump, soft silhouettes on a 32-unit grid. */
export const AVATAR_PATH: Record<AvatarShape, string> = {
  circle: 'M16 2.5a13.5 13.5 0 1 1 0 27 13.5 13.5 0 0 1 0-27Z',
  squircle: 'M16 2.6c10.2 0 13.4 3.2 13.4 13.4S26.2 29.4 16 29.4 2.6 26.2 2.6 16 5.8 2.6 16 2.6Z',
  triangle: 'M16 3.2c2 0 3.7 1.1 4.8 2.9l7.6 13.3c2.6 4.6-.3 9.8-5.6 9.8H9.2c-5.3 0-8.2-5.2-5.6-9.8l7.6-13.3C12.3 4.3 14 3.2 16 3.2Z',
  pebble: 'M16.6 3c7.6.2 13 5.2 12.9 12.6-.1 7.6-5.8 13.3-13.9 13.3C8 28.9 2.9 23.9 3 16.7 3.1 8.8 8.6 2.8 16.6 3Z',
  capsule: 'M16 2.4c6.2 0 11 4.8 11 11v5.2c0 6.2-4.8 11-11 11s-11-4.8-11-11v-5.2c0-6.2 4.8-11 11-11Z',
  pentagon: 'M13.4 3.5a4.4 4.4 0 0 1 5.2 0l9.1 6.7a4.4 4.4 0 0 1 1.6 5l-3.5 10.6a4.4 4.4 0 0 1-4.2 3H10.4a4.4 4.4 0 0 1-4.2-3L2.7 15.2a4.4 4.4 0 0 1 1.6-5Z',
  // A bean, leaning: clearly not a circle even at 14px.
  blob: 'M11.2 3.4c4.6-1.6 7.6.8 10.4 1.6 3.9 1.1 7.9 3.3 7.9 9.6 0 6.5-3.6 10.4-8.2 13-4.2 2.3-9.2 1.7-12.6-.8C5.6 24.6 2.6 21.3 2.6 16.2 2.6 9.6 6.4 5 11.2 3.4Z',
  diamond: 'M12.6 4a4.8 4.8 0 0 1 6.8 0l8.6 8.6a4.8 4.8 0 0 1 0 6.8L19.4 28a4.8 4.8 0 0 1-6.8 0L4 19.4a4.8 4.8 0 0 1 0-6.8Z',
};

/** Eye height: high on the face (cheerful), lower only where the shape is heavy at the bottom. */
export const AVATAR_EYE_Y: Record<AvatarShape, number> = {
  circle: 13.8, squircle: 13.8, triangle: 18.4, pebble: 14.2, capsule: 13.2, pentagon: 15.2, blob: 14, diamond: 15,
};

/** Eye styles: round eyes smile, wide eyes blush, tall eyes are just bright. */
export const AVATAR_EYE: Record<AvatarEyes, { rx: number; ry: number; gap: number }> = {
  round: { rx: 2.1, ry: 2.6, gap: 6.6 },
  tall: { rx: 1.8, ry: 3.1, gap: 6.2 },
  wide: { rx: 2.4, ry: 2.6, gap: 7.4 },
};

/** The eyes' ink, dark on every fill. */
export const AVATAR_INK = '#16161c';
/** Centre between the eyes: a little right of the middle, so it looks somewhere. */
export const AVATAR_EYE_X = 16.8;
/** Below this many px a face drops its catchlights, blush and smile and keeps bigger eyes. */
export const AVATAR_SMALL_PX = 18;

export type AvatarPart =
  | { kind: 'body'; d: string; fill: string }
  | { kind: 'eye'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'happy'; d: string }
  | { kind: 'glint'; cx: number; cy: number; r: number }
  | { kind: 'blush'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'smile'; d: string };

/**
 * Everything one avatar draws, in paint order. `small` (under AVATAR_SMALL_PX) keeps only what
 * survives at 14 to 16px: the body and slightly bigger eyes. A pleased face closes its eyes into
 * happy arcs; every other mood's eyes are ovals that CSS moves (blink, glance, look up, half-close).
 */
export function avatarParts(look: AvatarLook, mood: AvatarMood, small: boolean): AvatarPart[] {
  const eye = AVATAR_EYE[look.eyes];
  const grow = small ? 1.18 : 1;
  const rx = +(eye.rx * grow).toFixed(2);
  const ry = +(eye.ry * grow).toFixed(2);
  const cy = AVATAR_EYE_Y[look.shape];
  const xs = [AVATAR_EYE_X - eye.gap / 2, AVATAR_EYE_X + eye.gap / 2].map(x => +x.toFixed(2));
  const parts: AvatarPart[] = [{ kind: 'body', d: AVATAR_PATH[look.shape], fill: AVATAR_FILL[look.color] }];
  if (!small && look.eyes === 'wide' && mood !== 'down') {
    for (const [i, x] of xs.entries()) parts.push({ kind: 'blush', cx: +(x + (i ? 1.6 : -1.6)).toFixed(2), cy: +(cy + 4.4).toFixed(2), rx: 2.2, ry: 1.3 });
  }
  // Happy arcs blur into a squiggle under 18px, so a small pleased face keeps its plain eyes.
  if (mood === 'pleased' && !small) {
    // ^ ^ : happy closed eyes, thick enough to read at 14px.
    for (const x of xs) parts.push({ kind: 'happy', d: `M${+(x - rx).toFixed(2)} ${+(cy + 0.9).toFixed(2)}q${rx} -${+(ry * 1.2).toFixed(2)} ${+(rx * 2).toFixed(2)} 0` });
  } else {
    for (const x of xs) parts.push({ kind: 'eye', cx: x, cy, rx, ry });
    if (!small && mood !== 'down') for (const x of xs) parts.push({ kind: 'glint', cx: +(x + rx * 0.35).toFixed(2), cy: +(cy - ry * 0.4).toFixed(2), r: 0.8 });
  }
  if (!small && look.eyes === 'round' && mood !== 'down') {
    const sy = +(cy + ry + 2.2).toFixed(2);
    parts.push({ kind: 'smile', d: `M${+(AVATAR_EYE_X - 1.7).toFixed(2)} ${sy}q1.7 1.5 3.4 0` });
  }
  return parts;
}

/** Whether a size in px gets the simplified face. */
export const isSmallAvatar = (px: number) => px < AVATAR_SMALL_PX;

/** One part as SVG markup (the gallery; the app draws the same parts with React). */
function partSvg(part: AvatarPart): string {
  if (part.kind === 'body') return `<path d="${part.d}" fill="${part.fill}"/>`;
  if (part.kind === 'eye') return `<ellipse cx="${part.cx}" cy="${part.cy}" rx="${part.rx}" ry="${part.ry}" fill="${AVATAR_INK}"/>`;
  if (part.kind === 'happy') return `<path d="${part.d}" fill="none" stroke="${AVATAR_INK}" stroke-width="2.2" stroke-linecap="round"/>`;
  if (part.kind === 'glint') return `<circle cx="${part.cx}" cy="${part.cy}" r="${part.r}" fill="#fff"/>`;
  if (part.kind === 'blush') return `<ellipse cx="${part.cx}" cy="${part.cy}" rx="${part.rx}" ry="${part.ry}" fill="#ff6f96" opacity="0.4"/>`;
  return `<path d="${part.d}" fill="none" stroke="${AVATAR_INK}" stroke-width="1.4" stroke-linecap="round"/>`;
}

/** How the CSS moods sit in a still frame: the gaze offset and eye scale (avatar CSS animates these). */
export function moodEyes(mood: AvatarMood): { dy: number; scaleY: number } {
  if (mood === 'waiting') return { dy: -1.6, scaleY: 1.12 };
  if (mood === 'down') return { dy: 0.4, scaleY: 0.45 };
  if (mood === 'busy') return { dy: -0.3, scaleY: 1 };
  return { dy: -0.6, scaleY: 1 };
}

/** One avatar as an SVG fragment at (x, y), `size` px wide: a still frame of the app's drawing. */
export function avatarSvg(look: AvatarLook, mood: AvatarMood, x: number, y: number, size: number): string {
  const m = moodEyes(mood);
  const parts = avatarParts(look, mood, isSmallAvatar(size));
  const body = parts.filter(p => p.kind === 'body' || p.kind === 'blush' || p.kind === 'smile').map(partSvg).join('');
  const face = parts.filter(p => p.kind === 'eye' || p.kind === 'glint' || p.kind === 'happy').map(p => {
    if (p.kind === 'eye') return partSvg({ ...p, ry: +(p.ry * m.scaleY).toFixed(2) });
    return partSvg(p);
  }).join('');
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 32 32">${body}<g transform="translate(0 ${m.dy})">${face}</g></svg>`;
}

/**
 * Every shape, colour, eye style and mood on a dark and a light panel, at the sizes the app uses:
 * the reviewer's view of the whole set without running the app (tests/fixtures/avatar-gallery.svg).
 */
export function avatarGallery(): string {
  const sizes = [14, 16, 20, 24, 40];
  const moods: AvatarMood[] = ['calm', 'busy', 'waiting', 'pleased', 'down'];
  const panel = (ox: number, bg: string, ink: string) => {
    const out = [`<rect x="${ox}" y="0" width="620" height="720" fill="${bg}"/>`];
    AVATAR_SHAPES.forEach((shape, row) => {
      const y = 20 + row * 48;
      out.push(`<text x="${ox + 16}" y="${y + 24}" fill="${ink}" font-family="system-ui" font-size="12">${shape}</text>`);
      let x = ox + 96;
      for (const size of sizes) {
        out.push(avatarSvg({ shape, color: AVATAR_COLORS[row % AVATAR_COLORS.length], eyes: AVATAR_EYES[row % AVATAR_EYES.length] }, 'calm', x, y + 20 - size / 2, size));
        x += size + 14;
      }
      AVATAR_EYES.forEach((eyes, i) => out.push(avatarSvg({ shape, color: AVATAR_COLORS[(row + 3 + i) % AVATAR_COLORS.length], eyes }, 'calm', x + 10 + i * 48, y, 40)));
    });
    const colorsY = 20 + AVATAR_SHAPES.length * 48 + 10;
    AVATAR_COLORS.forEach((color, i) => out.push(avatarSvg({ shape: 'circle', color, eyes: 'round' }, 'calm', ox + 16 + i * 34, colorsY, 24)));
    const moodY = colorsY + 44;
    moods.forEach((mood, i) => {
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 118, moodY, 40));
      out.push(avatarSvg(SUPER_LOOK, mood, ox + 16 + i * 118, moodY + 48, 16));
      out.push(`<text x="${ox + 62 + i * 118}" y="${moodY + 24}" fill="${ink}" font-family="system-ui" font-size="12">${mood}</text>`);
    });
    return out.join('\n');
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="720" viewBox="0 0 1240 720">\n${panel(0, '#171717', '#ebebeb')}\n${panel(620, '#f7f7f7', '#2e2e2e')}\n</svg>\n`;
}
