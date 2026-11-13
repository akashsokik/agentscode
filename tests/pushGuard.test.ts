import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { disablesPushGuard, ensurePushGuard, installPushGuard, issueOverride, pushGuardEnv, redeemOverride } from '../server/pushGuard.ts';
import { tempDir } from './helpers.ts';

// The force-push rule where git runs (ALL-D9): agents' git is PodCode's shim, which runs a push
// with PodCode's hooks folder, whose pre-push refuses overwriting or deleting what the remote has
// unless a force-push the user approved gave the agent a one-time token PodCode answers for once.
// Real repositories, real git, real shells. The probes Rhea listed (round 3) are named T3-T12.

const BASE = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(BASE)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(k)) delete (BASE as Record<string, string | undefined>)[k];

/** A clone with a bare origin; `agent` runs commands as an agent would (the guard's env). */
function setup(options: { url?: string } = {}) {
  const dir = tempDir('push-guard');
  const hooks = installPushGuard(path.join(dir, 'git-hooks'), options);
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

/** Run a shell command without blocking, so the pre-push can reach a server in this process. */
function run(cwd: string, cmd: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', cmd], { cwd, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

/** The route PodCode serves (server/app.ts), on a throwaway port. */
async function redeemServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) as { token?: unknown; refs?: unknown; remote?: unknown } : {};
      if (req.url === '/api/push-guard/check') { ensurePushGuard(); res.writeHead(200).end('{}'); return; }
      const result = req.url === '/api/push-guard/redeem' ? redeemOverride(parsed.token, parsed.refs, parsed.remote) : { ok: false };
      res.writeHead(result.ok ? 200 : 403, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('a force-push you approved: one feature branch on that project\'s remote, once; a token file, a made-up token, another branch or repo do nothing (T7, Rhea round 4)', async () => {
  const server = await redeemServer();
  try {
    const s = setup({ url: server.url });
    const remote = s.ok(s.app, 'git remote get-url --push origin');
    s.ok(s.app, 'git checkout -q -b feat origin/old && git reset -q --hard HEAD~1 && echo x > x && git add x && git commit -qm rewritten');
    const push = (token: string, ref = 'HEAD:old') => run(s.app, `PODCODE_PUSH_OVERRIDE=${token} git push -q --force origin ${ref}`, s.agentEnv);
    assert.equal((await push('deadbeefdeadbeefdeadbeef')).status, 1, 'a made-up token');
    // T7: a token file the agent writes itself, where tokens used to live.
    fs.mkdirSync(path.join(s.hooks, 'overrides'), { recursive: true });
    fs.writeFileSync(path.join(s.hooks, 'overrides', 'a'.repeat(24)), 'x');
    assert.equal((await push('a'.repeat(24))).status, 1, 'a forged token file');
    // L5: bound to the project's remote, not only the branch name.
    const elsewhere = issueOverride({ branch: 'old', remotes: ['/some/other/repo.git'] });
    const r0 = await push(elsewhere);
    assert.equal(r0.status, 1, 'another repository');
    assert.match(r0.stderr, /did not take the token: the token is for old on \/some\/other\/repo only/);
    // L3: a wrong ref does not use the token up; the right push still goes.
    const token = issueOverride({ branch: 'old', remotes: [remote] });
    const r1 = await push(token, 'HEAD:main');
    assert.equal(r1.status, 1, 'another branch');
    assert.match(r1.stderr, /the token is for old only; it is still good for that push/);
    const r = await push(token);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /the force-push you approved, once/);
    s.ok(s.app, 'git commit -q --amend -m again');
    assert.equal((await push(token)).status, 1, 'used once');
  } finally { server.close(); }
  assert.equal(redeemOverride('not-a-token', '').ok, false);
});

test('a token is never issued for main, master or a tag, and never redeems for a tag (Rhea round 4, M1)', () => {
  for (const branch of ['main', 'master', 'refs/tags/v1', '']) assert.throws(() => issueOverride({ branch, remotes: ['/r.git'] }), branch);
  const token = issueOverride({ branch: 'feat/x', remotes: ['/r.git'] });
  assert.equal(redeemOverride(token, 'refs/tags/feat/x(overwrite)', '/r.git').ok, false);
  assert.equal(redeemOverride(token, 'refs/heads/feat/x(overwrite)', '/r.git/').ok, true, 'a trailing slash is the same remote');
});

test('aliases are followed through aliases of aliases, and --attr-source takes a value (Rhea round 4, L1)', () => {
  const s = setup();
  s.ok(s.app, 'git reset -q --hard HEAD~1 && echo x > x && git add x && git commit -qm rewritten');
  for (const cmd of [
    'git config alias.a b && git config alias.b "push --no-verify" && git a -f origin main',
    'git config alias.c d && git config alias.d e && git config alias.e "push -f" && git c origin main',
    'git --attr-source HEAD push --no-verify -f origin main',
    'git config alias.l1 l2 && git config alias.l2 l3 && git config alias.l3 l4 && git config alias.l4 l5 && git config alias.l5 l6 && git config alias.l6 push && git l1 -f origin main',
  ]) {
    const r = s.sh(s.app, cmd);
    assert.notEqual(r.status, 0, cmd);
    assert.match(r.stderr, /PodCode refused/, cmd);
  }
  assert.equal(s.sh(s.app, 'git config alias.st status && git config alias.s st && git s -s').status, 0, 'an everyday nested alias still runs');
});

test('the ways around the check are refused: --no-verify (T3), -c core.hooksPath (T4), unset GIT_CONFIG_COUNT (T5), send-pack (T6), aliases, abbreviations', () => {
  const s = setup();
  s.ok(s.app, 'git reset -q --hard HEAD~1 && echo x > x && git add x && git commit -qm rewritten');
  const remote = path.join(s.dir, 'origin.git');
  for (const cmd of [
    'git push --no-verify -f origin main',
    'git push -f --no-veri origin main',
    'git -c core.hooksPath=/dev/null push -f origin main',
    'git -c CORE.HOOKSPATH=/dev/null push -f origin main',
    'X=/dev/null git --config-env=core.hooksPath=X push -f origin main',
    'git -C . -c core.hooksPath=/dev/null push -f origin main',
    'unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; git push -f origin main',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push -f origin main',
    `GIT_CONFIG_PARAMETERS="'core.hookspath'='/dev/null'" git push -f origin main`,
    `git send-pack --force ${remote} main`,
    'git config alias.nv "push --no-verify" && git nv -f origin main',
    'git -c alias.nv="push --no-verify" nv -f origin main',
    'git config alias.sp send-pack && git sp --force origin.git main',
    'git config alias.fp "push -f" && git fp origin main',
    'git config alias.m "push --mirror" && git m origin',
    'git push --mirr origin',
  ]) {
    const r = s.sh(s.app, cmd);
    assert.notEqual(r.status, 0, cmd);
    assert.match(r.stderr, /PodCode refused/, cmd);
  }
  assert.equal(s.ok(s.dir, 'git --git-dir=origin.git rev-parse main'), s.ok(s.dir, 'git --git-dir=origin.git rev-parse old'), 'main never moved');
});

test('a changed pre-push is put back before the push (T12) and before each turn, and said', async () => {
  const server = await redeemServer();
  try {
    const s = setup({ url: server.url });
    s.ok(s.app, 'git reset -q --hard HEAD~1 && echo x > x && git add x && git commit -qm rewritten');
    fs.writeFileSync(path.join(s.hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
    const r = await run(s.app, 'git push -f origin main', s.agentEnv);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /PodCode refused this push/);
    fs.writeFileSync(path.join(s.hooks, 'bin', 'git'), '#!/bin/sh\nexec /usr/bin/git "$@"\n');
    assert.deepEqual(ensurePushGuard(), ['bin/git']);
    assert.deepEqual(ensurePushGuard(), []);
  } finally { server.close(); }
});

test('without the server, a changed pre-push stops the push rather than letting it through', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.hooks, 'pre-push'), '#!/bin/sh\nexit 0\n');
  const r = s.sh(s.app, 'git checkout -q -b fresh && git push -q origin fresh');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /push check was changed/);
});

