import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from './helpers.ts';

const SCRIPT = path.join(import.meta.dirname, '..', 'install.sh');
/** The installer is for macOS (uname, sysctl, lsappinfo, codesign), so it is tested only there; CI checks run on Linux. */
const MAC_ONLY = { skip: process.platform !== 'darwin' ? 'install.sh is macOS-only' : false };

/**
 * install.sh up to its download, with lsappinfo, pgrep and curl faked on PATH. `runningFrom` is
 * where LaunchServices says AgentsCode runs from (nothing when it is not running). pgrep always
 * matches, as it does when an agent CLI or comms MCP server outlives the app. curl records that it
 * was called and fails, so a run that gets past the running-app check ends at "could not download".
 */
function run(runningFrom: (dir: string) => string | null, installDir = (dir: string) => dir) {
  const dir = tempDir('install');
  const bin = path.join(dir, 'bin');
  const target = path.join(dir, 'Applications');
  fs.mkdirSync(bin);
  const downloads = path.join(dir, 'downloads');
  const bundle = runningFrom(target);
  const fakes: Record<string, string> = {
    // Like the real one: exit 0 either way, and print nothing when the app is not running.
    lsappinfo: bundle ? `echo '"LSBundlePath"="${bundle}"'` : 'exit 0',
    pgrep: 'echo 95008; exit 0',
    curl: `echo "$*" >> "${downloads}"; exit 22`,
  };
  for (const [name, body] of Object.entries(fakes)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENTSCODE_INSTALL_DIR: installDir(target), AGENTSCODE_NO_OPEN: '1', TMPDIR: dir };
  return new Promise<{ code: number; out: string; downloaded: boolean; app: string }>(resolve => {
    execFile('/bin/bash', [SCRIPT], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({
      code: err ? Number((err as { code?: number }).code ?? 1) : 0,
      out: `${stdout}${stderr}`,
      downloaded: fs.existsSync(downloads),
      app: path.join(target, 'AgentsCode.app'),
    }));
  });
}

test('the app running from the install folder stops the install before any download', MAC_ONLY, async () => {
  const r = await run(dir => path.join(dir, 'AgentsCode.app'));
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`AgentsCode is running from ${r.app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Quit it`));
  assert.equal(r.downloaded, false);
});

test('an agent process that outlived the app does not count as the app running', MAC_ONLY, async () => {
  const r = await run(() => null);
  assert.doesNotMatch(r.out, /is running from/);
  assert.equal(r.downloaded, true, r.out);
  assert.match(r.out, /could not download/);
});

test('a copy running from another folder does not stop the install', MAC_ONLY, async () => {
  const r = await run(() => '/tmp/AgentsCode.app.prev');
  assert.doesNotMatch(r.out, /is running from/);
  assert.equal(r.downloaded, true, r.out);
});

test('an install folder given with a trailing slash still finds the running app', MAC_ONLY, async () => {
  const r = await run(dir => path.join(dir, 'AgentsCode.app'), dir => `${dir}/`);
  assert.equal(r.code, 1);
  assert.match(r.out, /is running from .*\/Applications\/AgentsCode\.app\. Quit it/);
  assert.doesNotMatch(r.out, /\/\/AgentsCode/);
  assert.equal(r.downloaded, false);
});
