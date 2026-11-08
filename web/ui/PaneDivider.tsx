import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { getLayout, setPaneWeights } from '../layout.ts';
import { evenPair, resizePair } from '../paneSizes.ts';
import { cx } from './common.tsx';

/** A pane's wrapper in the pane row (App.tsx), found by its pane id. */
function paneBox(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-pane-box="${CSS.escape(id)}"]`);
}

/** Shows weights on the pane wrappers straight away; the layout catches up on release. */
function paint(weights: Record<string, number>, ids: string[]): void {
  for (const id of ids) {
    const box = paneBox(id);
    if (box) box.style.flexGrow = String(weights[id] ?? 1);
  }
}

/**
 * A browser tab is a native view painted above the page, so a drag that crosses it could lose the
 * pointer. While dragging, a clear sheet covers the window: the browser pane sees something over it
 * (web/browser.ts coveredBy) and shows a still of the page until the drag ends.
 */
function shield(): () => void {
  const sheet = document.createElement('div');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:col-resize;background:transparent';
  document.body.append(sheet);
  return () => sheet.remove();
}

/**
 * The divider between two side-by-side panes: drag to move width from one to the other, arrow keys
 * to nudge, double-click to split them evenly again. Only these two panes change.
 */
export function PaneDivider({ left, right }: { left: string; right: string }) {
  const [dragging, setDragging] = useState(false);

  const sizes = () => {
    const l = paneBox(left)?.getBoundingClientRect().width ?? 0;
    const r = paneBox(right)?.getBoundingClientRect().width ?? 0;
    return { left: { id: left, px: l }, right: { id: right, px: r } };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const start = sizes();
    const base = getLayout().paneWeights;
    let latest = base ?? {};
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const unshield = shield();
    document.body.style.userSelect = 'none';
    const move = (event: globalThis.PointerEvent) => {
      latest = resizePair(base, start.left, start.right, event.clientX - startX);
      paint(latest, [left, right]);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      unshield();
      document.body.style.userSelect = '';
      setDragging(false);
      setPaneWeights(latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 96 : 32;
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    const s = sizes();
    setPaneWeights(resizePair(getLayout().paneWeights, s.left, s.right, delta));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panes"
      title="Drag to resize; double-click to split evenly"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setPaneWeights(evenPair(getLayout().paneWeights, left, right))}
      className="group/divider relative z-10 w-px shrink-0 cursor-col-resize bg-stroke outline-none"
    >
      {/* A wider grip than the hairline, and a stronger line while hovered, focused or dragged. */}
      <span aria-hidden className="absolute inset-y-0 -left-[3px] -right-[3px]" />
      <span
        aria-hidden
        className={cx(
          'pointer-events-none absolute inset-y-0 -left-px -right-px transition-colors duration-150',
          dragging ? 'bg-content/30' : 'bg-transparent group-hover/divider:bg-content/20 group-focus-visible/divider:bg-content/30',
        )}
      />
    </div>
  );
}
