import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * An element's content width, kept current as it resizes; null before the first measure. Measured
 * in a layout effect, before the first paint, so nothing shows at a guessed width for a frame.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
