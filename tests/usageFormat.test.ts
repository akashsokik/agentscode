import assert from 'node:assert/strict';
import test from 'node:test';
import { chipLabel, countdown, duration, limitName, modelMatches, resetLabel, tightest, updatedLabel, usageTone, windowLabel, windowsFor } from '../web/usageFormat.ts';

const now = Date.parse('2026-11-07T09:00:00Z');
const min = 60_000;

test('reset countdowns match the footer', () => {
  assert.equal(duration(0), 'now');
  assert.equal(duration(-5), 'now');
  assert.equal(duration(59_999), '0m');
  assert.equal(duration(12 * min), '12m');
  assert.equal(duration(60 * min), '1h');
  assert.equal(duration(185 * min), '3h 5m');
  assert.equal(duration(24 * 60 * min), '1d');
  assert.equal(duration((4 * 24 + 2) * 60 * min + 30 * min), '4d 2h');
});

test('windows are named by their length', () => {
  assert.deepEqual([300, 1_440, 10_080, 43_200, 120, 45].map(windowLabel), ['5h', '1d', 'wk', 'mo', '2h', '45m']);
  assert.deepEqual([300, 10_080, 43_200].map(m => limitName(m)), ['5-hour limit', 'Weekly limit', 'Monthly limit']);
});

test('the chip reads each window and its countdown; the card its reset', () => {
  const windows = [
    { usedPercent: 12.4, minutes: 300, resetsAt: now + 185 * min },
    { usedPercent: 41.6, minutes: 10_080 },
  ];
  assert.equal(chipLabel(windows, now), '12% 3h 5m · 42% wk');
  assert.equal(countdown(windows[1], now), 'wk');
  assert.equal(resetLabel(windows[0], now), 'Resets in 3h 5m');
  assert.equal(resetLabel({ ...windows[0], resetsAt: now - 1 }, now), 'Resets now');
  assert.equal(resetLabel(windows[1], now), 'wk window');
  assert.equal(tightest(windows), windows[1]);
  assert.equal(tightest([]), undefined);
});

test('tones and the updated line', () => {
  assert.deepEqual([10, 80, 89.9, 90, 100].map(usageTone), ['quiet', 'warning', 'warning', 'danger', 'danger']);
  assert.equal(updatedLabel(now - 20_000, now), 'Updated just now');
  assert.equal(updatedLabel(now - 4 * min, now), 'Updated 4m ago');
  assert.equal(updatedLabel(undefined, now), 'Not read yet');
});

test("a model's own limit applies to agents on that model only, one way", () => {
  assert.equal(modelMatches('Fable', ['claude-fable-5-1', 'Fable 5.1']), true);
  assert.equal(modelMatches('Opus', ['Opus 5.5']), true);
  assert.equal(modelMatches('Opus', ['Sonnet 5.5', 'claude-sonnet-5-5']), false);
  assert.equal(modelMatches('GPT-5.3-Codex-Spark', ['gpt-5.3-codex-spark']), true);
  assert.equal(modelMatches('GPT-5.3-Codex-Spark', ['gpt-5.3-codex']), false, 'the plain model does not count against the Spark limit');
  assert.equal(modelMatches('ab', ['ab-model']), false, 'too short a name to trust');
  const windows = [
    { usedPercent: 13, minutes: 10_080 },
    { usedPercent: 40, minutes: 10_080, model: 'Opus' },
    { usedPercent: 2, minutes: 10_080, model: 'Fable' },
  ];
  assert.deepEqual(windowsFor(windows, ['Fable 5.1']).map(w => w.model), [undefined, 'Fable']);
  assert.deepEqual(windowsFor(windows, ['Sonnet 5.5']).map(w => w.model), [undefined]);
  assert.equal(chipLabel(windowsFor(windows, ['Opus 5.5']), now), '13% wk · Opus 40% wk');
  assert.equal(limitName(10_080, 'Fable'), 'Fable weekly limit');
});
