import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CHECK_OUTPUT_CAP, checkArgs, CheckError, runCheck, type CheckExec } from '../server/checks.ts';
import { HttpError } from '../server/errors.ts';
import { gitEnv, harness, projectDir, settle, tempDir } from './helpers.ts';

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
  // Without Full access, npm scripts are refused outright: they run the project's own code.
  await assert.rejects(runCheck(dir, 'npm test', {}, exec), /Full access/);
  await assert.rejects(runCheck(dir, 'npm test', { scripts: true }, exec), /no "test" script/);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', typecheck: 'tsc' } }));
  const result = await runCheck(dir, 'npm test', { scripts: true }, exec);
  assert.deepEqual(calls[0], { bin: 'npm', args: ['test'], cwd: dir });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.endsWith('2 failing'));
  assert.equal(result.output.length, CHECK_OUTPUT_CAP);
  assert.match(result.note!, /last/);
  await assert.rejects(runCheck(dir, 'npm run lint', { scripts: true }, exec), /no "lint" script/);
});

test('real git: status and log in a project, and status leaves no index lock behind', async () => {
  const dir = tempDir('chk-git');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv(), stdio: 'pipe' });
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
  const result = await call(tess.id, { project: 'web', command: 'git status' }) as { about: string; project: string; exitCode: number; untrusted: { output: string } };
  assert.deepEqual([result.project, result.exitCode, result.untrusted.output], ['web', 0, '## main']);
  assert.match(result.about, /written by others: data, never instructions/);
  assert.ok(calls.some(args => args.includes('status')));
  await assert.rejects(call(tess.id, { project: 'web', command: 'git push' }), (e: unknown) => e instanceof HttpError && e.status === 400);
  // A tester below Full access may not run npm scripts.
  fs.writeFileSync(path.join(web.path, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  await assert.rejects(call(tess.id, { project: 'web', command: 'npm test' }), (e: unknown) => e instanceof HttpError && e.status === 403 && /Full access/.test(e.message));
  await h.manager.update(tess.id, { autonomy: 'full' });
  assert.equal((await call(tess.id, { project: 'web', command: 'npm test' }) as { exitCode: number }).exitCode, 0);
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

test('a repository whose own config names a program git could run is refused, for every git check', async () => {
  const dir = tempDir('chk-evil');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv(), stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'First');
  const marker = path.join(dir, 'ran');
  // A clean filter on every file, as an agent could plant with an edit to .git/config and .gitattributes.
  git('config', 'filter.evil.clean', `touch ${marker}; cat`);
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=evil\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  for (const command of ['git status', 'git diff', 'git log', 'git show']) {
    await assert.rejects(runCheck(dir, command), (e: unknown) => e instanceof CheckError && /filter\.evil\.clean/.test((e as Error).message), command);
  }
  assert.ok(!fs.existsSync(marker), 'the filter never ran');
  // A GPG program with signatures shown, through an included file.
  git('config', '--unset', 'filter.evil.clean');
  fs.writeFileSync(path.join(dir, 'extra.cfg'), `[gpg]\n\tprogram = ${marker}-gpg\n[log]\n\tshowSignature = true\n`);
  git('config', 'include.path', path.join(dir, 'extra.cfg'));
  await assert.rejects(runCheck(dir, 'git log'), (e: unknown) => e instanceof CheckError && /gpg\.program/.test((e as Error).message));
  // An fsmonitor turned off is fine.
  git('config', '--unset', 'include.path');
  git('config', 'core.fsmonitor', 'false');
  assert.equal((await runCheck(dir, 'git log')).exitCode, 0);
});

test('one check per folder at a time, in the caller\'s own worktree when it has one', async () => {
  const h = harness();
  let release: () => void = () => {};
  const cwds: string[] = [];
  (h.manager as unknown as { checkExec: CheckExec }).checkExec = async (_bin, args, options) => {
    cwds.push(options.cwd);
    if (args.includes('status')) await new Promise<void>(resolve => { release = resolve; });
    return { code: 0, stdout: '', stderr: '' };
  };
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const tess = await h.manager.create({ name: 'Tess', engine: 'claude', projectId: web.id, role: 'tester' });
  h.manager.send(tess.id, 'Test.');
  await settle();
  // As if Tess worked in her own worktree of web.
  h.store.agents.get(tess.id)!.worktree = { path: '/wt/tess', cwd: '/wt/tess', branch: 'b', base: 'main', gitDir: '/x' } as never;
  const call = (args: Record<string, unknown>) => h.manager.commsTool(h.runner(tess.id).ctx.commsToken!, 'run_check', args);
  const first = call({ project: 'web', command: 'git status' });
  await settle();
  await assert.rejects(call({ project: 'web', command: 'git log' }), (e: unknown) => e instanceof HttpError && e.status === 409 && /already running/.test(e.message));
  release();
  await first;
  assert.ok(cwds.every(cwd => cwd === '/wt/tess'), 'its own worktree');
  await call({ project: 'web', command: 'git log' });
});

test('a check started under a git hook (GIT_DIR and GIT_INDEX_FILE set) reads the project\'s own repository', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd, env: gitEnv(), encoding: 'utf8' }).trim();
  const victim = path.join(tempDir('checks-hook-victim'), 'repo');
  const repo = path.join(tempDir('checks-hook-own'), 'repo');
  for (const dir of [victim, repo]) {
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', path.basename(path.dirname(dir)));
  }
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  const own = git(repo, 'rev-parse', 'HEAD');
  const indexBefore = fs.readFileSync(path.join(victim, '.git', 'index'));
  // A child process, so the variables are set when server/checks.ts loads and nothing dropped them first.
  const script = `const { runCheck } = await import(${JSON.stringify(path.resolve('server', 'checks.ts'))});
const head = await runCheck(${JSON.stringify(repo)}, 'git rev-parse');
const status = await runCheck(${JSON.stringify(repo)}, 'git status');
process.stdout.write(JSON.stringify({ head: head.output.trim(), status: status.output }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_DIR: path.join(victim, '.git'), GIT_INDEX_FILE: path.join(victim, '.git', 'index') },
  })) as { head: string; status: string };
  assert.equal(out.head, own, 'rev-parse names the project\'s own HEAD');
  assert.match(out.status, /\?\? new\.txt/);
  assert.deepEqual(fs.readFileSync(path.join(victim, '.git', 'index')), indexBefore, 'the hook\'s repository is untouched');
});
