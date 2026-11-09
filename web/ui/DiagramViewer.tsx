import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { fitView, svgSize, zoomAt, type View } from '../diagramView.ts';
import { Maximize2, Minus, Plus, X } from '../mono/icons.tsx';
import { LAYER } from '../mono/layers.ts';
import { appColours, neutralizeColours } from './MermaidDiagram.tsx';

const STEP = 1.25;

/**
 * A drawn diagram in a floating window over the app: fitted to the window, drag to pan, pinch or
 * Ctrl/Cmd + scroll to zoom (plain scroll pans), + and - to zoom, 0 or double-click to fit, Escape
 * or a click outside to close.
 */
export function DiagramViewer({ svg, title = 'Diagram', onClose }: { svg: string; title?: string; onClose: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const size = useRef<{ width: number; height: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [view, setView] = useState<View | null>(null);

  const fit = useCallback(() => {
    const box = viewport.current?.getBoundingClientRect();
    if (box && size.current) setView(fitView(size.current, box));
  }, []);

  // Draw at the diagram's own size (Mermaid sets width 100% and a max-width), then fit it.
  useLayoutEffect(() => {
    const el = canvas.current?.querySelector('svg');
    if (!el || !canvas.current) return;
    const own = svgSize(el) ?? { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
    el.setAttribute('width', String(own.width));
    el.setAttribute('height', String(own.height));
    el.style.maxWidth = 'none';
    size.current = own;
    neutralizeColours(canvas.current, appColours());
    fit();
  }, [svg, fit]);

  const zoomBy = useCallback((factor: number, at?: { x: number; y: number }) => {
    const box = viewport.current?.getBoundingClientRect();
    if (!box) return;
    const point = at ?? { x: box.width / 2, y: box.height / 2 };
    setView(v => (v ? zoomAt(v, factor, point.x, point.y) : v));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const keys: Record<string, () => void> = { Escape: onClose, '+': () => zoomBy(STEP), '=': () => zoomBy(STEP), '-': () => zoomBy(1 / STEP), '0': fit };
      const act = keys[event.key];
      if (!act || event.metaKey || event.ctrlKey || event.altKey) return;
      // Handled here, so an open thread or dialog underneath does not also react.
      event.preventDefault();
      event.stopPropagation();
      act();
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

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ zIndex: LAYER.dialog }}
      className="fixed inset-0 bg-black/60 p-6 sm:p-10"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-content/10 bg-background-base">
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-content/10 pl-4 pr-2 font-sans text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-content/70">{title}</span>
          <button type="button" className={button} onClick={() => zoomBy(1 / STEP)} title="Zoom out (-)" aria-label="Zoom out">
            <Minus className="size-3.5" strokeWidth={1.75} />
          </button>
          <span className="w-12 text-center tabular-nums text-content/55" aria-live="polite">{view ? `${Math.round(view.k * 100)}%` : ''}</span>
          <button type="button" className={button} onClick={() => zoomBy(STEP)} title="Zoom in (+)" aria-label="Zoom in">
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
          <button type="button" className={button} onClick={fit} title="Fit to window (0)" aria-label="Fit to window">
            <Maximize2 className="size-3.5" strokeWidth={1.75} />
          </button>
          <span aria-hidden className="mx-1 h-4 w-px bg-content/10" />
          <button type="button" className={button} onClick={onClose} title="Close (Esc)" aria-label="Close">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        <div
          ref={viewport}
          className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden cursor-grab active:cursor-grabbing`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={fit}
        >
          <div
            ref={canvas}
            data-mermaid
            className="mermaid-svg absolute left-0 top-0 origin-top-left"
            style={{ transform: view ? `translate(${view.x}px, ${view.y}px) scale(${view.k})` : undefined, visibility: view ? 'visible' : 'hidden' }}
            // The same SVG the chat shows: Mermaid's strict mode already sanitized it.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
