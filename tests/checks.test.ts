import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CHECK_OUTPUT_CAP, checkArgs, CheckError, runCheck, type CheckExec } from '../server/checks.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

test('run_check runs only its fixed read-only commands; everything else is refused before anything runs', async () => {
  for (const bad of ['git push', 'git commit', 'git checkout main', 'git reset --hard', 'git clean -fd', 'npm install', 'npm run build', 'npm publish', 'rm -rf /', 'sh -c ls', 'git', '']) {
    assert.throws(() => checkArgs(bad), CheckError, bad);
  }
  const calls: string[][] = [];
  const exec: CheckExec = async (_bin, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  await assert.rejects(runCheck(tempDir('chk'), 'git push', {}, exec), CheckError);
  // Revisions that could pass as options are refused.
  for (const ref of ['--output=/tmp/x', '-p', 'main..-x', 'a b', 'x;rm']) assert.throws(() => checkArgs('git log', { ref }), CheckError, ref);
  assert.deepEqual(calls, [], 'nothing ran');
  // Git never runs a hook, pager or external diff program.
  const diff = checkArgs('git diff', { ref: 'main..feature', stat: true }).args;
  for (const flag of ['core.fsmonitor=false', 'core.pager=cat', 'diff.external=', '--no-pager', '--no-ext-diff', '--no-textconv']) assert.ok(diff.includes(flag), flag);
  assert.deepEqual(diff.slice(-3), ['--stat', 'main..feature', '--']);
  assert.deepEqual(checkArgs('git log', { count: 500 }).args.slice(-3), ['-n', '100', '--']);
});

test('npm checks run only scripts the project has; a failing command is a result, and output is capped', async () => {
  const dir = tempDir('chk-npm');
  const calls: { bin: string; args: string[]; cwd: string }[] = [];
  const exec: CheckExec = async (bin, args, options) => { calls.push({ bin, args, cwd: options.cwd }); return { code: 1, stdout: 'x'.repeat(CHECK_OUTPUT_CAP + 10), stderr: '2 failing' }; };
  await assert.rejects(runCheck(dir, 'npm test', {}, exec), /no "test" script/);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc' } }));
  const result = await runCheck(dir, 'npm test', {}, exec);
  assert.deepEqual(calls[0], { bin: 'npm', args: ['test'], cwd: dir });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.endsWith('2 failing'));
  assert.equal(result.output.length, CHECK_OUTPUT_CAP);
  assert.match(result.note!, /last/);
  await assert.rejects(runCheck(dir, 'npm run lint', {}, exec), /no "lint" script/);
});

test('real git: status and log in a project, and status leaves no index lock behind', async () => {
  const dir = tempDir('chk-git');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'First');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const status = await runCheck(dir, 'git status');
  assert.equal(status.exitCode, 0);
  assert.match(status.output, /## main\n M a.txt/);
  const log = await runCheck(dir, 'git log', { count: 5 });
  assert.match(log.output, /First/);
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'index.lock')));
});

test('through the server: the SuperAgent, reviewers and testers may run checks in a project; developers may not', async () => {
  const h = harness();
  const calls: string[][] = [];
  (h.manager as unknown as { checkExec: CheckExec }).checkExec = async (_bin, args) => { calls.push(args); return { code: 0, stdout: '## main', stderr: '' }; };
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const tess = await h.manager.create({ name: 'Tess', engine: 'claude', projectId: null, role: 'tester' });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  h.manager.send(tess.id, 'Test.');
  h.manager.send(ada.id, 'Code.');
  await settle();
  const call = (id: string, args: Record<string, unknown>) => h.manager.commsTool(h.runner(id).ctx.commsToken!, 'run_check', args);
  const result = await call(tess.id, { project: 'web', command: 'git status' }) as { project: string; exitCode: number; output: string };
  assert.deepEqual([result.project, result.exitCode, result.output], ['web', 0, '## main']);
  assert.ok(calls[0].includes('status'));
  await assert.rejects(call(tess.id, { project: 'web', command: 'git push' }), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(call(ada.id, { project: 'web', command: 'git status' }), (e: unknown) => e instanceof HttpError && e.status === 403);
});

test('run_check follows the eyes scope: a tester with a project checks only its own', async () => {
  const h = harness();
  (h.manager as unknown as { checkExec: CheckExec }).checkExec = async () => ({ code: 0, stdout: 'ok', stderr: '' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const api = h.manager.addProject({ path: projectDir(h.dir, 'api') });
  const tess = await h.manager.create({ name: 'Tess', engine: 'claude', projectId: api.id, role: 'tester' });
  h.manager.send(tess.id, 'Test.');
  await settle();
  const call = (args: Record<string, unknown>) => h.manager.commsTool(h.runner(tess.id).ctx.commsToken!, 'run_check', args);
  assert.equal((await call({ project: 'api', command: 'git status' }) as { project: string }).project, 'api');
  await assert.rejects(call({ project: web.name, command: 'git status' }), (e: unknown) => e instanceof HttpError && e.status === 403);
});
