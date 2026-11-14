import assert from 'node:assert/strict';
import test from 'node:test';
import { blockGather, dotSize, HALFTONE_LOOP, HALFTONE_REACH, HALFTONE_STILL_T, halftoneFps, runHalftone, type HalftoneHost } from '../web/halftone.ts';

/** A fake page: frames run when the test steps them, visibility and reduced motion are switches. */
function fakeHost(options: { reducedMotion?: boolean; hidden?: boolean; width?: number; height?: number } = {}) {
  let clock = 0;
  let nextId = 1;
  const pending = new Map<number, (now: number) => void>();
  const listeners = new Set<() => void>();
  const drawn: number[] = [];
  const page = { hidden: options.hidden ?? false, reducedMotion: options.reducedMotion ?? false };
  const host: HalftoneHost = {
    draw: t => drawn.push(t),
    size: () => ({ width: options.width ?? 1440, height: options.height ?? 900 }),
    now: () => clock,
    requestFrame: callback => { const id = nextId++; pending.set(id, callback); return id; },
    cancelFrame: id => { pending.delete(id); },
    hidden: () => page.hidden,
    onVisibility: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    reducedMotion: () => page.reducedMotion,
  };
  /** Let `ms` of display frames (60 a second) go by. */
  const advance = (ms: number) => {
    for (let end = clock + ms; clock < end;) {
      clock += 1000 / 60;
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(clock);
    }
  };
  const setHidden = (hidden: boolean) => { page.hidden = hidden; for (const l of listeners) l(); };
  return { host, drawn, advance, setHidden, pending, listeners };
}

test('reduced motion: one still frame, the Block held, and no animation (ACH-50)', () => {
  const page = fakeHost({ reducedMotion: true });
  const stop = runHalftone(page.host);
  assert.deepEqual(page.drawn, [HALFTONE_STILL_T]);
  assert.equal(blockGather(HALFTONE_STILL_T), 1, 'the still frame shows the Block');
  page.advance(2000);
  assert.deepEqual(page.drawn, [HALFTONE_STILL_T], 'nothing more is drawn');
  assert.equal(page.pending.size, 0, 'no frame is asked for');
  stop();
});

test('it draws at most 15 frames a second, 10 on large panes, and none while the page is hidden', () => {
  const page = fakeHost();
  const stop = runHalftone(page.host);
  page.advance(3000);
  assert.ok(page.drawn.length >= 44 && page.drawn.length <= 46, `15 a second, not 60 (drew ${page.drawn.length} in 3 s)`);

  page.setHidden(true);
  const before = page.drawn.length;
  page.advance(3000);
  assert.equal(page.drawn.length, before, 'paused while hidden');
  assert.equal(page.pending.size, 0, 'no frame waits while hidden');

  page.setHidden(false);
  page.advance(1000);
  assert.ok(page.drawn.length > before, 'it starts again when shown');

  stop();
  assert.equal(page.listeners.size, 0, 'stopping removes its listener');
  const after = page.drawn.length;
  page.advance(1000);
  assert.equal(page.drawn.length, after, 'and draws no more');

  const big = fakeHost({ width: 2560, height: 1440 });
  const stopBig = runHalftone(big.host);
  big.advance(3000);
  assert.ok(big.drawn.length >= 29 && big.drawn.length <= 31, `10 a second on a large pane (drew ${big.drawn.length} in 3 s)`);
  stopBig();
  assert.equal(halftoneFps(1440, 900), 15);
  assert.equal(halftoneFps(2560, 1440), 10);
});

test('a page hidden from the start draws nothing until it is shown', () => {
  const page = fakeHost({ hidden: true });
  const stop = runHalftone(page.host);
  page.advance(1000);
  assert.deepEqual(page.drawn, []);
  page.setHidden(false);
  page.advance(200);
  assert.ok(page.drawn.length > 0);
  stop();
});

test('the dots: the Block gathers and dissolves each loop, and nothing is drawn below the reach', () => {
  assert.equal(blockGather(0), 0);
  assert.equal(blockGather(HALFTONE_LOOP * 0.55), 1);
  assert.equal(blockGather(HALFTONE_LOOP * 0.95), 0);
  assert.equal(blockGather(HALFTONE_LOOP + HALFTONE_LOOP * 0.55), 1, 'it loops');
  const height = 800;
  assert.equal(dotSize(100, height * HALFTONE_REACH + 1, 3, height, 0), 0, 'nothing by the composer');
  const t = HALFTONE_LOOP * 0.55;
  assert.ok(dotSize(100, 20, t, height, 1) > dotSize(100, 20, t, height, 0) * 2, 'dots in the Block are fuller while it holds');
  for (const y of [7, 100, 300]) for (const t2 of [0, 5, 13]) {
    const s = dotSize(500, y, t2, height, 0.5);
    assert.ok(s >= 0 && s <= 1, 'a size in 0..1');
  }
});
