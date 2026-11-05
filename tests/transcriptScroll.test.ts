import assert from 'node:assert/strict';
import test from 'node:test';
import { Follower, WHEEL_HOLD_MS, followsAfterScroll, scrollsUp, type ScrollBox } from '../web/transcriptScroll.ts';

/** A scroller that clamps its offset like a browser's. Cases follow MonoCode's AgentTranscriptScroll tests. */
function box(height = 1000, viewport = 400): ScrollBox & { height: number; viewport: number } {
  let top = 0;
  return {
    height,
    viewport,
    get scrollHeight() { return this.height; },
    get clientHeight() { return this.viewport; },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.height - this.viewport)); },
  };
}

function mounted() {
  const el = box();
  const follower = new Follower();
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 600);
  return { el, follower };
}

test('keeps following when a queued scroll event lands after content grows', () => {
  const { el, follower } = mounted();
  el.height = 1100;
  follower.scrolled(el);
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 700);
});

test('a wheel up a few pixels from the end leaves a streaming reply', () => {
  // The bug this fixes: every tick of a trackpad stayed inside the old 80px margin, so each render pulled it back.
  const { el, follower } = mounted();
  follower.wheel(el, -4, 0);
  el.scrollTop = 596;
  follower.scrolled(el);
  el.height = 1040;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 596);
  assert.equal(follower.following, false);

  // Scrolling back down to the end follows the stream again.
  el.scrollTop = 640;
  follower.scrolled(el);
  el.height = 1080;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 680);
});

test('waits for the end before resuming after a small move back down', () => {
  const { el, follower } = mounted();
  follower.wheel(el, -4, 0);
  el.scrollTop = 596;
  follower.scrolled(el);
  el.scrollTop = 598;
  follower.scrolled(el);
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 598);

  el.scrollTop = 700;
  follower.scrolled(el);
  el.height = 1200;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 800);
});

test('a scrollbar drag inside the end margin stops following', () => {
  const { el, follower } = mounted();
  follower.pointerDown(true, false);
  el.scrollTop = 596;
  follower.scrolled(el);
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 596);
});

test('an upward drag the browser applied before its scroll event is respected', () => {
  const { el, follower } = mounted();
  follower.pointerDown(true, false);
  el.scrollTop = 560;
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 560);
  follower.scrolled(el);
  el.height = 1200;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 560);
});

test('a text selection that does not scroll keeps following', () => {
  const { el, follower } = mounted();
  follower.pointerDown(false, false);
  follower.pointerUp(el);
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 700);
});

for (const change of ['the view grows', 'content shrinks'] as const) {
  test(`keeps following when the browser clamps to the end as ${change}`, () => {
    const { el, follower } = mounted();
    if (change === 'the view grows') el.viewport = 440;
    else el.height = 960;
    el.scrollTop = 560;
    follower.scrolled(el);
    follower.follow(el, 0);
    el.viewport = 400;
    el.height = 1000;
    follower.follow(el, 0);
    assert.equal(el.scrollTop, 600);
  });
}

test('a clamp to the end does not resume following for a reader who scrolled up', () => {
  const { el, follower } = mounted();
  follower.wheel(el, -4, 0);
  el.scrollTop = 596;
  follower.scrolled(el);
  el.viewport = 440;
  el.scrollTop = 560;
  follower.scrolled(el);
  follower.follow(el, 0);
  el.viewport = 400;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 560);
});

test('a scroll event queued by an earlier pin does not resume a paused wheel', () => {
  const { el, follower } = mounted();
  follower.wheel(el, -4, 0);
  // The browser has not applied the wheel yet; this event still reports the end.
  follower.scrolled(el);
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 600);
});

test('a gesture without a direction yet holds following until it shows one', () => {
  const { el, follower } = mounted();
  follower.wheel(el, 0, 1000);
  el.height = 1100;
  follower.follow(el, 1000 + WHEEL_HOLD_MS / 2);
  assert.equal(el.scrollTop, 600, 'not pinned during the hold');
  // The gesture turned out to go up.
  el.scrollTop = 550;
  follower.scrolled(el);
  follower.holdEnded(el);
  follower.follow(el, 1000 + WHEEL_HOLD_MS);
  assert.equal(el.scrollTop, 550);
  assert.equal(follower.following, false);
});

test('a hold that ends without an upward move follows again', () => {
  const { el, follower } = mounted();
  follower.wheel(el, 0, 1000);
  el.height = 1100;
  follower.follow(el, 1050);
  assert.equal(el.scrollTop, 600);
  follower.holdEnded(el);
  follower.follow(el, 1000 + WHEEL_HOLD_MS);
  assert.equal(el.scrollTop, 700);
});

test('sending pins back to the end from anywhere', () => {
  const { el, follower } = mounted();
  follower.wheel(el, -100, 0);
  el.scrollTop = 100;
  follower.scrolled(el);
  follower.pin(el);
  assert.equal(el.scrollTop, 600);
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 700);
});

test('a transcript restored scrolled up stays there until you reach the end', () => {
  const el = box();
  const follower = new Follower(false);
  el.scrollTop = 300;
  follower.scrolled(el);
  el.height = 1100;
  follower.follow(el, 0);
  assert.equal(el.scrollTop, 300);
});

test('followsAfterScroll only resumes on a downward move that reaches the end', () => {
  const el = box();
  el.scrollTop = 599;
  assert.equal(followsAfterScroll(el, 500, false), true);
  el.scrollTop = 590;
  assert.equal(followsAfterScroll(el, 500, false), false);
  el.scrollTop = 500;
  assert.equal(followsAfterScroll(el, 600, true), false);
  assert.equal(followsAfterScroll(el, 500, true), true, 'no movement changes nothing');
});

test('keys that scroll up', () => {
  assert.equal(scrollsUp('ArrowUp', false), true);
  assert.equal(scrollsUp('PageUp', false), true);
  assert.equal(scrollsUp('Home', false), true);
  assert.equal(scrollsUp(' ', true), true);
  assert.equal(scrollsUp(' ', false), false);
  assert.equal(scrollsUp('ArrowDown', false), false);
});