test('PodCode\'s git stays first in login shells (bash -l, zsh -l, which Claude Code and Codex use); your own BASH_ENV and ZDOTDIR still run', () => {
  const s = setup();
  const shim = path.join(s.hooks, 'bin', 'git');
  for (const shell of [['bash', '-c'], ['bash', '-lc'], ['zsh', '-c'], ['zsh', '-lc'], ['zsh', '-ic'], ['sh', '-c']]) {
    const r = spawnSync(shell[0], [shell[1], 'command -v git'], { cwd: s.app, env: { ...s.agentEnv, HOME: s.dir }, encoding: 'utf8' });
    assert.equal(r.stdout.trim().split('\n').pop(), shim, shell.join(' '));
  }
  // The BASH_ENV file puts the shim back first after anything reset PATH.
  const r = spawnSync('sh', ['-c', `PATH=/usr/bin:/bin; . "$BASH_ENV"; command -v git`], { env: s.agentEnv, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), shim);
  const user = path.join(s.dir, 'userz'); fs.mkdirSync(user);
  fs.writeFileSync(path.join(user, '.zshenv'), 'export MINE=zshenv\n');
  fs.writeFileSync(path.join(s.dir, 'mybashenv'), 'export MINE=bashenv\n');
  const env = pushGuardEnv({ ...BASE, ZDOTDIR: user, BASH_ENV: path.join(s.dir, 'mybashenv') }, s.hooks);
  assert.equal(spawnSync('zsh', ['-c', 'echo $MINE'], { env, encoding: 'utf8' }).stdout.trim(), 'zshenv');
  assert.equal(spawnSync('bash', ['-c', 'echo $MINE'], { env, encoding: 'utf8' }).stdout.trim(), 'bashenv');
  assert.deepEqual(pushGuardEnv({ PATH: '/usr/bin' }, '/h').PATH, '/h/bin:/usr/bin');
  assert.equal(pushGuardEnv(pushGuardEnv({ PATH: '/usr/bin' }, '/h'), '/h').PATH, '/h/bin:/usr/bin', 'not added twice');
});

