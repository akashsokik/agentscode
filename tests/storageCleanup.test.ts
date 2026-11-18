import './isolate.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Express, Request, Response } from 'express';
import { gitEnv } from './isolate.ts';
import { cleanupStorage, emptyStorageBackups, listStorageCleanupCandidates, type StorageCleanupDeps } from '../server/storageCleanup.ts';
import { registerStorageCleanupRoutes } from '../server/storageCleanupRoutes.ts';

type Owner = ReturnType<StorageCleanupDeps['agents']> extends Iterable<infer T> ? T : never;
function write(file: string, text = 'payload'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function git(dir: string, ...args: string[]): string {
  // No core.hooksPath override: respect the installed push guard (ACH-N37).
  return execFileSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.name', 'Cleanup fixture');
  git(dir, 'config', 'user.email', 'cleanup@example.invalid');
  write(path.join(dir, 'source.txt'), 'source');
  git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
}
function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'podcode-cleanup-'));
  const dataDir = path.join(base, '.podcode');
  fs.mkdirSync(dataDir);
  const previous = process.env.PODCODE_HOME;
  process.env.PODCODE_HOME = dataDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PODCODE_HOME;
    else process.env.PODCODE_HOME = previous;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const agents: Owner[] = [];
  const projects: { path: string }[] = [];
  const deps: StorageCleanupDeps = { dataDir, agents: () => agents, projects: () => projects };
  const owner = (id = 'idle'): Owner => {
    const home = path.join(dataDir, 'agents', id);
    fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
    const agent: Owner = { id, name: id, home, worktree: null, status: 'done' };
    agents.push(agent);
    return agent;
  };
  const workspace = (agent: Owner) => path.join(agent.home, 'workspace');
  const output = (dir: string, name = 'node_modules') => {
    write(path.join(dir, 'package.json'), '{}');
    write(path.join(dir, name, 'file.txt'));
    return path.join(dir, name);
  };
  const worktree = (agent: Owner, branch = 'topic') => {
    const original = path.join(base, `original-${agent.id}`);
    repo(original);
    projects.push({ path: original });
    const target = path.join(dataDir, 'worktrees', agent.id, branch);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    git(original, 'worktree', 'add', '-b', branch, target, 'main');
    agent.worktree = { path: target, cwd: target, branch, base: 'main', baseCommit: git(original, 'rev-parse', 'HEAD'), repoRoot: original, gitDir: path.join(original, '.git') };
    return { original, target };
  };
  return { base, dataDir, deps, agents, projects, owner, workspace, output, worktree };
}

test('lists recognised outputs only in an assigned workspace with adjacent package.json or clean Git repo', async t => {
  const f = fixture(t), agent = f.owner(), workspace = f.workspace(agent);
  for (const name of ['node_modules', 'dist', 'out', '.vite', 'build-web']) f.output(workspace, name);
  write(path.join(workspace, 'notes', 'node_modules', 'file.txt'));
  write(path.join(workspace, 'build', 'file.txt'));
  write(path.join(f.dataDir, 'unassigned', 'package.json'), '{}');
  write(path.join(f.dataDir, 'unassigned', 'dist', 'file.txt'));
  const nested = path.join(workspace, 'checkout');
  repo(nested);
  write(path.join(nested, '.gitignore'), 'dist/\n');
  git(nested, 'add', '.gitignore');
  git(nested, '-c', 'commit.gpgsign=false', 'commit', '-m', 'ignore output');
  write(path.join(nested, 'dist', 'file.txt'));
  const candidates = await listStorageCleanupCandidates(f.deps);
  assert.equal(candidates.length, 6);
  assert.ok(candidates.every(c => c.kind === 'build-output' && c.agentId === agent.id && !path.isAbsolute(c.relPath) && c.bytes === 7));
  assert.ok(candidates.some(c => c.relPath.endsWith('checkout/dist')));
});

test('excludes working/waiting owners, original projects, forged homes and symlink paths', async t => {
  const f = fixture(t);
  for (const status of ['working', 'waiting'] as const) {
    const owner = f.owner(status); owner.status = status; f.output(f.workspace(owner));
  }
  const original = f.owner('original'); f.output(f.workspace(original)); f.projects.push({ path: f.workspace(original) });
  const foreign = f.owner('foreign'); foreign.home = path.join(f.base, 'outside'); f.output(f.workspace(foreign));
  const idle = f.owner(); f.output(path.join(f.workspace(idle), 'real'));
  fs.symlinkSync(path.join(f.workspace(idle), 'real'), path.join(f.workspace(idle), 'alias'), 'dir');
  fs.symlinkSync(path.join(f.workspace(foreign), 'node_modules'), path.join(f.workspace(idle), 'dist'), 'dir');
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 1);
  // A symlink in an ancestor is excluded too, even when it points within dataDir.
  fs.renameSync(f.workspace(idle), `${f.workspace(idle)}-old`);
  fs.symlinkSync(`${f.workspace(idle)}-old`, f.workspace(idle), 'dir');
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
});

