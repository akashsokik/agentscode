import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { disablesPushGuard, installPushGuard, issueOverride, pushGuardEnv } from '../server/pushGuard.ts';
import { tempDir } from './helpers.ts';

// The force-push rule where git runs (ALL-D9): every agent's git uses PodCode's hooks folder, whose
// pre-push refuses overwriting or deleting what the remote has, unless a force-push the user
// approved gave the agent a one-time token. Real repositories, real git.

const BASE = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(BASE)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(k)) delete (BASE as Record<string, string | undefined>)[k];

/** A clone with a bare origin; `agent` runs commands as an agent would (the guard's env). */
function setup() {
  const dir = tempDir('push-guard');
  const hooks = installPushGuard(path.join(dir, 'git-hooks'));
  const agentEnv = pushGuardEnv(BASE, hooks);
  const sh = (cwd: string, cmd: string, env: NodeJS.ProcessEnv = agentEnv) => spawnSync('sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });
  const ok = (cwd: string, cmd: string) => { const r = sh(cwd, cmd, BASE); assert.equal(r.status, 0, `${cmd}\n${r.stderr}`); return r.stdout.trim(); };
  ok(dir, 'git -c init.defaultBranch=main init -q --bare origin.git && git clone -q origin.git app');
  const app = path.join(dir, 'app');
  ok(app, 'git checkout -q -b main && echo a > a && git add a && git commit -qm a && git push -q origin main && echo b > b && git add b && git commit -qm b && git push -q origin main && git push -q origin main:refs/heads/old && git tag v1 && git push -q origin v1');
  return { dir, app, hooks, agentEnv, sh, ok };
}

test('a normal fast-forward push goes; a new branch goes; the repository\'s own hooks still run', () => {
  const s = setup();
  // The repo's own pre-commit and pre-push still run, chained.
  fs.writeFileSync(path.join(s.app, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho own-pre-push-ran >&2\ncat > /dev/null\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(s.app, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho own-pre-commit-ran >&2\nexit 0\n', { mode: 0o755 });
  const commit = s.sh(s.app, 'echo c > c && git add c && git commit -qm c');
  assert.equal(commit.status, 0);
  assert.match(commit.stderr, /own-pre-commit-ran/);
  const push = s.sh(s.app, 'git push -q origin main');
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stderr, /own-pre-push-ran/);
  assert.equal(s.sh(s.app, 'git checkout -q -b fix/new && echo n > n && git add n && git commit -qm n && git push -q -u origin fix/new').status, 0, 'a branch never pushed before');
  assert.equal(s.sh(s.app, 'git commit -q --amend -m n2 && git push -q --force origin fix/new').status, 1, 'once pushed, it is shared: overwriting it is refused');
});

test('force-pushes in every form are refused: --force, +ref, --mirror deleting, --prune, a script, plain-English instructions followed', () => {
  // git does not pass --mirror/--prune deletions to pre-push; the hook reads the push's command line (ps).
  const s = setup();
  s.ok(s.app, 'git reset -q --hard HEAD~1 && echo x > x && git add x && git commit -qm rewritten');
  for (const cmd of [
    'git push --force origin main',
    'git push -f origin main',
    'git push --force-with-lease origin main',
    'git push origin +main',
    'git push origin +HEAD:refs/heads/main',
    // "Overwrite origin/main with my branch": what an agent might run after reading an English request.
    'git push origin HEAD:main --force',
  ]) {
    const r = s.sh(s.app, cmd);
    assert.equal(r.status, 1, cmd);
    assert.match(r.stderr, /PodCode refused this push/, cmd);
  }
  // A script, so no task text ever showed the command.
  fs.writeFileSync(path.join(s.dir, 'sync.sh'), '#!/bin/sh\nF=--for\ngit push ${F}ce origin main\n', { mode: 0o755 });
  assert.equal(s.sh(s.app, `${path.join(s.dir, 'sync.sh')}`).status, 1, 'a script with a split flag');
  // Deleting what the remote has: a branch, a tag, --mirror and --prune.
  assert.equal(s.sh(s.app, 'git push origin --delete old').status, 1, 'delete a pushed branch');
  assert.equal(s.sh(s.app, 'git push origin :refs/tags/v1').status, 1, 'delete a pushed tag');
  s.ok(s.app, 'git reset -q --hard origin/main && git branch -D -q old 2>/dev/null; true');
  assert.equal(s.sh(s.app, 'git push --mirror origin').status, 1, '--mirror deleting branches the clone lacks');
  assert.equal(s.sh(s.app, 'git push --prune origin "refs/heads/*:refs/heads/*"').status, 1, '--prune');
  // Nothing moved on the remote.
  assert.equal(s.ok(s.dir, 'git --git-dir=origin.git rev-parse --verify -q refs/heads/old >/dev/null && echo yes'), 'yes');
});

test('a force-push you approved: its one-time token lets one push through, then never again; a made-up token does nothing', () => {
  const s = setup();
  s.ok(s.app, 'git reset -q --hard HEAD~1 && echo x > x && git add x && git commit -qm rewritten');
  assert.equal(s.sh(s.app, 'PODCODE_PUSH_OVERRIDE=deadbeefdeadbeefdeadbeef git push --force origin main').status, 1, 'a made-up token');
  const token = issueOverride(s.hooks);
  const r = s.sh(s.app, `PODCODE_PUSH_OVERRIDE=${token} git push -q --force origin main`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the force-push you approved, once/);
  s.ok(s.app, 'git commit -q --amend -m again');
  assert.equal(s.sh(s.app, `PODCODE_PUSH_OVERRIDE=${token} git push --force origin main`).status, 1, 'used once');
});

test('the guard only sits in agents\' env (added to any GIT_CONFIG_COUNT); turning it off is caught', () => {
  const env = pushGuardEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'X' }, '/hooks');
  assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1], ['2', 'user.name', 'core.hooksPath', '/hooks']);
  for (const cmd of ['git push --no-verify origin main', 'git -c core.hooksPath=/dev/null push -f', 'GIT_CONFIG_COUNT=0 git push -f', 'env -i git push -f', 'unset GIT_CONFIG_COUNT; git push', 'PODCODE_PUSH_OVERRIDE=abc git push -f']) {
    assert.ok(disablesPushGuard(cmd), cmd);
  }
  for (const cmd of ['git push origin main', 'git commit -m "x"', 'npm test', 'git push -u origin fix/x']) assert.equal(disablesPushGuard(cmd), null, cmd);
});
