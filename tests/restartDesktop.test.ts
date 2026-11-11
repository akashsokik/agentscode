import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from './helpers.ts';

const SCRIPT = path.join(import.meta.dirname, '..', 'scripts', 'restart-desktop.sh');
/** The script drives a Mac app (ditto, osascript, open, a .app bundle), so it is tested only on macOS; CI checks run on Linux. */
const MAC_ONLY = { skip: process.platform !== 'darwin' ? 'scripts/restart-desktop.sh is macOS-only (ditto, osascript, open)' : false };

/**
 * scripts/restart-desktop.sh against a stand-in app: a real process (so kill works on it), with
 * osascript, lsappinfo, curl, open and pgrep faked on PATH. `quit` is what the app does when asked
 * to quit: exit, hang with its server stopped (the browser-holder hang), or hold with its server
 * still up (a dialog).
 */
function world(quit: 'exits' | 'hangs' | 'holds') {
  const dir = tempDir('restart');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const pidFile = path.join(dir, 'app.pid');
  const serverUp = path.join(dir, 'server.up');
  const opened = path.join(dir, 'opened');
  const app = path.join(dir, 'Applications', 'PodCode.app');
  const build = path.join(dir, 'release', 'PodCode.app');
  for (const [root, mark] of [[app, 'old'], [build, 'new']] as const) {
    fs.mkdirSync(path.join(root, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Contents', 'MacOS', 'PodCode'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'build.txt'), mark);
  }
  const launch = () => {
    const child = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
    fs.writeFileSync(serverUp, '');
  };
  launch();
  const alive = `[ -f "${pidFile}" ] && kill -0 "$(cat "${pidFile}")" 2>/dev/null`;
  const quitAction = quit === 'exits' ? `kill "$(cat "${pidFile}")"; rm -f "${serverUp}"` : quit === 'hangs' ? `rm -f "${serverUp}"` : ':';
  const fakes: Record<string, string> = {
    osascript: `case "$*" in *"is running"*) if ${alive}; then echo true; else echo false; fi ;; *quit*) ${quitAction} ;; esac`,
    lsappinfo: `${alive} && echo "\\"pid\\"=$(cat "${pidFile}")"`,
    curl: `[ -f "${serverUp}" ] || exit 7; case "$*" in *"/dev/null"*) exit 0 ;; *) echo '{"agents":[]}' ;; esac`,
    // Opening the app starts a new stand-in.
    open: `echo "$1" >> "${opened}"; sleep 600 >/dev/null 2>&1 & echo $! > "${pidFile}"; touch "${serverUp}"`,
    pgrep: 'exit 1',
  };
  for (const [name, body] of Object.entries(fakes)) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AGENTSCODE_APP: app,
    AGENTSCODE_PREV: path.join(dir, 'PodCode.app.prev'),
    AGENTSCODE_NEW_BUILD: build,
    AGENTSCODE_LOCK: path.join(dir, 'lock'),
    AGENTSCODE_TICK: '0.01',
  };
  const run = (...args: string[]) => new Promise<{ code: number; out: string }>(resolve => {
    execFile('/bin/sh', [SCRIPT, ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });
  const pid = () => Number(fs.readFileSync(pidFile, 'utf8'));
  const isAlive = (p: number) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const installed = () => fs.readFileSync(path.join(app, 'build.txt'), 'utf8');
  const cleanup = () => { try { process.kill(pid()); } catch { /* gone */ } };
  return { dir, app, build, env, run, pid, isAlive, installed, opened, cleanup };
}

test('a normal quit: the new build goes in, the old one is kept, and the app is opened', MAC_ONLY, async () => {
  const w = world('exits');
  const before = w.pid();
  try {
    const { code, out } = await w.run();
    assert.equal(code, 0, out);
    assert.equal(w.isAlive(before), false);
    assert.equal(w.installed(), 'new');
    assert.equal(fs.readFileSync(path.join(w.dir, 'PodCode.app.prev', 'build.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(w.opened, 'utf8').trim(), w.app);
    assert.match(out, /Restarted onto/);
    assert.equal(fs.existsSync(w.env.AGENTSCODE_LOCK), false, 'the lock is released');
  } finally { w.cleanup(); }
});

test('the browser-holder hang: server gone but the process stays, so it is ended and the restart goes on', MAC_ONLY, async () => {
  const w = world('hangs');
  const stuck = w.pid();
  try {
    const { code, out } = await w.run();
    assert.equal(code, 0, out);
    assert.match(out, /browser-holder quit hang\); ending process \d+/);
    assert.equal(w.isAlive(stuck), false, 'the stuck process was ended');
    assert.equal(w.installed(), 'new');
    assert.ok(fs.existsSync(w.opened));
  } finally { w.cleanup(); }
});

test('a quit held while the server still answers (a dialog): nothing is killed, swapped or reopened', MAC_ONLY, async () => {
  const w = world('holds');
  const app = w.pid();
  try {
    const { code, out } = await w.run();
    assert.equal(code, 1);
    assert.match(out, /still answers after 60s .*left as is/);
    assert.equal(w.isAlive(app), true, 'the running app is untouched');
    assert.equal(w.installed(), 'old');
    assert.equal(fs.existsSync(w.opened), false);
  } finally { w.cleanup(); }
});

test('no build, or another restart already waiting: nothing happens', MAC_ONLY, async () => {
  const w = world('exits');
  const app = w.pid();
  try {
    fs.rmSync(w.build, { recursive: true });
    const missing = await w.run();
    assert.equal(missing.code, 1);
    assert.match(missing.out, /No build at/);
    assert.equal(w.isAlive(app), true);
    fs.mkdirSync(w.env.AGENTSCODE_LOCK);
    const locked = await w.run('--when-idle');
    assert.equal(locked.code, 0);
    assert.match(locked.out, /Another restart is waiting/);
    assert.equal(w.isAlive(app), true);
    assert.equal(fs.existsSync(w.env.AGENTSCODE_LOCK), true, 'the other waiter keeps its lock');
  } finally { w.cleanup(); }
});

test('--when-idle restarts after two idle checks in a row', MAC_ONLY, async () => {
  const w = world('exits');
  try {
    const { code, out } = await w.run('--when-idle');
    assert.equal(code, 0, out);
    assert.equal((out.match(/busy=0 building=0/g) ?? []).length, 2);
    assert.match(out, /No agent mid-turn and no build running: restarting/);
    assert.equal(w.installed(), 'new');
  } finally { w.cleanup(); }
});

test('if the current app cannot be moved aside, nothing is copied into it and the old app reopens (exit 1)', MAC_ONLY, async () => {
  const w = world('exits');
  const prev = w.env.AGENTSCODE_PREV;
  // A leftover .prev that cannot be removed: rm -rf fails, so the app must not be replaced.
  fs.mkdirSync(path.join(prev, 'stuck'), { recursive: true });
  fs.chmodSync(prev, 0o555);
  try {
    const { code, out } = await w.run();
    assert.equal(code, 1, out);
    assert.match(out, /Could not move the current app/);
    assert.doesNotMatch(out, /Restarted onto/);
    assert.equal(fs.existsSync(path.join(w.app, 'PodCode.app')), false, 'no nested copy inside the old bundle');
    assert.equal(w.installed(), 'old');
    assert.equal(fs.readFileSync(w.opened, 'utf8').trim(), w.app, 'the old app is reopened');
    assert.equal(fs.existsSync(w.env.AGENTSCODE_LOCK), false);
  } finally {
    fs.chmodSync(prev, 0o755);
    w.cleanup();
  }
});

test('with no app installed, a restart does nothing', MAC_ONLY, async () => {
  const w = world('exits');
  try {
    fs.rmSync(w.app, { recursive: true });
    const { code, out } = await w.run();
    assert.equal(code, 1);
    assert.match(out, /No app at .* to replace/);
    assert.equal(fs.existsSync(w.app), false);
    assert.equal(fs.existsSync(w.opened), false);
  } finally { w.cleanup(); }
});

test('a lock left by a waiter that is gone is taken over; one held by a live waiter is not', MAC_ONLY, async () => {
  const w = world('exits');
  try {
    fs.mkdirSync(w.env.AGENTSCODE_LOCK);
    fs.writeFileSync(path.join(w.env.AGENTSCODE_LOCK, 'pid'), String(process.pid));
    const held = await w.run();
    assert.equal(held.code, 0);
    assert.match(held.out, /Another restart is waiting/);
    assert.equal(w.installed(), 'old');
    // The waiter is gone (a pid nothing runs as): its lock is stale.
    fs.writeFileSync(path.join(w.env.AGENTSCODE_LOCK, 'pid'), '999999');
    const stale = await w.run();
    assert.equal(stale.code, 0, stale.out);
    assert.match(stale.out, /Taking over a stale lock \(999999\)/);
    assert.equal(w.installed(), 'new');
    assert.equal(fs.existsSync(w.env.AGENTSCODE_LOCK), false, 'released when done');
  } finally { w.cleanup(); }
});
