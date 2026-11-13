import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LAYER } from '../mono/layers.ts';

/**
 * The hover card chips share (ACH-D58): a reference chip's card (notes and decisions,
 * web/notes/RefChip.tsx) and an issue key's (web/ui/IssueKeyChip.tsx) are one shell, so they
 * look and behave alike. A flat card under the chip (above it when there is no room below),
 * following the chip as the text scrolls, closed by Escape or once the chip is out of view.
 */

/** How long the pointer rests on a chip before its card shows, and how long it may leave it. */
export const OPEN_DELAY = 250;
export const CLOSE_DELAY = 180;
const CARD_WIDTH = 360;
const GAP = 4;
const MARGIN = 8;

/**
 * A chip's card state: open after a short rest of the pointer (or at once on focus), closed a
 * little after it leaves the chip and the card, so the pointer can move into the card.
 */
export function useHoverCard() {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = useId();
  const clear = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const later = useCallback((next: boolean, delay: number) => { clear(); timer.current = setTimeout(() => setOpen(next), delay); }, [clear]);
  useEffect(() => clear, [clear]);
  const close = useCallback(() => { clear(); setOpen(false); }, [clear]);
  return {
    open,
    cardId,
    close,
    clear,
    /** Pointer and focus handlers for the chip. */
    chipEvents: {
      onMouseEnter: () => later(true, OPEN_DELAY),
      onMouseLeave: () => later(false, CLOSE_DELAY),
      onFocus: () => later(true, 0),
      onBlur: () => later(false, CLOSE_DELAY),
    },
    /** What the card calls when the pointer enters or leaves it. */
    onCardEnter: clear,
    onCardLeave: () => later(false, CLOSE_DELAY),
  };
}

/** The card itself, portalled to the page; `deps` re-measure it when its content changes. */
export function HoverCard({ id, anchor, onEnter, onLeave, onClose, deps, children }: {
  id: string;
  anchor: HTMLElement | null;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  deps?: unknown;
  children: ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  /** Under the chip, unless it would run off the bottom and there is room above; closed once the chip is out of view. */
  const measure = useCallback(() => {
    if (!anchor || !card.current) return;
    const rect = anchor.getBoundingClientRect();
    if (!anchor.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) { onClose(); return; }
    const height = card.current.offsetHeight;
    const width = Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2);
    const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
    const below = rect.bottom + GAP;
    const top = below + height > window.innerHeight - MARGIN && rect.top - GAP - height > MARGIN ? rect.top - GAP - height : below;
    setPlace(p => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [anchor, onClose]);
  useLayoutEffect(measure, [measure, deps]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    // A reply streaming in scrolls the transcript under the card: it follows its chip.
    const scroll = (event: Event) => { if (!card.current?.contains(event.target as Node)) measure(); };
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', measure);
    };
  }, [onClose, measure]);
  return createPortal(
    <div
      ref={card}
      id={id}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: 'fixed', left: place?.left ?? -9999, top: place?.top ?? -9999, width: Math.min(CARD_WIDTH, window.innerWidth - MARGIN * 2), zIndex: LAYER.popover }}
      className="rounded-[10px] border border-content/10 bg-background-base p-3.5 font-sans text-content"
    >
      {children}
    </div>,
    document.body,
  );
}
