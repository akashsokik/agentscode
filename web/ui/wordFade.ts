/*
 * MonoCode fades a streamed reply in word by word (src/features/sessions/ui/wordFade.tsx). Engines
 * here hand over each block of prose whole, so instead of pacing a stream the whole block is laid
 * out at once and its words fade in on a short stagger, top to bottom, the way MonoCode's paced
 * reveal lets out a reply that landed in one burst. Slicing the text instead would show half-written
 * markdown (an open fence or `**`) for a frame.
 */

/** How long one word takes to fade in. */
export const WORD_FADE_MS = 320;
/** The gap between one word starting and the next, for a short reply. */
const WORD_STAGGER_MS = 22;
/** The longest the last word waits, however long the reply: a long one speeds up instead. */
const WORD_STAGGER_MAX_MS = 760;

/**
 * Staggers the words under `root`: quick at the top and easing off toward the end, like a reveal
 * catching up on a burst. Returns when the last word starts.
 */
export function staggerWordFades(root: ParentNode): number {
  const words = root.querySelectorAll<HTMLElement>('[data-word-fade]');
  const last = words.length - 1;
  const span = Math.min(WORD_STAGGER_MAX_MS, last * WORD_STAGGER_MS);
  words.forEach((word, index) => {
    const t = last > 0 ? index / last : 0;
    word.style.animationDelay = `${Math.round(span * (1 - (1 - t) ** 2))}ms`;
  });
  return Math.max(0, span);
}

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}
