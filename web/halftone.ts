/**
 * Home's halftone background (ACH-50, ACH-D68), the parts that are not drawing: a faint dot field
 * drifting across the top of the pane that, every 24 s, gathers into the Block (the logo, ACH-D63),
 * holds, and dissolves again. Pure, so it is tested without a browser; web/ui/HalftoneBackground.tsx
 * draws it on a canvas.
 *
 * Cheap on purpose: at most 15 frames a second, 10 on large panes (under 1% of a core), nothing at
 * all while the page is hidden, and one still frame (the Block, held) under prefers-reduced-motion.
 */

/** Px between dot centres. */
export const HALFTONE_GAP = 14;
/** How far down the pane the dots reach, as a share of its height; they fade out by the composer. */
export const HALFTONE_REACH = 0.55;
/** One loop: drift, the Block gathers, holds, and dissolves. */
export const HALFTONE_LOOP = 24;
/** The moment a still frame shows: the Block, held. */
export const HALFTONE_STILL_T = 12;
/** Panes bigger than this (in CSS px) draw 10 frames a second instead of 15. */
const LARGE = 1920 * 1080;

/** Frames a second for a pane this size. */
export function halftoneFps(width: number, height: number): number {
  return width * height > LARGE ? 10 : 15;
}

const smooth = (v: number) => v * v * (3 - 2 * v);

/** How much of the Block shows at `t` seconds, 0..1: none, gathering, held, dissolving, none. */
export function blockGather(t: number): number {
  const p = (((t % HALFTONE_LOOP) + HALFTONE_LOOP) % HALFTONE_LOOP) / HALFTONE_LOOP;
  if (p < 0.25) return 0;
  if (p < 0.5) return smooth((p - 0.25) / 0.25);
  if (p < 0.66) return 1;
  if (p < 0.9) return 1 - smooth((p - 0.66) / 0.24);
  return 0;
}

/** A smooth, slow field in 0..1 from three sine sheets (no noise library). */
export function driftField(x: number, y: number, t: number): number {
  return (Math.sin(x * 0.011 + t * 0.21) + Math.sin(y * 0.017 - t * 0.17) + Math.sin((x + y) * 0.006 + t * 0.09) + 3) / 6;
}

/**
 * A dot's size, 0..1 of the largest, at (x, y) px in a pane `height` tall: the drift, pulled toward
 * the Block where `inBlock` (0..1, from the Block's mask) as it gathers; nothing below the reach.
 */
export function dotSize(x: number, y: number, t: number, height: number, inBlock: number): number {
  const k = 1 - y / (height * HALFTONE_REACH);
  if (k <= 0) return 0;
  const fade = k * k;
  const gather = blockGather(t);
  const drift = driftField(x, y, t) * 0.75;
  return fade * (drift * (1 - gather) + (inBlock ? 0.95 * inBlock : drift * 0.35) * gather);
}

/** What the loop needs from the page; the browser's in the app, fakes in tests. */
export interface HalftoneHost {
  /** Draw one frame at `t` seconds. */
  draw: (t: number) => void;
  /** The pane's size in CSS px (for the frame rate). */
  size: () => { width: number; height: number };
  now: () => number;
  requestFrame: (callback: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
  hidden: () => boolean;
  /** Called with a listener for visibility changes; returns a function that removes it. */
  onVisibility: (listener: () => void) => () => void;
  reducedMotion: () => boolean;
}

/**
 * Runs the background: one still frame under reduced motion; otherwise frames at the pane's rate
 * while the page is visible, none while hidden. Returns a stop function.
 */
export function runHalftone(host: HalftoneHost): () => void {
  let frame = 0;
  let last = -Infinity;
  const start = host.now();
  const tick = (now: number) => {
    frame = host.requestFrame(tick);
    const { width, height } = host.size();
    if (now - last < 1000 / halftoneFps(width, height) - 1) return;
    last = now;
    host.draw((now - start) / 1000);
  };
  const sync = () => {
    if (frame) host.cancelFrame(frame);
    frame = 0;
    if (host.reducedMotion()) { host.draw(HALFTONE_STILL_T); return; }
    if (!host.hidden()) frame = host.requestFrame(tick);
  };
  const off = host.onVisibility(sync);
  sync();
  return () => {
    off();
    if (frame) host.cancelFrame(frame);
    frame = 0;
  };
}
