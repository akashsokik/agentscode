import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AVATAR_PATH, avatarEyeTurn, SUPER_LOOK } from '../shared/avatar.ts';
import { blockTemplatePixels, pathOutline } from '../electron/trayMark.ts';

const file = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
/** A PNG's width, height and colour type, from its IHDR chunk. */
const png = (buffer: Buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] });

test('the app icon and the favicon are the SuperAgent\'s Block on a flat near-black tile (ACH-45, ACH-D63)', () => {
  for (const path of ['build/icon.svg', 'public/favicon.svg']) {
    const svg = file(path).toString().replace(/<!--[^]*?-->/g, '');
    assert.ok(svg.includes(AVATAR_PATH[SUPER_LOOK.shape]), `${path} draws the Block's own outline`);
    assert.match(svg, /fill="#0a0a0a"/, `${path}: the near-black tile`);
    assert.match(svg, /fill="#f5f5f5"/, `${path}: the Block in chalk`);
    assert.doesNotMatch(svg, /filter|Shadow|stroke|Gradient|opacity/i, `${path} is flat: no shadow, stroke, gradient or transparency`);
    assert.equal(svg.match(/<rect [^>]*rx="[\d.]+" fill="#0a0a0a"/g)?.length, 3, `${path}: the tile and the two pill eyes, all near-black`);
  }
  assert.deepEqual(png(file('build/icon.png')), { width: 1024, height: 1024, colorType: 6 }, 'a 1024 RGBA icon (transparent outside the tile)');
  assert.deepEqual(png(file('public/favicon.png')), { width: 64, height: 64, colorType: 6 });
  assert.deepEqual(png(file('public/apple-touch-icon.png')), { width: 180, height: 180, colorType: 2 }, 'a full square; iOS rounds it');
});

test('the menu bar icon is the Block as a template image: the body solid, the eyes cut out, the rest clear', () => {
  const size = 36;
  const pixels = blockTemplatePixels(size);
  assert.equal(pixels.length, size * size * 4);
  const alpha = (x: number, y: number) => pixels[(y * size + x) * 4 + 3];
  for (let i = 0; i < size * size; i++) assert.equal(pixels.readUInt32BE(i * 4) >>> 8, 0, 'black: macOS tints a template by its alpha');
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.equal(alpha(x, y), 0, 'corners are clear');
  assert.equal(alpha(18, 28), 255, 'the lower body is solid');
  // The middle of the pair of eyes is body; each eye's middle is cut out.
  const turn = avatarEyeTurn(SUPER_LOOK);
  const px = (v: number) => Math.floor((v * size) / 32);
  assert.equal(alpha(px(turn.x), px(turn.y) + 6), 255);
  const cut = [-1, 1].map(side => alpha(px(turn.x + side * 2.9), px(turn.y)));
  assert.deepEqual(cut, [0, 0], 'both eyes are holes');
  const outline = pathOutline(AVATAR_PATH.block);
  assert.ok(outline.length > 40 && outline.every(([x, y]) => x > 0 && x < 32 && y > 0 && y < 32), 'the outline stays on the 32 grid');
});
