import { useEffect, useRef } from 'react';
import { AVATAR_PATH, avatarEyeTurn, AVATAR_PILL, SUPER_LOOK } from '../../shared/avatar.ts';
import { dotSize, HALFTONE_GAP, HALFTONE_REACH, runHalftone } from '../halftone.ts';

/**
 * Home's halftone background (ACH-50, ACH-D68): faint dots in the theme's text colour across the top
 * of the pane that drift, gather into the Block at the top right, and dissolve (web/halftone.ts).
 * Flat: one colour at low opacity, no gradient, shadow or glow. Decorative and behind the content;
 * it stops while the page is hidden and is one still frame under prefers-reduced-motion.
 */
export function HalftoneBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let width = 0, height = 0, cols = 0, rows = 0;
    let mask = new Float32Array(0);
    let colour = '';
    let colourAt = -Infinity;

    /** The Block, in dot cells at the top right, its pill eyes cut out as on the logo. */
    const buildMask = () => {
      cols = Math.ceil(width / HALFTONE_GAP);
      rows = Math.ceil((height * HALFTONE_REACH) / HALFTONE_GAP);
      mask = new Float32Array(cols * rows);
      if (!cols || !rows || typeof OffscreenCanvas === 'undefined') return;
      const off = new OffscreenCanvas(cols, rows).getContext('2d');
      if (!off) return;
      const size = Math.min(rows * 0.9, cols * 0.3);
      off.translate(cols * 0.8 - size / 2, rows * 0.02);
      off.scale(size / 32, size / 32);
      off.fill(new Path2D(AVATAR_PATH[SUPER_LOOK.shape]));
      off.globalCompositeOperation = 'destination-out';
      const turn = avatarEyeTurn(SUPER_LOOK);
      off.translate(turn.x, turn.y);
      off.rotate((turn.deg * Math.PI) / 180);
      off.translate(-turn.x, -turn.y);
      for (const x of [turn.x - AVATAR_PILL.gap / 2, turn.x + AVATAR_PILL.gap / 2]) {
        off.beginPath();
        off.roundRect(x - AVATAR_PILL.w / 2, turn.y - AVATAR_PILL.h / 2, AVATAR_PILL.w, AVATAR_PILL.h, AVATAR_PILL.w / 2);
        off.fill();
      }
      const data = off.getImageData(0, 0, cols, rows).data;
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] / 255;
    };

    const resize = () => {
      const box = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = box.width;
      height = box.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildMask();
    };

    const draw = (t: number) => {
      // The theme's text colour, read again now and then so a theme switch follows.
      const now = performance.now();
      if (now - colourAt > 1000) { colour = getComputedStyle(canvas).color; colourAt = now; }
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = colour;
      ctx.globalAlpha = document.documentElement.classList.contains('theme-light') ? 0.17 : 0.15;
      const max = HALFTONE_GAP * 0.36;
      ctx.beginPath();
      for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
        const x = gx * HALFTONE_GAP + HALFTONE_GAP / 2, y = gy * HALFTONE_GAP + HALFTONE_GAP / 2;
        const r = dotSize(x, y, t, height, mask[gy * cols + gx]) * max;
        if (r < 0.35) continue;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
    };

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let stop = () => {};
    const restart = () => {
      stop();
      stop = runHalftone({
        draw,
        size: () => ({ width, height }),
        now: () => performance.now(),
        requestFrame: callback => requestAnimationFrame(callback),
        cancelFrame: id => cancelAnimationFrame(id),
        hidden: () => document.hidden,
        onVisibility: listener => {
          document.addEventListener('visibilitychange', listener);
          return () => document.removeEventListener('visibilitychange', listener);
        },
        reducedMotion: () => motion.matches,
      });
    };
    const observer = new ResizeObserver(() => { resize(); restart(); });
    observer.observe(canvas);
    motion.addEventListener('change', restart);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', restart);
      stop();
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-full w-full text-content" />;
}