test('merged clean linked worktrees qualify; dirty, ignored, untracked, unmerged, main and unassigned roots do not', async t => {
  const f = fixture(t), agent = f.owner(), { original, target } = f.worktree(agent);
  let candidates = await listStorageCleanupCandidates(f.deps);
  assert.equal(candidates.filter(c => c.kind === 'worktree').length, 1);
  write(path.join(target, 'source.txt'), 'changed');
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  git(target, 'restore', 'source.txt');
  write(path.join(target, 'untracked'));
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  fs.unlinkSync(path.join(target, 'untracked'));
  write(path.join(target, '.gitignore'), '.env\n');
  git(target, 'add', '.gitignore'); git(target, '-c', 'commit.gpgsign=false', 'commit', '-m', 'ignore');
  git(original, 'merge', '--ff-only', agent.worktree!.branch);
  write(path.join(target, '.env'), 'secret');
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  fs.unlinkSync(path.join(target, '.env'));
  write(path.join(target, 'source.txt'), 'new commit'); git(target, 'add', '.'); git(target, '-c', 'commit.gpgsign=false', 'commit', '-m', 'unmerged');
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  git(original, 'merge', '--ff-only', agent.worktree!.branch);
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 1);
  agent.worktree = null;
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  assert.ok(fs.existsSync(target));
});

test('build outputs in a dirty repo or containing tracked files are excluded', async t => {
  const f = fixture(t), agent = f.owner(), workspace = f.workspace(agent);
  repo(workspace);
  write(path.join(workspace, 'dist', 'tracked.txt'));
  write(path.join(workspace, '.gitignore'), 'node_modules/\n');
  git(workspace, 'add', '.'); git(workspace, '-c', 'commit.gpgsign=false', 'commit', '-m', 'tracked output');
  write(path.join(workspace, 'node_modules', 'file.txt'));
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 1);
  write(path.join(workspace, 'source.txt'), 'modified');
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
});

test('only selected outputs move; bytes are retained in backups until explicitly emptied; links never reach outside', async t => {
  const f = fixture(t), agent = f.owner(), workspace = f.workspace(agent);
  const output = f.output(workspace), kept = f.output(workspace, 'dist');
  const outside = path.join(f.base, 'outside'); write(path.join(outside, 'precious'), 'outside');
  fs.symlinkSync(outside, path.join(output, 'linked-external'), 'dir');
  const selected = (await listStorageCleanupCandidates(f.deps)).find(c => c.relPath.endsWith('node_modules'))!;
  const result = await cleanupStorage([selected.id, selected.id], f.deps);
  assert.equal(result.freedBytes, 0);
  assert.deepEqual(result.removed, [{ id: selected.id, bytes: selected.bytes }]);
  assert.deepEqual(result.skipped, []);
  assert.ok(result.backupDir?.startsWith(path.join(f.dataDir, 'backups', 'storage-cleanup-')));
  const backup = path.join(result.backupDir!, selected.relPath);
  assert.equal(fs.readFileSync(path.join(backup, 'file.txt'), 'utf8'), 'payload');
  assert.ok(fs.lstatSync(path.join(backup, 'linked-external')).isSymbolicLink());
  assert.ok(!fs.existsSync(output)); assert.ok(fs.existsSync(kept));
  write(path.join(f.dataDir, 'backups', 'manual', 'precious'), 'keep');
  fs.symlinkSync(outside, path.join(f.dataDir, 'backups', 'storage-cleanup-1234567890123-0123456789abcdef'), 'dir');
  const emptied = await emptyStorageBackups(f.deps);
  assert.ok(emptied.freedBytes >= selected.bytes);
  assert.ok(!fs.existsSync(result.backupDir!));
  assert.equal(fs.readFileSync(path.join(outside, 'precious'), 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'backups', 'manual', 'precious'), 'utf8'), 'keep');
  assert.equal((await emptyStorageBackups(f.deps)).freedBytes, 0);
});

