import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLabel, channelLabel, updateStatusText } from '../shared/buildInfo.ts';
import type { UpdateSnapshot } from '../shared/updates.ts';

const snap = (over: Partial<UpdateSnapshot>): UpdateSnapshot => ({ phase: 'idle', currentVersion: '0.2.1', canInstall: false, ...over });

test('a version with a suffix is a prerelease', () => {
  assert.equal(channelLabel('0.2.1'), 'Release');
  assert.equal(channelLabel('0.3.0-beta.1'), 'Prerelease');
  assert.equal(channelLabel(''), 'Release');
});

test('the build reads as commit and UTC build day, either alone when the other is missing', () => {
  assert.equal(buildLabel({ commit: '72ed054', date: '2026-11-09T23:30:00.000Z' }), '72ed054, built 9 Nov 2026');
  assert.equal(buildLabel({ commit: '', date: '2026-01-02T00:00:00.000Z' }), 'built 2 Jan 2026');
  assert.equal(buildLabel({ commit: 'abc1234', date: 'not a date' }), 'abc1234');
  assert.equal(buildLabel({ commit: '', date: '' }), 'Unknown build');
});

test('every update phase has its line', () => {
  assert.equal(updateStatusText(snap({ phase: 'idle' })), 'Not checked yet');
  assert.equal(updateStatusText(snap({ phase: 'checking' })), 'Checking for updates…');
  assert.equal(updateStatusText(snap({ phase: 'current' })), 'Up to date');
  assert.equal(updateStatusText(snap({ phase: 'available', availableVersion: '0.2.2' })), 'Version 0.2.2 is available');
  assert.equal(updateStatusText(snap({ phase: 'downloading', availableVersion: '0.2.2', progress: 40 })), 'Downloading 0.2.2 (40%)');
  assert.equal(updateStatusText(snap({ phase: 'downloading' })), 'Downloading the update…');
  assert.equal(updateStatusText(snap({ phase: 'ready' })), 'Restarting to update…');
  assert.equal(updateStatusText(snap({ phase: 'error' })), 'Could not check for updates');
});

test('an error shows only its first line, capped', () => {
  assert.equal(updateStatusText(snap({ phase: 'error', error: 'HttpError: 404\nheaders: {...}' })), 'Could not check for updates: HttpError: 404');
  const long = updateStatusText(snap({ phase: 'error', error: 'x'.repeat(300) }));
  assert.ok(long.endsWith('…'));
  assert.ok(long.length < 170);
});