test('commits cost under twice a plain commit: only a push runs PodCode\'s hooks', () => {
  const s = setup();
  const median = (env: NodeJS.ProcessEnv) => {
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const r = spawnSync('sh', ['-c', `echo ${i} >> a && git commit -qam c${i}`], { cwd: s.app, env, encoding: 'utf8' });
      times.push(performance.now() - t0);
      assert.equal(r.status, 0, r.stderr);
    }
    return times.sort((a, b) => a - b)[7];
  };
  median(BASE); median(s.agentEnv); // warm up
  const plain = median(BASE);
  const guarded = median(s.agentEnv);
  assert.ok(guarded < plain * 2, `guarded ${guarded.toFixed(1)} ms vs plain ${plain.toFixed(1)} ms`);
});

test('the text check (Claude\'s Bash) catches the ways around it, and not everyday commands', () => {
  for (const cmd of ['git push --no-verify origin main', 'git push --no-veri -f', 'git -c core.hooksPath=/dev/null push -f', 'env -i git push -f', 'PODCODE_PUSH_OVERRIDE=abc git push -f', 'git send-pack --force origin main', '/usr/bin/git push -f origin main', 'BASH_ENV= bash -lc "git push -f"', "printf '#!/bin/sh' > ~/.podcode/git-hooks/pre-push"]) {
    assert.ok(disablesPushGuard(cmd), cmd);
  }
  for (const cmd of ['git push origin main', 'git commit -m "x"', 'npm test', 'git push -u origin fix/x', 'cat ~/.podcode/git-hooks/pre-push']) assert.equal(disablesPushGuard(cmd), null, cmd);
});