test('POST rechecks working, reassigned, replaced, symlinked, dirty and changed contexts', async t => {
  const f = fixture(t), agent = f.owner(), workspace = f.workspace(agent), output = f.output(workspace);
  const selected = (await listStorageCleanupCandidates(f.deps))[0];
  agent.status = 'working';
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  agent.status = 'done'; f.agents.splice(0, 1);
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  f.agents.push(agent);
  fs.renameSync(output, `${output}-old`); fs.mkdirSync(output);
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  fs.rmdirSync(output); fs.renameSync(`${output}-old`, output);
  fs.unlinkSync(path.join(workspace, 'package.json'));
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  assert.ok(fs.existsSync(output));
  write(path.join(workspace, 'package.json'), '{}');
  fs.renameSync(output, `${output}-old`); fs.symlinkSync(`${output}-old`, output, 'dir');
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  assert.ok(fs.existsSync(path.join(`${output}-old`, 'file.txt')));
});

test('worktree removal creates a backup ref and a manifest before using Git removal; existing backup refs are kept', async t => {
  const f = fixture(t), agent = f.owner(), { original, target } = f.worktree(agent);
  const selected = (await listStorageCleanupCandidates(f.deps)).find(c => c.kind === 'worktree')!;
  const head = git(target, 'rev-parse', 'HEAD');
  const result = await cleanupStorage([selected.id], f.deps);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.removed.length, 1); assert.equal(result.freedBytes, selected.bytes);
  assert.equal(git(original, 'rev-parse', 'backup/topic'), head);
  assert.equal(git(original, 'rev-parse', 'topic'), head);
  assert.ok(!fs.existsSync(target));
  assert.ok(!git(original, 'worktree', 'list', '--porcelain').includes(target));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.items[0].backupRef, 'refs/heads/backup/topic');
  await emptyStorageBackups(f.deps);
  assert.equal(git(original, 'rev-parse', 'backup/topic'), head);
});

test('a stale worktree selection cannot remove new changes or an unmerged commit', async t => {
  const f = fixture(t), agent = f.owner(), { target } = f.worktree(agent);
  const selected = (await listStorageCleanupCandidates(f.deps))[0];
  write(path.join(target, 'source.txt'), 'changed');
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  git(target, 'add', '.'); git(target, '-c', 'commit.gpgsign=false', 'commit', '-m', 'new');
  assert.equal((await cleanupStorage([selected.id], f.deps)).skipped.length, 1);
  assert.ok(fs.existsSync(target));
});

test('existing backup refs at another commit are preserved and a distinct backup is created', async t => {
  const f = fixture(t), agent = f.owner(), { original, target } = f.worktree(agent);
  const old = git(original, 'rev-parse', 'HEAD');
  git(original, 'branch', 'backup/topic', old);
  write(path.join(target, 'source.txt'), 'merged update');
  git(target, 'add', '.'); git(target, '-c', 'commit.gpgsign=false', 'commit', '-m', 'merged');
  git(original, 'merge', '--ff-only', 'topic');
  const head = git(target, 'rev-parse', 'HEAD');
  const selected = (await listStorageCleanupCandidates(f.deps))[0];
  const result = await cleanupStorage([selected.id], f.deps);
  assert.equal(result.removed.length, 1);
  assert.equal(git(original, 'rev-parse', 'backup/topic'), old);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir!, 'manifest.json'), 'utf8'));
  assert.match(manifest.items[0].backupRef, /^refs\/heads\/backup\/topic-storage-cleanup-/);
  assert.equal(git(original, 'rev-parse', manifest.items[0].backupRef), head);
});

test('registered original folders added after GET, including folders nested in an output, are protected', async t => {
  const f = fixture(t), agent = f.owner(), output = f.output(f.workspace(agent));
  const selected = (await listStorageCleanupCandidates(f.deps))[0];
  f.projects.push({ path: path.join(output, 'nested-project') });
  const result = await cleanupStorage([selected.id], f.deps);
  assert.equal(result.removed.length, 0); assert.equal(result.skipped.length, 1);
  assert.ok(fs.existsSync(output));
});

test('cross-agent busy use of the same attributed worktree excludes its idle owner too', async t => {
  const f = fixture(t), agent = f.owner(), { target } = f.worktree(agent);
  const other = f.owner('busy-peer'); other.status = 'working'; other.worktree = agent.worktree;
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  assert.ok(fs.existsSync(target));
});

