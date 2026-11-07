import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUpdateActionable, releaseNotesUrl, updatedNotice, updateLabel, type UpdateSnapshot } from '../shared/updates.ts';

const snap = (over: Partial<UpdateSnapshot>): UpdateSnapshot => ({ phase: 'idle', currentVersion: '0.1.0', canInstall: true, ...over });

test('the sidebar row shows only when there is an update to act on', () => {
  for (const phase of ['available', 'downloading', 'ready'] as const) assert.equal(isUpdateActionable(snap({ phase })), true, phase);
  for (const phase of ['idle', 'checking', 'current', 'error'] as const) assert.equal(isUpdateActionable(snap({ phase })), false, phase);
});

test('the row reads like MonoCode: Update to X, then Downloading with progress', () => {
  assert.equal(updateLabel(snap({ phase: 'available', availableVersion: '0.2.0' })), 'Update to 0.2.0');
  assert.equal(updateLabel(snap({ phase: 'downloading', progress: 42 })), 'Downloading 42%');
  assert.equal(updateLabel(snap({ phase: 'downloading' })), 'Downloading…');
  assert.equal(updateLabel(snap({ phase: 'ready' })), 'Restarting…');
});

test('"Updated to X" shows after the version changes, never on a first run', () => {
  assert.equal(updatedNotice(null, '0.2.0'), null);
  assert.equal(updatedNotice('0.2.0', '0.2.0'), null);
  assert.equal(updatedNotice('0.1.0', '0.2.0'), '0.2.0');
});

test('release notes link to the version\'s GitHub release', () => {
  assert.equal(releaseNotesUrl('0.2.0'), 'https://github.com/akashsokik/agentscode/releases/tag/v0.2.0');
});
