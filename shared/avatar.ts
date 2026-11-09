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

/** Bright, saturated fills; the 3D shading is mixed from these. */
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

/** Plump, soft silhouettes on a 32-unit grid, leaving room under them for a contact shadow. */
export const AVATAR_PATH: Record<AvatarShape, string> = {
  circle: 'M16 2.5a13 13 0 1 1 0 26 13 13 0 0 1 0-26Z',
  // A true rounded square (flat sides), so it never reads as a circle at 14px.
  squircle: 'M10.6 3h10.8A7.6 7.6 0 0 1 29 10.6v10.8a7.6 7.6 0 0 1-7.6 7.6H10.6A7.6 7.6 0 0 1 3 21.4V10.6A7.6 7.6 0 0 1 10.6 3Z',
  triangle: 'M16 3.2c2 0 3.7 1.1 4.8 2.9l7.4 12.9c2.5 4.4-.3 9.5-5.4 9.5H9.2c-5.1 0-7.9-5.1-5.4-9.5l7.4-12.9C12.3 4.3 14 3.2 16 3.2Z',
  pebble: 'M16.6 3c7.5.2 12.8 5.1 12.7 12.3-.1 7.4-5.7 13-13.6 13C8 28.3 3 23.4 3.1 16.4 3.2 8.6 8.6 2.8 16.6 3Z',
  capsule: 'M16 2.4c6.1 0 10.8 4.7 10.8 10.8v4.8c0 6.1-4.7 10.8-10.8 10.8S5.2 24.1 5.2 18v-4.8C5.2 7.1 9.9 2.4 16 2.4Z',
  pentagon: 'M13.4 3.5a4.4 4.4 0 0 1 5.2 0l9.1 6.7a4.4 4.4 0 0 1 1.6 5l-3.4 10.3a4.4 4.4 0 0 1-4.2 3H10.3a4.4 4.4 0 0 1-4.2-3L2.7 15.2a4.4 4.4 0 0 1 1.6-5Z',
  // A leaning bean: clearly not a circle even at 14px.
  blob: 'M11.2 3.4c4.6-1.6 7.6.8 10.4 1.6 3.9 1.1 7.9 3.3 7.9 9.4 0 6.3-3.6 10.1-8.2 12.6-4.2 2.3-9.2 1.7-12.6-.8C5.6 24 2.6 20.9 2.6 16 2.6 9.6 6.4 5 11.2 3.4Z',
  diamond: 'M12.6 3.6a4.8 4.8 0 0 1 6.8 0l8.4 8.4a4.8 4.8 0 0 1 0 6.8l-8.4 8.4a4.8 4.8 0 0 1-6.8 0l-8.4-8.4a4.8 4.8 0 0 1 0-6.8Z',
};

/** Eye height: high on the face, lower only where the shape is heavy at the bottom. */
export const AVATAR_EYE_Y: Record<AvatarShape, number> = {
  circle: 13.6, squircle: 13.8, triangle: 18, pebble: 14, capsule: 13.2, pentagon: 15, blob: 13.8, diamond: 14.8,
};

/** Eye styles: three shapes of eye; no mouths. */
export const AVATAR_EYE: Record<AvatarEyes, { rx: number; ry: number; gap: number }> = {
  round: { rx: 2.1, ry: 2.6, gap: 6.6 },
  tall: { rx: 1.8, ry: 3.1, gap: 6.2 },
  wide: { rx: 2.4, ry: 2.6, gap: 7.4 },
};

/** The eyes' ink: a deep, slightly cool black, glossy with a lighter lower edge. */
export const AVATAR_INK = '#16161c';
export const AVATAR_INK_LIGHT = '#3a3a48';
/** Centre between the eyes: a little right of the middle, so it looks somewhere. */
export const AVATAR_EYE_X = 16.8;
/** Below this many px a face is drawn bold and simple: bigger eyes, no contact shadow. */
export const AVATAR_SMALL_PX = 18;
/** At or above this many px a soft contact shadow sits under the body. */
export const AVATAR_SHADOW_PX = 20;

/** `hex` mixed toward white (t > 0) or black (t < 0), for the body's light and shade. */
export function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export type AvatarPart =
  /** The body, shaded by a radial gradient: light at the top left, the colour, a darker rim. */
  | { kind: 'body'; d: string; light: string; mid: string; rim: string }
  /** A soft contact shadow under the body (20px and up). */
  | { kind: 'shadow'; cx: number; cy: number; rx: number; ry: number }
  /** A soft specular highlight on the upper left of the body. */
  | { kind: 'shine'; cx: number; cy: number; rx: number; ry: number; rotate: number }
  | { kind: 'eye'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'happy'; d: string; width: number }
  | { kind: 'glint'; cx: number; cy: number; r: number };

