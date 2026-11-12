import assert from 'node:assert/strict';
import test from 'node:test';
import { fitView, initialView, zoomAt } from '../web/diagramView.ts';
import { isMenuZoomKey, refocus, trapFocusIndex, viewerAction, ZoomKeyCapture } from '../shared/viewerKeys.ts';

// The full-window viewer for diagrams and images (web/ui/ZoomViewer.tsx; issue cc25fa6e).

const WINDOW = { width: 1300, height: 700 };

test('a normal screenshot opens whole, centred, never enlarged past twice its size', () => {
  const v = initialView({ width: 1600, height: 1000 }, WINDOW);
  assert.deepEqual(v, fitView({ width: 1600, height: 1000 }, WINDOW));
  // 636px of height room: 0.636 of 1000px.
  assert.ok(Math.abs(v.k - 0.636) < 1e-9);
  assert.ok(Math.abs(v.x - (1300 - 1600 * v.k) / 2) < 1e-9);
  assert.equal(initialView({ width: 100, height: 50 }, WINDOW).k, 2, 'a tiny image stops at 200%');
});

test('a very tall image (2680x8040) opens at the window\'s width, top first, to scroll down', () => {
  const v = initialView({ width: 2680, height: 8040 }, WINDOW);
  // 1236px of width room over 2680px.
  assert.ok(Math.abs(v.k - 1236 / 2680) < 1e-9, `k=${v.k}`);
  assert.equal(v.y, 32, 'the top, below the margin');
  assert.ok(Math.abs(v.x - 32) < 1e-9, 'centred across');
  assert.ok(8040 * v.k > WINDOW.height * 4, 'far taller than the window: it scrolls');
  // Fitting it whole would have shown it at the 10% minimum (636 / 8040 is under 8%).
  assert.equal(fitView({ width: 2680, height: 8040 }, WINDOW).k, 0.1);
});

test('a moderately tall image still opens whole; a narrow tall one is never enlarged to fit the width', () => {
  assert.deepEqual(initialView({ width: 1000, height: 1500 }, WINDOW), fitView({ width: 1000, height: 1500 }, WINDOW));
  const narrow = initialView({ width: 400, height: 6000 }, WINDOW);
  assert.equal(narrow.k, 1, 'its own size, not 309%');
  assert.equal(narrow.y, 32);
});

test('zooming keeps the point under the pointer still, within 10% to 800%', () => {
  const v = { k: 0.5, x: 100, y: 40 };
  const z = zoomAt(v, 2, 400, 300);
  // The content point under (400, 300) before: ((400-100)/0.5, (300-40)/0.5) = (600, 520).
  assert.equal(z.k, 1);
  assert.equal(z.x + 600 * z.k, 400);
  assert.equal(z.y + 520 * z.k, 300);
  assert.equal(zoomAt({ k: 7, x: 0, y: 0 }, 4, 0, 0).k, 8);
  assert.equal(zoomAt({ k: 0.12, x: 0, y: 0 }, 0.1, 0, 0).k, 0.1);
});

test('keys: Cmd+Plus, Cmd+Minus and Cmd+0 on a Mac (Ctrl elsewhere), bare + - 0 too, Escape closes', () => {
  const mac = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) => viewerAction({ key, ...mods }, true);
  assert.equal(mac('=', { metaKey: true }), 'zoomIn');
  assert.equal(mac('+', { metaKey: true }), 'zoomIn');
  assert.equal(mac('-', { metaKey: true }), 'zoomOut');
  assert.equal(mac('0', { metaKey: true }), 'fit');
  assert.equal(mac('+'), 'zoomIn');
  assert.equal(mac('-'), 'zoomOut');
  assert.equal(mac('0'), 'fit');
  assert.equal(mac('Escape'), 'close');
  assert.equal(mac('=', { ctrlKey: true }), null, 'Ctrl is not the Mac\'s zoom modifier');
  assert.equal(mac('=', { metaKey: true, altKey: true }), null);
  assert.equal(mac('Escape', { metaKey: true }), null);
  assert.equal(mac('a'), null);
  assert.equal(mac('ArrowDown'), null);
  const other = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => viewerAction({ key, ...mods }, false);
  assert.equal(other('=', { ctrlKey: true }), 'zoomIn');
  assert.equal(other('0', { ctrlKey: true }), 'fit');
  assert.equal(other('=', { metaKey: true }), null);
});