test('forged worktree attribution cannot name an original checkout or an external worktree', async t => {
  const f = fixture(t), agent = f.owner(), { original, target } = f.worktree(agent);
  agent.worktree!.path = original;
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  agent.worktree!.path = path.join(f.base, 'external-worktree');
  git(original, 'worktree', 'add', '-b', 'external', agent.worktree!.path, 'main');
  agent.worktree!.branch = 'external';
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
  assert.ok(fs.existsSync(target)); assert.ok(fs.existsSync(original));
});

test('a symlink .git, including a dangling marker, is not followed even with package.json', async t => {
  const f = fixture(t), agent = f.owner(), workspace = f.workspace(agent);
  f.output(workspace);
  fs.symlinkSync(path.join(f.base, 'missing-git'), path.join(workspace, '.git'));
  assert.equal((await listStorageCleanupCandidates(f.deps)).length, 0);
});

test('build-* folders that are repositories, or outputs containing repositories, are not disposable', async t => {
  const f = fixture(t), agent = f.owner(), workspace = f.workspace(agent);
  write(path.join(workspace, 'package.json'), '{}');
  repo(path.join(workspace, 'build-repository'));
  f.output(workspace);
  repo(path.join(workspace, 'node_modules', 'nested-checkout'));
  assert.deepEqual(await listStorageCleanupCandidates(f.deps), []);
});

test('a symlink backups root blocks moving outputs, and malformed ids cannot name arbitrary paths', async t => {
  const f = fixture(t), agent = f.owner(), output = f.output(f.workspace(agent));
  const selected = (await listStorageCleanupCandidates(f.deps))[0];
  const outside = path.join(f.base, 'external-backups'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.dataDir, 'backups'), 'dir');
  const result = await cleanupStorage([selected.id], f.deps);
  assert.equal(result.removed.length, 0); assert.equal(result.skipped.length, 1);
  assert.ok(fs.existsSync(output)); assert.deepEqual(fs.readdirSync(outside), []);
  await assert.rejects(cleanupStorage(['../../precious'], f.deps));
  assert.equal((await emptyStorageBackups(f.deps)).freedBytes, 0);
});

test('routes require an explicit selection and true confirmation before emptying backups', async t => {
  const f = fixture(t);
  type Handler = (req: Request, res: Response) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const app = {
    get: (route: string, handler: Handler) => handlers.set(`GET ${route}`, handler),
    post: (route: string, handler: Handler) => handlers.set(`POST ${route}`, handler),
  } as unknown as Express;
  registerStorageCleanupRoutes(app, f.deps);
  let json: unknown;
  const res = { json: (value: unknown) => { json = value; } } as Response;
  const req = (body: unknown) => ({ body } as Request);
  await handlers.get('GET /api/storage/cleanup/candidates')!(req(null), res);
  assert.deepEqual(json, { candidates: [] });
  await assert.rejects(handlers.get('POST /api/storage/cleanup')!(req({}), res), /Choose/);
  for (const confirm of [undefined, false, 1, 'true']) {
    await assert.rejects(handlers.get('POST /api/storage/backups/empty')!(req({ confirm }), res), /Confirm/);
  }
  await handlers.get('POST /api/storage/backups/empty')!(req({ confirm: true }), res);
  assert.deepEqual(json, { freedBytes: 0 });
});

test('route invalidation runs after cleanup and backup emptying, never on reads or refused confirmation', async t => {
  const f = fixture(t), agent = f.owner(); f.output(f.workspace(agent));
  type Handler = (req: Request, res: Response) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const app = {
    get: (route: string, handler: Handler) => handlers.set(`GET ${route}`, handler),
    post: (route: string, handler: Handler) => handlers.set(`POST ${route}`, handler),
  } as unknown as Express;
  let invalidated = 0;
  registerStorageCleanupRoutes(app, { ...f.deps, onChange: () => { invalidated++; } });
  const res = { json: () => {} } as unknown as Response;
  await handlers.get('GET /api/storage/cleanup/candidates')!({} as Request, res);
  assert.equal(invalidated, 0);
  const candidates = await listStorageCleanupCandidates(f.deps);
  await handlers.get('POST /api/storage/cleanup')!({ body: { ids: [candidates[0].id] } } as Request, res);
  assert.equal(invalidated, 1);
  await assert.rejects(handlers.get('POST /api/storage/backups/empty')!({ body: { confirm: false } } as Request, res));
  assert.equal(invalidated, 1);
  await handlers.get('POST /api/storage/backups/empty')!({ body: { confirm: true } } as Request, res);
  assert.equal(invalidated, 2);
});
