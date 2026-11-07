import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { UsageWindow } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { credentialBlob, expiredError, fetchCodexUsage, parseClaudeUsage, parseCodexLimits, timestampMs, UsageError, UsageTracker } from '../server/usage.ts';
import { harness, tempDir } from './helpers.ts';

// ---- parsing (ported from monocode-core/src/usage.rs) -------------------------------

test('explicit Codex windows win before positional fallbacks', () => {
  const swapped = parseCodexLimits({ rateLimits: {
    primary: { usedPercent: 40, windowDurationMins: 10_080 },
    secondary: { usedPercent: 10 },
  } });
  assert.deepEqual(swapped.map(w => [w.minutes, w.usedPercent]), [[10_080, 40]], 'the secondary guess may not take the weekly slot a window named');
  const both = parseCodexLimits({ primary: { used_percent: 12, window_duration_mins: 300, resets_at: 1_800_000_000 }, secondary: { usedPercent: 55, windowDurationMins: 10_080 } });
  assert.deepEqual(both, [{ usedPercent: 12, minutes: 300, resetsAt: 1_800_000_000_000 }, { usedPercent: 55, minutes: 10_080 }]);
});

test('Codex classifies monthly windows and ignores bad percentages', () => {
  assert.deepEqual(parseCodexLimits({ primary: { usedPercent: 12, windowDurationMins: 43_200 } }).map(w => w.minutes), [43_200]);
  assert.deepEqual(parseCodexLimits({ primary: { usedPercent: 'bad' } }), []);
  assert.equal(parseCodexLimits({ primary: { usedPercent: 140 } })[0].usedPercent, 100, 'clamped');
});

test('Claude parses ISO resets and rejects empty responses', () => {
  const windows = parseClaudeUsage({ five_hour: { utilization: 23, resets_at: '2026-11-07T12:00:00Z' }, seven_day: { utilization: 41.5, resets_at: null } });
  assert.deepEqual(windows, [
    { usedPercent: 23, minutes: 300, resetsAt: Date.parse('2026-11-07T12:00:00Z') },
    { usedPercent: 41.5, minutes: 10_080 },
  ]);
  assert.throws(() => parseClaudeUsage({}), (error: UsageError) => error.unavailable);
  assert.throws(() => parseClaudeUsage('nope'), (error: UsageError) => !error.unavailable);
});

