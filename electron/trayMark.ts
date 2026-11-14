/**
 * PodCode's mark for the menu bar (ACH-45, ACH-D63): the SuperAgent's Block (shared/avatar.ts) as a
 * template image, its body solid and its two pill eyes cut out, so macOS tints it for a light or dark
 * menu bar. Drawn here, with no Electron, so nothing has to ship beside the app and it can be tested.
 */
import { AVATAR_PATH, avatarEyeTurn, avatarParts, SUPER_LOOK } from '../shared/avatar.ts';

type Point = [number, number];

/** The outline of a path made of M, L, C and Z commands, curves flattened to short lines. */
export function pathOutline(d: string, steps = 12): Point[] {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g) ?? [];
  const points: Point[] = [];
  let i = 0;
  let command = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLCZ]/.test(tokens[i])) command = tokens[i++];
    if (command === 'Z') continue;
    if (command === 'M' || command === 'L') points.push([num(), num()]);
    else if (command === 'C') {
      const [x0, y0] = points[points.length - 1];
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        points.push([
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
    }
  }
  return points;
}

function insidePolygon(polygon: Point[], [px, py]: Point): boolean {
  let hit = false;
  for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
    const [xa, ya] = polygon[a], [xb, yb] = polygon[b];
    if ((ya > py) !== (yb > py) && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) hit = !hit;
  }
  return hit;
}

/**
 * The Block as BGRA pixels, `size` px square (black, the alpha is the shape): 4x4 samples a pixel,
 * so the edges are smooth. Small-size pills, as the app draws the avatar under 18pt.
 */
export function blockTemplatePixels(size: number): Buffer {
  const body = pathOutline(AVATAR_PATH[SUPER_LOOK.shape]);
  const eyes = avatarParts(SUPER_LOOK, 'calm', true).flatMap(p => (p.kind === 'eye' ? [p] : []));
  const turn = avatarEyeTurn(SUPER_LOOK);
  const a = (-turn.deg * Math.PI) / 180;
  // Is a point (on the 32 grid) in an eye? Turn it back by the eyes' turn, then test the pill.
  const inEye = ([x, y]: Point) => {
    const dx = x - turn.x, dy = y - turn.y;
    const ux = turn.x + dx * Math.cos(a) - dy * Math.sin(a), uy = turn.y + dx * Math.sin(a) + dy * Math.cos(a);
    return eyes.some(e => {
      const r = e.w / 2;
      const cx = Math.min(Math.max(ux, e.x + r), e.x + e.w - r), cy = Math.min(Math.max(uy, e.y + r), e.y + e.h - r);
      return (ux - cx) ** 2 + (uy - cy) ** 2 <= r * r;
    });
  };
  const pixels = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let covered = 0;
    for (let sy = 0; sy < n; sy++) for (let sx = 0; sx < n; sx++) {
      const point: Point = [((x + (sx + 0.5) / n) * 32) / size, ((y + (sy + 0.5) / n) * 32) / size];
      if (insidePolygon(body, point) && !inEye(point)) covered++;
    }
    pixels.writeUInt32BE(Math.round((255 * covered) / (n * n)), (y * size + x) * 4); // BGRA: black, alpha last
  }
  return pixels;
}
