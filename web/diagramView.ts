// Pan and zoom for the floating diagram viewer (web/ui/DiagramViewer.tsx). Pure, so it is tested directly.

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

/** The whole diagram in view and centred, never enlarged past twice its size. */
export function fitView(content: { width: number; height: number }, viewport: { width: number; height: number }): View {
  if (content.width <= 0 || content.height <= 0) return { k: 1, x: 0, y: 0 };
  const room = { width: Math.max(1, viewport.width - FIT_MARGIN * 2), height: Math.max(1, viewport.height - FIT_MARGIN * 2) };
  const k = clamp(Math.min(room.width / content.width, room.height / content.height, 2));
  return { k, x: (viewport.width - content.width * k) / 2, y: (viewport.height - content.height * k) / 2 };
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