test('only the View menu\'s own zoom keys are taken from it while a viewer is open', () => {
  for (const key of ['=', '+', '-', '0']) assert.equal(isMenuZoomKey({ key, meta: true }, true), true, key);
  assert.equal(isMenuZoomKey({ key: '=' }, true), false, 'no modifier: not the menu\'s');
  assert.equal(isMenuZoomKey({ key: 'q', meta: true }, true), false, 'Cmd+Q stays the menu\'s');
  assert.equal(isMenuZoomKey({ key: 'w', meta: true }, true), false);
  assert.equal(isMenuZoomKey({ key: '0', meta: true, alt: true }, true), false);
  assert.equal(isMenuZoomKey({ key: '=', control: true }, false), true);
  assert.equal(isMenuZoomKey({ key: '=', meta: true }, false), false);
});

test('a reload with a viewer open gives Cmd+Plus, Cmd+Minus and Cmd+0 back to the menu (review M1)', () => {
  const zoom = new ZoomKeyCapture();
  const plus = { key: '=', meta: true };
  const minus = { key: '-', meta: true };
  const fit = { key: '0', meta: true };
  zoom.set(7, true);
  for (const key of [plus, minus, fit]) assert.equal(zoom.menuSkips(7, key, true), true, `${key.key} goes to the open viewer`);
  assert.equal(zoom.menuSkips(8, plus, true), false, 'another window keeps its menu');
  // Reloaded with the viewer still open (Cmd+R, the stale-page reload): React never unmounted it.
  zoom.pageGone(7);
  for (const key of [plus, minus, fit]) assert.equal(zoom.menuSkips(7, key, true), false, `${key.key} is the menu's again`);
  // Opened and closed normally.
  zoom.set(7, true);
  zoom.set(7, false);
  assert.equal(zoom.menuSkips(7, plus, true), false);
  assert.equal(zoom.menuSkips(7, { key: 'q', meta: true }, true), false, 'other keys never skip the menu');
});

test('Tab goes round the viewer\'s own controls (review L1)', () => {
  assert.equal(trapFocusIndex(5, -1, false), 0, 'into the first control');
  assert.equal(trapFocusIndex(5, -1, true), 4, 'Shift+Tab into the last');
  assert.equal(trapFocusIndex(5, 4, false), 0, 'wraps forward');
  assert.equal(trapFocusIndex(5, 0, true), 4, 'wraps back');
  assert.equal(trapFocusIndex(5, 2, false), 3);
  assert.equal(trapFocusIndex(0, -1, false), -1);
});

test('an image smaller than the window opens at 100%; a diagram may still grow to 200% (review L2)', () => {
  assert.equal(initialView({ width: 300, height: 200 }, WINDOW, 1).k, 1, 'a small screenshot is not blown up');
  assert.equal(initialView({ width: 300, height: 200 }, WINDOW).k, 2, 'a diagram keeps its scaling');
  const tall = initialView({ width: 2680, height: 8040 }, WINDOW, 1);
  assert.ok(Math.abs(tall.k - 1236 / 2680) < 1e-9, 'tall content still fits to width');
  assert.equal(tall.y, 32);
});

test('closing a viewer puts focus back where it was, if that is still on the page (review L1 follow-up)', () => {
  let focused = 0;
  const button = { isConnected: true, focus: () => { focused++; } };
  assert.equal(refocus(button), true, 'the diagram\'s expand button gets focus back');
  assert.equal(focused, 1);
  assert.equal(refocus({ isConnected: false, focus: () => { focused++; } }), false, 'an element that left the page is skipped');
  assert.equal(refocus(null), false, 'nothing had focus (the body)');
  assert.equal(focused, 1);
});
