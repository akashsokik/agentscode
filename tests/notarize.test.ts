import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error: a plain .mjs script with no type declarations
import { authArgs, canReuse, scrub, verdict } from '../scripts/release/notarize.mjs';
import { tempDir } from './helpers.ts';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'release', 'notarize.mjs');
const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const creds = { APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop', APPLE_TEAM_ID: 'TEAM123456' };

test('credentials: an API key wins, else Apple ID; none is an error; secrets are scrubbed from any text shown', () => {
  assert.deepEqual(authArgs(creds), ['--apple-id', 'dev@example.com', '--password', 'abcd-efgh-ijkl-mnop', '--team-id', 'TEAM123456']);
  assert.deepEqual(authArgs({ ...creds, APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'KID1', APPLE_API_ISSUER: 'ISS1' }).slice(0, 2), ['--key', '/k.p8']);
  assert.throws(() => authArgs({}), /No notarization credentials/);
  assert.equal(scrub('auth failed for dev@example.com with abcd-efgh-ijkl-mnop', creds), 'auth failed for *** with ***');
});

test('poll statuses: Accepted ends, Invalid and Rejected fail, anything else keeps waiting', () => {
  assert.equal(verdict('Accepted'), 'accepted');
  assert.equal(verdict('Invalid'), 'invalid');
  assert.equal(verdict('Rejected'), 'invalid');
  assert.equal(verdict('In Progress'), 'waiting');
  assert.equal(verdict(''), 'waiting');
});

/**
 * The script against a fake xcrun (notarytool and stapler) and ditto on PATH. `statuses` is what
 * successive `notarytool info` calls answer; the fake records every call, arguments included.
 */
function world(statuses: string[], options: { minutes?: string } = {}) {
  if (process.platform === 'win32') return null;
  const dir = tempDir('notarize');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const app = path.join(dir, 'release', 'mac-arm64', 'PodCode.app');
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  const calls = path.join(dir, 'calls.log');
  const queue = path.join(dir, 'statuses');
  fs.writeFileSync(queue, statuses.join('\n') + '\n');
  fs.writeFileSync(path.join(bin, 'xcrun'), `#!/bin/sh
echo "$*" >> "${calls}"
case "$1 $2" in
  "notarytool submit") echo '{"id":"sub-123","message":"Successfully uploaded file","path":"x"}' ;;
  "notarytool info") s=$(head -n 1 "${queue}"); [ "$(wc -l < "${queue}")" -gt 1 ] && sed -i.bak 1d "${queue}"; echo "{\\"id\\":\\"sub-123\\",\\"status\\":\\"$s\\"}" ;;
  "notarytool log") echo '{"issues":[{"message":"The binary is not signed."}]}' ;;
  "stapler staple"|"stapler validate") echo "The staple and validate action worked!" ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ditto'), `#!/bin/sh\necho zipped > "$6"\n`, { mode: 0o755 });
  const env = { ...process.env, ...creds, PATH: `${bin}:${process.env.PATH}`, NOTARY_POLL_SECONDS: '0.01', GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
  const run = (...args: string[]) => new Promise<{ code: number; out: string }>(resolve => {
    execFile(process.execPath, [SCRIPT, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });
  const state = path.join(dir, 'notary');
  return { dir, app, state, run, calls: () => fs.readFileSync(calls, 'utf8'), minutes: options.minutes ?? '1' };
}

test('submit records the id without waiting; wait polls until Accepted, then staples and validates', { skip: process.platform === 'win32' }, async () => {
  const w = world(['In Progress', 'In Progress', 'Accepted'])!;
  const sub = await w.run('submit', w.app, w.state, 'v0.2.6', 'arm64', COMMIT);
  assert.equal(sub.code, 0, sub.out);
  const saved = JSON.parse(fs.readFileSync(path.join(w.state, 'state.json'), 'utf8'));
  assert.equal(saved.id, 'sub-123');
  assert.deepEqual([saved.tag, saved.arch, saved.commit], ['v0.2.6', 'arm64', COMMIT]);
  assert.ok(fs.existsSync(path.join(w.state, 'PodCode.zip')));
  assert.match(w.calls(), /notarytool submit .*PodCode\.zip --no-wait --output-format json/);
  const res = await w.run('wait', w.app, w.state, w.minutes);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /In Progress[\s\S]*Accepted/);
  assert.match(w.calls(), /stapler staple .*PodCode\.app[\s\S]*stapler validate/);
  assert.match(fs.readFileSync(path.join(w.dir, 'summary.md'), 'utf8'), /submission id sub-123[\s\S]*Notarized and stapled/);
  for (const secret of Object.values(creds)) assert.ok(!res.out.includes(secret) && !sub.out.includes(secret), 'no secret in the output');
});

test('Invalid prints notarytool log and fails without stapling', { skip: process.platform === 'win32' }, async () => {
  const w = world(['Invalid'])!;
  await w.run('submit', w.app, w.state, 'v0.2.6', 'arm64', COMMIT);
  const res = await w.run('wait', w.app, w.state, w.minutes);
  assert.equal(res.code, 1);
  assert.match(res.out, /The binary is not signed/);
  assert.match(res.out, /did not accept submission sub-123 \(Invalid\)/);
  assert.match(res.out, /fresh workflow dispatch without notary_run_id/, 'says not to re-run the failed jobs');
  assert.doesNotMatch(w.calls(), /stapler/);
});

test('still in progress at the deadline: fails with the submission id, for a re-run to poll', { skip: process.platform === 'win32' }, async () => {
  const w = world(['In Progress'], { minutes: '0.001' })!;
  await w.run('submit', w.app, w.state, 'v0.2.6', 'arm64', COMMIT);
  const res = await w.run('wait', w.app, w.state, w.minutes);
  assert.equal(res.code, 1);
  assert.match(res.out, /has not finished submission sub-123 .*Re-run the failed jobs/);
  assert.doesNotMatch(w.calls(), /stapler/);
});

test('a saved submission is reused only for the same tag, arch and commit', () => {
  const state = { tag: 'v0.2.6', arch: 'arm64', commit: COMMIT, id: 'sub-123', submittedAt: '2026-11-10T08:00:00Z' };
  const want = { tag: 'v0.2.6', arch: 'arm64', commit: COMMIT };
  assert.equal(canReuse(state, want), true);
  assert.equal(canReuse(state, { ...want, commit: OTHER }), false, 'the tag was moved to another commit');
  assert.equal(canReuse(state, { ...want, arch: 'x64' }), false, 'the other Mac arch');
  assert.equal(canReuse(state, { ...want, tag: 'v0.2.7' }), false, 'another tag');
  const { commit: _c, ...old } = state;
  assert.equal(canReuse(old, want), false, 'a state from before commits were recorded');
  assert.equal(canReuse({ ...state, id: '' }, want), false, 'no submission id');
  assert.equal(canReuse(null, want), false);
  assert.equal(canReuse(state, { ...want, commit: '' }), false, 'no commit to compare');
});

test('reusable: exit 0 for this build only; a stale commit or the other arch submits afresh', { skip: process.platform === 'win32' }, async () => {
  const w = world(['Accepted'])!;
  assert.equal((await w.run('reusable', w.state, 'v0.2.6', 'arm64', COMMIT)).code, 1, 'nothing saved yet');
  assert.equal((await w.run('submit', w.app, w.state, 'v0.2.6', 'arm64', COMMIT)).code, 0);
  assert.equal((await w.run('reusable', w.state, 'v0.2.6', 'arm64', COMMIT)).code, 0);
  const stale = await w.run('reusable', w.state, 'v0.2.6', 'arm64', OTHER);
  assert.equal(stale.code, 1);
  assert.match(stale.out, /no reusable submission .*saved: v0\.2\.6 arm64 aaaaaaa/);
  assert.equal((await w.run('reusable', w.state, 'v0.2.6', 'x64', COMMIT)).code, 1);
  fs.writeFileSync(path.join(w.state, 'state.json'), '{not json');
  assert.equal((await w.run('reusable', w.state, 'v0.2.6', 'arm64', COMMIT)).code, 1, 'unreadable state');
});

test('submit refuses without a full commit, so every saved state can be matched', { skip: process.platform === 'win32' }, async () => {
  const w = world(['Accepted'])!;
  const res = await w.run('submit', w.app, w.state, 'v0.2.6', 'arm64', 'abc123');
  assert.equal(res.code, 1);
  assert.match(res.out, /needs the full commit/);
  assert.ok(!fs.existsSync(path.join(w.state, 'state.json')));
});
