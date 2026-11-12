import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCRIPT_OVERRIDE_NAMES, scrubScriptOverrides, withoutScriptOverrides } from '../server/envHygiene.ts';
import { GIT_REPO_ENV, gitEnv, tempDir, withoutGitRepoEnv } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- the restart and install scripts' path overrides never reach agents (ACH-N8) -------------------

test('the overrides are dropped under both names; the app and comms settings are kept', () => {
  const env = {
    PODCODE_PREV: '/real/PodCode-before.app', AGENTSCODE_PREV: '/x', PODCODE_NEW_BUILD: '/real/staged.app', PODCODE_APP: '/Applications/PodCode.app',
    PODCODE_INSTALL_DIR: '/Applications', AGENTSCODE_LOCK: '/tmp/l', PODCODE_LEGACY_LOCK: '/tmp/ll', PODCODE_TICK: '1', PODCODE_PORT: '1', PODCODE_VERSION: '0.3.1', PODCODE_NO_OPEN: '1',
    PODCODE_HOME: '/h', PODCODE_TOKEN: 't', PODCODE_TOOLS_URL: 'u', PODCODE_EXECUTIVE: '1', PODCODE_EYES: '1', PODCODE_DISABLE_UPDATES: '1', PATH: '/bin',
  };
  assert.deepEqual(Object.keys(withoutScriptOverrides(env)).sort(), ['PATH', 'PODCODE_DISABLE_UPDATES', 'PODCODE_EXECUTIVE', 'PODCODE_EYES', 'PODCODE_HOME', 'PODCODE_TOKEN', 'PODCODE_TOOLS_URL']);
  assert.equal(env.PODCODE_PREV, '/real/PodCode-before.app', 'the copy is new; the input is unchanged');
  const own = { ...env };
  assert.ok(scrubScriptOverrides(own).includes('PODCODE_PREV'));
  assert.equal('PODCODE_PREV' in own, false);
});

test('a server started with them set passes none of them to what it starts', () => {
  const home = tempDir('env-boot');
  // boot.ts is the server's first import; PODCODE_HOME set means it moves no data folder.
  const script = `await import(${JSON.stringify(path.join(ROOT, 'server', 'boot.ts'))});
const { execFileSync } = await import('node:child_process');
process.stdout.write(execFileSync('/usr/bin/env', { encoding: 'utf8' }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', PODCODE_HOME: home, PODCODE_PREV: '/real/PodCode-before.app', AGENTSCODE_NEW_BUILD: '/real/staged.app', PODCODE_INSTALL_DIR: '/Applications', PODCODE_TOKEN: 'kept' },
  });
  const names = out.split('\n').map(line => line.split('=')[0]);
  assert.deepEqual(names.filter(n => SCRIPT_OVERRIDE_NAMES.includes(n)), [], out);
  assert.ok(names.includes('PODCODE_HOME') && names.includes('PODCODE_TOKEN'), 'the app\'s own settings stay');
});

test('restart-desktop.sh unsets every override the server drops, so the app it opens never gets them', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'restart-desktop.sh'), 'utf8');
  const unset = /^unset ((?:.|\\\n)*?)$/m.exec(script.replace(/\\\n\s*/g, ' '))?.[1].split(/\s+/).filter(Boolean) ?? [];
  assert.deepEqual([...unset].sort(), [...SCRIPT_OVERRIDE_NAMES].sort());
});

// ---- test runs never act on a real repository through GIT_DIR and the like -------------------------

test('the test helpers drop GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_COMMON_DIR', () => {
  for (const name of GIT_REPO_ENV) assert.equal(name in process.env, false, name);
  assert.deepEqual(Object.keys(withoutGitRepoEnv({ GIT_DIR: 'a', GIT_WORK_TREE: 'b', GIT_INDEX_FILE: 'c', GIT_COMMON_DIR: 'd', GIT_AUTHOR_NAME: 'T', PATH: '/bin' })).sort(), ['GIT_AUTHOR_NAME', 'PATH']);
  assert.equal('GIT_DIR' in gitEnv(), false);
});

test('started from a git hook (GIT_DIR set to a real repository), a test\'s git commands stay in their own folder', () => {
  const victim = path.join(tempDir('env-victim'), 'repo');
  fs.mkdirSync(victim);
  execFileSync('git', ['init', '-q'], { cwd: victim, env: gitEnv() });
  const before = fs.readFileSync(path.join(victim, '.git', 'config'), 'utf8');
  const work = tempDir('env-own');
  // What a test file does: import the helpers, then run git with no env of its own.
  const script = `await import(${JSON.stringify(path.join(ROOT, 'tests', 'helpers.ts'))});
const { execFileSync } = await import('node:child_process');
execFileSync('git', ['init', '-q'], { cwd: ${JSON.stringify(work)} });
execFileSync('git', ['config', 'user.name', 'Test'], { cwd: ${JSON.stringify(work)} });`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_DIR: path.join(victim, '.git'), GIT_WORK_TREE: victim, GIT_INDEX_FILE: path.join(victim, '.git', 'index') },
  });
  assert.ok(fs.existsSync(path.join(work, '.git', 'config')), 'git made the test\'s own repository');
  assert.equal(fs.readFileSync(path.join(victim, '.git', 'config'), 'utf8'), before, 'the real repository is untouched');
});
