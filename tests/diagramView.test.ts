import assert from 'node:assert/strict';
import test from 'node:test';
import { fitView, MAX_ZOOM, MIN_ZOOM, svgSize, zoomAt } from '../web/diagramView.ts';

test('a wide diagram fits the window, centred', () => {
  // 1500 x 330 into 1000 x 600: limited by width (1000 - 64) / 1500.
  const v = fitView({ width: 1500, height: 330 }, { width: 1000, height: 600 });
  assert.ok(Math.abs(v.k - 936 / 1500) < 1e-9);
  assert.ok(Math.abs(v.x - 32) < 1e-9);
  assert.ok(Math.abs(v.y - (600 - 330 * v.k) / 2) < 1e-9);
});

test('a small diagram is enlarged at most twice', () => {
  assert.equal(fitView({ width: 100, height: 50 }, { width: 1000, height: 600 }).k, 2);
  assert.deepEqual(fitView({ width: 0, height: 10 }, { width: 1000, height: 600 }), { k: 1, x: 0, y: 0 });
});

test('zooming keeps the point under the cursor still, within limits', () => {
  const v = zoomAt({ k: 1, x: 100, y: 50 }, 2, 300, 250);
  // The diagram point under (300, 250) was (200, 200); it must still be there.
  assert.deepEqual(v, { k: 2, x: -100, y: -150 });
  assert.equal(zoomAt({ k: 1, x: 0, y: 0 }, 1000, 0, 0).k, MAX_ZOOM);
  assert.equal(zoomAt({ k: 1, x: 0, y: 0 }, 0.0001, 0, 0).k, MIN_ZOOM);
});

test('a diagram size comes from its viewBox, else width and height', () => {
  const svg = (attrs: Record<string, string>) => ({ getAttribute: (name: string) => attrs[name] ?? null });
  assert.deepEqual(svgSize(svg({ viewBox: '-8 -8 1516.5 346', width: '100%' })), { width: 1516.5, height: 346 });
  assert.deepEqual(svgSize(svg({ width: '400', height: '200px' })), { width: 400, height: 200 });
  assert.equal(svgSize(svg({ width: '100%' })), null);
});