/** Where the specular highlight sits for each silhouette (upper left of its mass). */
const SHINE: Record<AvatarShape, { cx: number; cy: number }> = {
  circle: { cx: 10.5, cy: 8 }, squircle: { cx: 9.8, cy: 7.8 }, triangle: { cx: 12.6, cy: 9.4 }, pebble: { cx: 10.8, cy: 8.2 },
  capsule: { cx: 11.4, cy: 7.6 }, pentagon: { cx: 10.8, cy: 9 }, blob: { cx: 10.4, cy: 8 }, diamond: { cx: 12, cy: 9.2 },
};

/**
 * Everything one avatar draws, in paint order. Soft 3D: a shaded body with a highlight and, from
 * 20px, a contact shadow; glossy eyes with a catchlight; no mouth. `small` (under 18px) keeps the
 * shading but draws the eyes bolder so the face reads at 14 to 16px. A pleased face closes its
 * eyes into happy arcs; every other mood's eyes are ovals that CSS moves.
 */
export function avatarParts(look: AvatarLook, mood: AvatarMood, small: boolean, shadow = !small): AvatarPart[] {
  const fill = AVATAR_FILL[look.color];
  const eye = AVATAR_EYE[look.eyes];
  const grow = small ? 1.35 : 1;
  const rx = +(eye.rx * grow).toFixed(2);
  const ry = +(eye.ry * grow).toFixed(2);
  const gap = small ? eye.gap * 1.12 : eye.gap;
  const cy = AVATAR_EYE_Y[look.shape];
  const xs = [AVATAR_EYE_X - gap / 2, AVATAR_EYE_X + gap / 2].map(x => +x.toFixed(2));
  const parts: AvatarPart[] = [];
  if (shadow) parts.push({ kind: 'shadow', cx: 16, cy: 30.4, rx: 9.5, ry: 1.3 });
  parts.push({ kind: 'body', d: AVATAR_PATH[look.shape], light: shade(fill, 0.32), mid: fill, rim: shade(fill, -0.22) });
  const shine = SHINE[look.shape];
  parts.push({ kind: 'shine', cx: shine.cx, cy: shine.cy, rx: small ? 3.2 : 3.6, ry: small ? 1.9 : 2.1, rotate: -32 });
  if (mood === 'pleased' && !small) {
    // ^ ^ : happy closed eyes.
    for (const x of xs) parts.push({ kind: 'happy', d: `M${+(x - rx).toFixed(2)} ${+(cy + 0.9).toFixed(2)}q${rx} -${+(ry * 1.2).toFixed(2)} ${+(rx * 2).toFixed(2)} 0`, width: 2.2 });
  } else {
    for (const x of xs) parts.push({ kind: 'eye', cx: x, cy, rx, ry });
    // The catchlight is the gloss; bigger when small so it survives at 14px.
    if (mood !== 'down') for (const x of xs) parts.push({ kind: 'glint', cx: +(x + rx * 0.35).toFixed(2), cy: +(cy - ry * 0.42).toFixed(2), r: small ? 1.05 : 0.85 });
  }
  return parts;
}

/** Whether a size in px gets the bold simplified face. */
export const isSmallAvatar = (px: number) => px < AVATAR_SMALL_PX;

let uid = 0;
/** A fresh id prefix for one avatar's gradients, so inline SVGs never share or clash. */
export function avatarIds(prefix = 'av'): { body: string; eye: string; shine: string; shadow: string } {
  const n = `${prefix}${(uid++).toString(36)}`;
  return { body: `${n}b`, eye: `${n}e`, shine: `${n}s`, shadow: `${n}c` };
}

/** The gradients an avatar uses, as SVG <defs> content. */
export function avatarDefs(parts: AvatarPart[], ids: ReturnType<typeof avatarIds>): string {
  const body = parts.find(p => p.kind === 'body') as Extract<AvatarPart, { kind: 'body' }>;
  return `<radialGradient id="${ids.body}" cx="0.36" cy="0.3" r="0.78"><stop offset="0" stop-color="${body.light}"/><stop offset="0.55" stop-color="${body.mid}"/><stop offset="1" stop-color="${body.rim}"/></radialGradient>`
    + `<linearGradient id="${ids.eye}" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="${AVATAR_INK}"/><stop offset="1" stop-color="${AVATAR_INK_LIGHT}"/></linearGradient>`
    + `<radialGradient id="${ids.shine}"><stop offset="0" stop-color="#fff" stop-opacity="0.75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="${ids.shadow}"><stop offset="0" stop-color="#000" stop-opacity="0.32"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>`;
}