test('timestamps take seconds, milliseconds and ISO dates', () => {
  assert.equal(timestampMs(1_800_000_000), 1_800_000_000_000);
  assert.equal(timestampMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(timestampMs('1800000000'), 1_800_000_000_000);
  assert.equal(timestampMs('2026-11-07T12:00:00Z'), Date.parse('2026-11-07T12:00:00Z'));
  assert.equal(timestampMs(0), undefined);
  assert.equal(timestampMs(null), undefined);
});

test('credentials need a token, and an expired one with a refresh token is not a sign-out', () => {
  assert.ok(credentialBlob('{"claudeAiOauth":{"accessToken":"t","expiresAt":1}}'));
  assert.ok(credentialBlob('{"accessToken":"t"}'));
  assert.equal(credentialBlob('{"accessToken":" "}'), undefined);
  assert.equal(credentialBlob('not json'), undefined);
  assert.equal(expiredError({ accessToken: 'a', refreshToken: 'r' }).unavailable, false);
  assert.equal(expiredError({ accessToken: '', refreshToken: '' }).unavailable, true);
});

// ---- Codex app-server ------------------------------------------------------------------

/** A stand-in `codex` that speaks just enough app-server: it asks for the time before answering. */
function fakeCodex(result: string): string {
  const dir = tempDir('codex');
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let initialized = false;
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === 1 && m.method === 'initialize') return out({ id: 1, result: {} });
  if (m.method === 'initialized') { initialized = true; return; }
  if (m.id === 2 && m.method === 'account/rateLimits/read') return out({ id: 'clock', method: 'currentTime/read', params: {} }), (global.pending = m);
  if (m.id === 'clock' && m.result && initialized) return out(${result});
});
`, { mode: 0o755 });
  return file;
}

test('Codex usage comes from app-server, answering its requests on the way', async () => {
  const bin = fakeCodex(`{ id: 2, result: { rateLimits: { primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 33, windowDurationMins: 10080 } } } }`);
  const windows = await fetchCodexUsage(bin, 10_000);
  assert.deepEqual(windows.map(w => [w.minutes, w.usedPercent]), [[300, 7], [10_080, 33]]);
});

test('a signed-out Codex reads as unavailable; a missing one too', async () => {
  const bin = fakeCodex(`{ id: 2, error: { code: -32000, message: 'Not signed in' } }`);
  await assert.rejects(fetchCodexUsage(bin, 10_000), (error: UsageError) => error.unavailable && /codex login/.test(error.message));
  await assert.rejects(fetchCodexUsage(null), (error: UsageError) => error.unavailable);
});

// ---- the tracker and the route --------------------------------------------------------------

const engines = () => ({
  claude: { available: true, path: '/usr/bin/false', version: '1' },
  codex: { available: false, path: null, version: null },
});

test('the tracker reads lazily, keeps a read, and joins one in flight', async () => {
  let reads = 0;
  let release: (w: UsageWindow[]) => void = () => {};
  const tracker = new UsageTracker(engines, {
    claude: () => { reads++; return new Promise(resolve => { release = resolve; }); },
  });
  assert.equal(reads, 0, 'nothing is read until asked');
  const first = tracker.usage('claude');
  const second = tracker.usage('claude', true);
  release([{ usedPercent: 10, minutes: 300 }]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(reads, 1, 'a forced read joins the one in flight');
  assert.deepEqual(a.windows, b.windows);
  await tracker.usage('claude');
  assert.equal(reads, 1, 'a fresh read is kept');
  const forced = tracker.usage('claude', true);
  release([{ usedPercent: 20, minutes: 300 }]);
  assert.equal((await forced).windows[0].usedPercent, 20);
  assert.equal(reads, 2);
  assert.equal(tracker.has('codex'), false, 'an engine that is not installed has no usage');
});

test('a failed read keeps the last windows; signing out clears them', async () => {
  let next: () => Promise<UsageWindow[]> = async () => [{ usedPercent: 50, minutes: 10_080 }];
  const tracker = new UsageTracker(engines, { claude: () => next() });
  assert.equal((await tracker.usage('claude')).windows.length, 1);
  next = async () => { throw new UsageError('Could not reach Claude usage. Try refreshing again.'); };
  const failed = await tracker.usage('claude', true);
  assert.equal(failed.windows.length, 1);
  assert.match(failed.error ?? '', /Could not reach/);
  next = async () => { throw new UsageError('Sign in with claude auth login, then refresh usage.', true); };
  const out = await tracker.usage('claude', true);
  assert.deepEqual([out.windows, out.unavailable], [[], true]);
  next = async () => { throw new Error('token sk-ant-secret leaked into a stack'); };
  assert.equal((await tracker.usage('claude', true)).error, 'Could not read usage.', 'only our own messages reach the footer');
});

test('the usage route returns windows only, refreshes on POST, and 404s an engine without usage', async () => {
  const h = harness({ codex: { available: false, path: null, version: null } });
  let reads = 0;
  const tracker = new UsageTracker(() => h.manager.engineInfo(), { claude: async () => { reads++; return [{ usedPercent: 12, minutes: 300, resetsAt: 1_800_000_000_000 }]; } });
  const server = createApp(h.manager, undefined, tracker).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;
  try {
    const response = await fetch(url('/api/usage/claude'));
    assert.equal(response.status, 200);
    const body = await response.json() as { windows: unknown };
    assert.deepEqual(Object.keys(body).sort(), ['updatedAt', 'windows']);
    assert.deepEqual(body.windows, [{ usedPercent: 12, minutes: 300, resetsAt: 1_800_000_000_000 }]);
    await fetch(url('/api/usage/claude'));
    assert.equal(reads, 1);
    assert.equal((await fetch(url('/api/usage/claude/refresh'), { method: 'POST' })).status, 200);
    assert.equal(reads, 2);
    const crossOrigin = await fetch(url('/api/usage/claude/refresh'), { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403, 'a page elsewhere cannot make the server read again');
    assert.equal((await fetch(url('/api/usage/codex'))).status, 404);
    assert.equal((await fetch(url('/api/usage/nope'))).status, 404);
  } finally {
    server.close();
  }
});

test('Claude lists the limits a model keeps on its own, named for it, without repeating the shared ones', () => {
  const windows = parseClaudeUsage({
    five_hour: null,
    seven_day: { utilization: 13, resets_at: '2026-11-12T09:00:00Z' },
    seven_day_opus: { utilization: 40, resets_at: '2026-11-12T09:00:00Z' },
    seven_day_sonnet: null,
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 13, resets_at: '2026-11-12T09:00:00Z', scope: null, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 2, resets_at: '2026-11-12T09:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 9, scope: { model: null, surface: { id: 'web' } } },
      { kind: 'weekly_scoped', group: 'weekly', percent: 41, scope: { model: { display_name: 'opus' } } },
    ],
  });
  assert.deepEqual(windows.map(w => [w.minutes, w.usedPercent, w.model]), [
    [10_080, 13, undefined],
    [10_080, 40, 'Opus'],
    [10_080, 2, 'Fable'],
  ]);
  assert.throws(() => parseClaudeUsage({ seven_day_opus: { utilization: 1 } }), (error: UsageError) => error.unavailable, 'a model limit alone is not the account usage');
});

test('Codex lists a model that keeps its own limit apart from the account', () => {
  const windows = parseCodexLimits({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 10_080 }, secondary: null },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 2, windowDurationMins: 10_080 } },
      codex_spark: { limitId: 'codex_spark', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 30, windowDurationMins: 300 }, secondary: { usedPercent: 5, windowDurationMins: 10_080 } },
    },
  });
  assert.deepEqual(windows.map(w => [w.minutes, w.usedPercent, w.model]), [
    [10_080, 2, undefined],
    [300, 30, 'GPT-5.3-Codex-Spark'],
    [10_080, 5, 'GPT-5.3-Codex-Spark'],
  ]);
});
