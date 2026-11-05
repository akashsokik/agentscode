/**
 * MonoCode's column resize (useDragResize): a hairline handle on a column's edge that you drag
 * to resize, or nudge with the arrow keys; double-click puts the default width back. Widths are
 * clamped to a share of the window and remembered in the layout.
 */
import { useEffect, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { setColumnWidth, useLayout, type ColumnKey } from '../layout.ts';
import { cx } from './common.tsx';

/** The window's width, following resizes. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export interface ColumnWidth {
  key: ColumnKey;
  width: number;
  min: number;
  max: number;
  fallback: number;
  /** While dragging, the width shown before it is committed to the layout. */
  preview: (width: number | null) => void;
  commit: (width: number | undefined) => void;
}

/** A column's width: the dragged one if any, else `fallback`, kept between `min` and `maxShare` of the window. */
export function useColumnWidth(key: ColumnKey, fallback: number, min: number, maxShare: number): ColumnWidth {
  const saved = useLayout().widths?.[key];
  const windowWidth = useWindowWidth();
  const [live, setLive] = useState<number | null>(null);
  const max = Math.max(min, Math.floor(windowWidth * maxShare));
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));
  return {
    key,
    width: clamp(live ?? saved ?? fallback),
    min,
    max,
    fallback,
    preview: value => setLive(value === null ? null : clamp(value)),
    commit: value => {
      setLive(null);
      setColumnWidth(key, value === undefined ? undefined : clamp(value));
    },
  };
}

/** The drag handle on a column's `edge`. A column on the left resizes from its right edge, and the reverse. */
export function ResizeHandle({ column, edge, label }: { column: ColumnWidth; edge: 'left' | 'right'; label: string }) {
  const [dragging, setDragging] = useState(false);
  const direction = edge === 'right' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = column.width;
    let latest = startWidth;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (event: globalThis.PointerEvent) => {
      latest = startWidth + (event.clientX - startX) * direction;
      column.preview(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDragging(false);
      column.commit(latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const grow = (e.key === 'ArrowRight' ? 1 : -1) * direction;
      column.commit(column.width + grow * step);
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault();
      column.commit(undefined);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={column.width}
      aria-valuemin={column.min}
      aria-valuemax={column.max}
      tabIndex={0}
      title={`${label}. Drag to resize, double-click to reset.`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => column.commit(undefined)}
      onKeyDown={onKeyDown}
      className={cx(
        'absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors duration-150 hover:bg-content/10 focus-visible:bg-content/10',
        edge === 'right' ? '-right-[3px]' : '-left-[3px]',
        dragging && 'bg-content/15',
      )}
    />
  );
}
