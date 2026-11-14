// Avatars at one visual size (ACH-49): the shapes fill their 32px grid differently (a Bean is 20
// units tall, a Slice 29), so in a column of rows they read as different sizes. `fit` scales each
// toward one size by the geometric mean of its bounds and centres those bounds, within a tenth
// either way so no shape is redrawn. Bounds measured with getBBox on shared/avatar.ts's AVATAR_PATH;
// tests/avatarFit.test.ts checks every shape has them. Pure: no DOM.
import type { AvatarShape } from '../../shared/avatar.ts';

/** Each shape's body bounds on the 32px grid: x, y, width, height. */
export const AVATAR_BOUNDS: Record<AvatarShape, readonly [number, number, number, number]> = {
  disc: [2.14, 2.19, 28.14, 27.46],
  pentagon: [2.64, 2.88, 25.87, 27.09],
  pick: [4.29, 2.51, 21.96, 25.09],
  tile: [3.06, 2.92, 25.77, 26.16],
  dome: [1.99, 3.49, 28.02, 25.12],
  bean: [2.31, 6.08, 27.37, 19.84],
  arch: [5.35, 1.72, 21.14, 28.14],
  almond: [1.69, 2.79, 28.64, 26.59],
  slice: [2.44, 1.45, 26.75, 28.7],
  bucket: [2.48, 2.22, 25.81, 27.42],
  kite: [4.32, 3.23, 23.35, 25.54],
  cloud: [3.23, 3.67, 26.38, 24.67],
  block: [5.76, 2.74, 20.54, 26.53],
};

/** The size every shape is brought to: the middle of the set (the geometric mean of a bound's sides). */
const TARGET = 25.5;

/** The scale and the centre for a shape, kept within 0.9 to 1.1 so none is redrawn. */
export function avatarFit(shape: AvatarShape): { scale: number; cx: number; cy: number } {
  const [x, y, w, h] = AVATAR_BOUNDS[shape];
  const scale = Math.min(1.1, Math.max(0.9, TARGET / Math.sqrt(w * h)));
  return { scale: +scale.toFixed(3), cx: +(x + w / 2).toFixed(2), cy: +(y + h / 2).toFixed(2) };
}

/** The fit as an SVG transform: the bounds' centre to the grid's, at the scale. */
export function avatarFitTransform(shape: AvatarShape): string {
  const { scale, cx, cy } = avatarFit(shape);
  return `translate(16 16) scale(${scale}) translate(${-cx} ${-cy})`;
}