/** A stable blink delay per avatar, so a row of them never blinks in step. */
export function avatarDelay(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return `${-(h % 70) / 10}s`;
}

/** How the CSS moods sit in a still frame: the gaze offset and eye scale (avatar CSS animates these). */
export function moodEyes(mood: AvatarMood): { dy: number; scaleY: number } {
  if (mood === 'waiting') return { dy: -1.6, scaleY: 1.12 };
  if (mood === 'down') return { dy: 0.4, scaleY: 0.45 };
  if (mood === 'busy') return { dy: -0.3, scaleY: 1 };
  return { dy: -0.6, scaleY: 1 };
}

/**
 * One avatar as SVG markup, the same structure the app's component renders (classes for the CSS
 * moods). `still` bakes the mood's resting pose into the markup for galleries and PNGs.
 */
export function avatarMarkup(look: AvatarLook, mood: AvatarMood, size: number, options: { x?: number; y?: number; seed?: string; live?: boolean; still?: boolean } = {}): string {
  const parts = avatarParts(look, mood, isSmallAvatar(size), size >= AVATAR_SHADOW_PX);
  const ids = avatarIds();
  const m = options.still ? moodEyes(mood) : { dy: 0, scaleY: 1 };
  const out: string[] = [];
  const face: string[] = [];
  for (const p of parts) {
    if (p.kind === 'shadow') out.push(`<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" fill="url(#${ids.shadow})"/>`);
    else if (p.kind === 'body') out.push(`<path d="${p.d}" fill="url(#${ids.body})"/>`);
    else if (p.kind === 'shine') out.push(`<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" transform="rotate(${p.rotate} ${p.cx} ${p.cy})" fill="url(#${ids.shine})"/>`);
    else if (p.kind === 'eye') face.push(`<ellipse class="avatar-eye" cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${+(p.ry * m.scaleY).toFixed(2)}" fill="url(#${ids.eye})"/>`);
    else if (p.kind === 'glint') face.push(`<circle class="avatar-glint" cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="#fff"/>`);
    else face.push(`<path d="${p.d}" fill="none" stroke="${AVATAR_INK}" stroke-width="${p.width}" stroke-linecap="round"/>`);
  }
  const pos = options.x !== undefined ? ` x="${options.x}" y="${options.y ?? 0}"` : '';
  const live = options.live ? ' avatar-live' : '';
  const gaze = options.still ? ` transform="translate(0 ${m.dy})"` : '';
  const style = options.seed ? ` style="--avatar-delay:${avatarDelay(options.seed)}"` : '';
  return `<svg${pos} width="${size}" height="${size}" viewBox="0 0 32 32" class="avatar${live}" data-avatar-mood="${mood}" aria-hidden="true"${style}><defs>${avatarDefs(parts, ids)}</defs>${out.join('')}<g class="avatar-eyes"${gaze}>${face.join('')}</g></svg>`;
}

/** One avatar as a still SVG fragment at (x, y), `size` px wide (the gallery). */
export function avatarSvg(look: AvatarLook, mood: AvatarMood, x: number, y: number, size: number): string {
  return avatarMarkup(look, mood, size, { x, y, still: true });
}

/**
 * Every shape, colour, eye style and mood on a dark and a light panel, at the sizes the app uses:
 * the reviewer's view of the whole set without running the app (tests/fixtures/avatar-gallery.svg).
 */
export function avatarGallery(): string {
  uid = 0; // stable ids, so the fixture only changes when the drawing does
  const sizes = [14, 16, 18, 20, 24, 40];
  const moods: AvatarMood[] = ['calm', 'busy', 'waiting', 'pleased', 'down'];
  const panel = (ox: number, bg: string, ink: string) => {
    const out = [`<rect x="${ox}" y="0" width="660" height="740" fill="${bg}"/>`];
    AVATAR_SHAPES.forEach((shape, row) => {
      const y = 20 + row * 50;
      out.push(`<text x="${ox + 16}" y="${y + 24}" fill="${ink}" font-family="system-ui" font-size="12">${shape}</text>`);
      let x = ox + 96;
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
