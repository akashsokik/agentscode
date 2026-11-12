import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopViewer } from '../../shared/viewerKeys.ts';
import { trapFocusIndex, viewerAction } from '../../shared/viewerKeys.ts';
import { initialView, zoomAt, type View } from '../diagramView.ts';
import { formatKeys } from '../keys.ts';
import { Maximize2, Minus, Plus, X } from '../mono/icons.tsx';
import { LAYER } from '../mono/layers.ts';
import { IS_MAC } from '../platform.ts';

const STEP = 1.25;

function desktopViewer(): DesktopViewer | null {
  return (window as unknown as { podcodeDesktop?: { viewer?: DesktopViewer } }).podcodeDesktop?.viewer ?? null;
}

/**
 * The full-window viewer for a diagram or an image (DiagramViewer, ImageViewer), as Preview and
 * Quick Look do it: it opens fitted to the window (a very tall image at the window's width, top
 * first), Cmd+Plus and Cmd+Minus zoom (also bare + and -, a pinch, or Cmd + scroll at the pointer),
 * Cmd+0 or a double-click fits again, scroll or drag pans, and Escape or a click outside closes.
 * Flat, theme colours, no shadow. `size` is the content's own size; it shows once that is known.
 */
export function ZoomViewer({ title, size, onClose, maxFit = 2, children }: { title: string; size: { width: number; height: number } | null; onClose: () => void; /** The most it opens enlarged: 1 for an image (100%), 2 for a diagram. */ maxFit?: number; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<View | null>(null);

  const fit = useCallback(() => {
    const box = viewport.current?.getBoundingClientRect();
    if (box && size) setView(initialView(size, box, maxFit));
  }, [size, maxFit]);
  useLayoutEffect(fit, [fit]);

  const zoomBy = useCallback((factor: number, at?: { x: number; y: number }) => {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const point = at ?? { x: box.width / 2, y: box.height / 2 };
    setView(v => (v ? zoomAt(v, factor, point.x, point.y) : v));
  }, []);

  // In the desktop app, Cmd+Plus, Cmd+Minus and Cmd+0 come here instead of zooming the whole app.
  useEffect(() => {
    desktopViewer()?.captureZoomKeys(true);
    return () => desktopViewer()?.captureZoomKeys(false);
  }, []);

  // Modal: focus moves in when it opens, and Tab goes round its own controls, never to the page
  // behind it. Whoever opened it puts focus back when it closes (ExpandableImage does).
  useEffect(() => { panel.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && panel.current) {
        const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
        const next = trapFocusIndex(controls.length, controls.indexOf(document.activeElement as HTMLElement), event.shiftKey);
        event.preventDefault();
        event.stopPropagation();
        controls[next]?.focus();
        return;
      }
      const action = viewerAction(event, IS_MAC);
      if (!action) return;
      // Handled here, so an open thread or dialog underneath does not also react.
      event.preventDefault();
      event.stopPropagation();
      if (action === 'close') onClose();
      else if (action === 'zoomIn') zoomBy(STEP);
      else if (action === 'zoomOut') zoomBy(1 / STEP);
      else fit();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, zoomBy, fit]);

  // Not a React handler: wheel must be non-passive to keep the page from scrolling or zooming.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // A trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
        zoomBy(Math.exp(-event.deltaY * 0.01), { x: event.clientX - box.left, y: event.clientY - box.top });
      } else {
        setView(v => (v ? { ...v, x: v.x - event.deltaX, y: v.y - event.deltaY } : v));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    drag.current = { ...start, x: event.clientX, y: event.clientY };
    setView(v => (v ? { ...v, x: v.x + dx, y: v.y + dy } : v));
  };
  const endDrag = () => { drag.current = null; };

  const button = 'grid size-7 place-items-center rounded-md text-content/60 transition-colors duration-150 hover:bg-content/10 hover:text-content';
  const keys = (spec: string) => formatKeys(spec, IS_MAC);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ zIndex: LAYER.dialog }}
      className="fixed inset-0 bg-black/60 p-6 sm:p-10"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div ref={panel} tabIndex={-1} className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-content/10 bg-background-base outline-none">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-content/10 pl-4 pr-2 font-sans text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-content/70">{title}</span>
          <button type="button" className={button} onClick={() => zoomBy(1 / STEP)} title={`Zoom out (${keys('Mod+-')})`} aria-label="Zoom out">
            <Minus className="size-3.5" strokeWidth={1.75} />
          </button>
          <span className="w-12 text-center tabular-nums text-content/55" aria-live="polite">{view ? `${Math.round(view.k * 100)}%` : ''}</span>
          <button type="button" className={button} onClick={() => zoomBy(STEP)} title={`Zoom in (${keys('Mod++')})`} aria-label="Zoom in">
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          <button type="button" className={button} onClick={fit} title={`Fit to window (${keys('Mod+0')})`} aria-label="Fit to window">
            <Maximize2 className="size-3.5" strokeWidth={1.75} />
          </button>
          <span aria-hidden className="mx-1 h-4 w-px bg-content/10" />
          <button type="button" className={button} onClick={onClose} title={`Close (${keys('Escape')})`} aria-label="Close">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <div
          ref={viewport}
          className="relative min-h-0 flex-1 touch-none select-none overflow-hidden cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={fit}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : undefined, visibility: view ? 'visible' : 'hidden' }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
