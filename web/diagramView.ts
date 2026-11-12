// Pan and zoom for the full-window viewers (web/ui/ZoomViewer.tsx: diagrams and images). Pure, so it is tested directly.

export interface View {
  /** Scale: 1 is the diagram's own size. */
  k: number;
  /** Where the diagram's top-left corner sits in the viewport, in px. */
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Room left around a fitted diagram, in px. */
const FIT_MARGIN = 32;

const clamp = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The whole diagram in view and centred, never enlarged past `maxFit` (twice its size for a diagram). */
export function fitView(content: { width: number; height: number }, viewport: { width: number; height: number }, maxFit = 2): View {
  if (content.width <= 0 || content.height <= 0) return { k: 1, x: 0, y: 0 };
  const room = { width: Math.max(1, viewport.width - FIT_MARGIN * 2), height: Math.max(1, viewport.height - FIT_MARGIN * 2) };
  const k = clamp(Math.min(room.width / content.width, room.height / content.height, maxFit));
  return { k, x: (viewport.width - content.width * k) / 2, y: (viewport.height - content.height * k) / 2 };
}

/**
 * How a viewer opens, and what fit (Cmd+0) returns to: the whole thing in view (fitView), never
 * enlarged past `maxFit` (an image opens at most at 100%, as Preview does; a diagram may grow to 2x), except
 * for content much taller than the window (a full-page screenshot, say 2680x8040), which opens at
 * the window's width, top first, to scroll down; fitting all of it would make it unreadable.
 */
export function initialView(content: { width: number; height: number }, viewport: { width: number; height: number }, maxFit = 2): View {
  if (content.width <= 0 || content.height <= 0) return { k: 1, x: 0, y: 0 };
  const room = { width: Math.max(1, viewport.width - FIT_MARGIN * 2), height: Math.max(1, viewport.height - FIT_MARGIN * 2) };
  const whole = fitView(content, viewport, maxFit);
  // The window's width, never enlarged past the image's own size.
  const byWidth = clamp(Math.min(room.width / content.width, 1, maxFit));
  // Tall: fitting it whole would show it at under a third of the size fitting its width does.
  if (whole.k >= byWidth / 3) return whole;
  return { k: byWidth, x: (viewport.width - content.width * byWidth) / 2, y: FIT_MARGIN };
}

/** Zoom by `factor` keeping the point under (px, py) still, as a map does. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const k = clamp(view.k * factor);
  const ratio = k / view.k;
  return { k, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio };
}

/** The diagram's own size from its SVG: the viewBox, else its width and height attributes. */
export function svgSize(svg: { getAttribute(name: string): string | null }): { width: number; height: number } | null {
  const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  const width = parseFloat(svg.getAttribute('width') ?? '');
  const height = parseFloat(svg.getAttribute('height') ?? '');
  return width > 0 && height > 0 ? { width, height } : null;
}
