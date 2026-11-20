import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Project } from '../shared/types.ts';
import type { StorageCleanupCandidate, StorageCleanupResult } from '../shared/storageCleanup.ts';
import { HttpError } from './errors.ts';
import { storageAppProtection } from './storageAppProtection.ts';
import { gitEnv } from './envHygiene.ts';

export interface StorageCleanupDeps {
  dataDir: string;
  desktopExecutable?: string;
  agents: () => Iterable<Pick<Agent, 'id' | 'name' | 'home' | 'status' | 'worktree'>>;
  projects: () => Iterable<Pick<Project, 'path'>>;
}

type Owner = ReturnType<StorageCleanupDeps['agents']> extends Iterable<infer T> ? T : never;
type Item = StorageCleanupCandidate & { absolute: string; root: string; owner: Owner };
type WorktreeState = { head: string; branch: string; repoRoot: string };
const OUTPUT = /^(?:node_modules|dist|out|\.vite|build-.+)$/;
const BACKUP = /^storage-cleanup-\d{13}-[a-f0-9]{16}$/;
const queues = new Map<string, Promise<unknown>>();
// Same program/optional-lock protections as work.ts readGit, also for backup ref writes.
// These internal commands never push; repository-supplied hooks must not run in the server.
const GIT_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'diff.submodule=short', '-c', 'status.submoduleSummary=false'];
const GIT_EXTRA = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };

/** A configured data directory may itself be a link; links below that boundary stay forbidden. */
function canonicalDeps(deps: StorageCleanupDeps): StorageCleanupDeps {
  const configured = path.resolve(deps.dataDir);
  const dataDir = fs.realpathSync(configured);
  const mapped = (file: string) => {
    const absolute = path.resolve(file);
    return absolute === configured || within(configured, absolute) ? path.join(dataDir, path.relative(configured, absolute)) : absolute;
  };
  return {
    ...deps, dataDir,
    agents: () => [...deps.agents()].map(owner => ({
      ...owner, home: mapped(owner.home),
      worktree: owner.worktree ? { ...owner.worktree, path: mapped(owner.worktree.path), cwd: mapped(owner.worktree.cwd), repoRoot: mapped(owner.worktree.repoRoot), gitDir: mapped(owner.worktree.gitDir) } : null,
    })),
    projects: () => [...deps.projects()].map(project => {
      const declared = mapped(project.path);
      // Canonicalize declared original-folder aliases for protection only; never scan them.
      try { return { ...project, path: fs.realpathSync(declared) }; } catch { return { ...project, path: declared }; }
    }),
  };
}

function execGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code?: string | number }> {
  return new Promise(resolve => {
    execFile('git', [...GIT_FLAGS, ...args], { cwd, env: gitEnv(GIT_EXTRA), timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(error ? { code: error.code } : {}) });
    });
  });
}

async function gitRun(cwd: string, args: string[]) {
  if (args[0] !== 'status') return execGit(cwd, args);
  // Even status can launch clean/process filters. Enumerate names safely, then disable all
  // configured drivers. Never fall back to status if the config cannot be read.
  const filters = await execGit(cwd, ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\.']);
  if (!filters.ok && filters.code !== 1) return filters;
  const drivers = new Set(filters.stdout.split('\0').filter(Boolean).map(key => key.slice(0, key.lastIndexOf('.'))));
  const overrides = [...drivers].flatMap(driver => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`]);
  // A submodule has its own program config. Refuse worktrees with submodules below, and never
  // recurse into a newly added submodule if another process changes the index during a check.
  return execGit(cwd, [...overrides, 'status', '--ignore-submodules=all', ...args.slice(1)]);
}

function within(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Inspect every component below the trusted data directory, never a symlink's target. */
function safe(root: string, file: string): fs.Stats {
  if (!within(root, file)) throw new Error('Path is outside the data directory.');
  let current = root;
  let stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The data directory is not a real directory.');
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment);
    stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Symlink paths are excluded.');
  }
  return stat;
}

function directory(root: string, file: string): boolean {
  try { return safe(root, file).isDirectory(); } catch { return false; }
}

function regular(root: string, file: string): boolean {
  try { return safe(root, file).isFile(); } catch { return false; }
}

/** Logical file bytes, like the storage scan. Links are neither counted nor followed. */
function bytes(file: string, rejectRepositories = false): number {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('Unsupported filesystem entry.');
  return fs.readdirSync(file).reduce((total, name) => {
    if (rejectRepositories && name === '.git') throw new Error('Build output contains a repository or worktree; it is not disposable.');
    return total + bytes(path.join(file, name), rejectRepositories);
  }, 0);
}

function privateRoot(dataDir: string, owner: Owner): string | null {
  if (!owner.id || path.basename(owner.id) !== owner.id || owner.id === '.' || owner.id === '..') return null;
  const home = path.join(dataDir, 'agents', owner.id);
  return path.resolve(owner.home) === home ? path.join(home, 'workspace') : null;
}

function roots(dataDir: string, owner: Owner): string[] {
  const result: string[] = [];
  const workspace = privateRoot(dataDir, owner);
  if (workspace) result.push(workspace);
  if (owner.worktree && within(path.join(dataDir, 'worktrees'), path.resolve(owner.worktree.path))) result.push(path.resolve(owner.worktree.path));
  return result;
}

function busy(owner: Owner): boolean { return owner.status === 'working' || owner.status === 'waiting'; }

function ownerCheck(item: Item, deps: StorageCleanupDeps): Owner {
  const owners = [...deps.agents()];
  const owner = owners.find(agent => agent.id === item.agentId);
  const dataDir = path.resolve(deps.dataDir);
  if (!owner || !roots(dataDir, owner).includes(item.root)) throw new Error('This root is no longer assigned to that agent.');
  if (busy(owner)) throw new Error('The agent is working or waiting.');
  for (const agent of owners.filter(busy)) {
    if (roots(dataDir, agent).some(root => root === item.absolute || within(root, item.absolute) || within(item.absolute, root))) {
      throw new Error('A working agent uses this root.');
    }
  }
  for (const project of deps.projects()) {
    const original = path.resolve(project.path);
    if (original === item.absolute || within(original, item.absolute) || within(item.absolute, original)) {
      throw new Error('Original project folders are excluded.');
    }
  }
  if (!safe(dataDir, item.absolute).isDirectory()) throw new Error('The candidate is no longer a directory.');
  return owner;
}

async function checkBeforeRemoval(item: Item, deps: StorageCleanupDeps): Promise<void> {
  const protection = storageAppProtection(deps.desktopExecutable);
  const reason = await protection(item.absolute, item.root);
  if (reason) throw new Error(reason);
  ownerCheck(item, deps);
}

function identity(dataDir: string, file: string, agentId: string, kind: Item['kind']): string {
  const stat = safe(dataDir, file);
  return createHash('sha256').update(JSON.stringify([kind, agentId, path.relative(dataDir, file), stat.dev, stat.ino])).digest('hex');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitRun(cwd, args);
  if (!result.ok) throw new Error((result.stderr || result.stdout || 'Git refused the operation.').trim().slice(0, 500));
  return result.stdout.trim();
}

function samePath(left: string, right: string): boolean {
  return fs.realpathSync(left) === fs.realpathSync(right);
}

async function noSubmodules(cwd: string): Promise<void> {
  if (fs.existsSync(path.join(cwd, '.gitmodules')) || (await git(cwd, ['ls-files', '--stage', '-z'])).split('\0').some(entry => entry.startsWith('160000 '))) {
    throw new Error('Repositories with submodules require manual cleanup.');
  }
  for (const flag of ['--git-dir', '--git-common-dir']) {
    const dir = await git(cwd, ['rev-parse', '--path-format=absolute', flag]);
    if (fs.existsSync(path.join(dir, 'modules'))) throw new Error('Repositories with registered submodules require manual cleanup.');
  }
}

async function worktreeState(item: Item, deps: StorageCleanupDeps): Promise<WorktreeState> {
  const owner = ownerCheck(item, deps);
  const worktree = owner.worktree;
  if (!worktree || path.resolve(worktree.path) !== item.absolute || !regular(path.resolve(deps.dataDir), path.join(item.absolute, '.git'))) {
    throw new Error('Only an assigned linked worktree can be removed.');
  }
  if (!samePath(await git(item.absolute, ['rev-parse', '--show-toplevel']), item.absolute)) throw new Error('The worktree root changed.');
  const common = path.resolve(item.absolute, await git(item.absolute, ['rev-parse', '--git-common-dir']));
  const originalCommon = path.resolve(worktree.repoRoot, await git(worktree.repoRoot, ['rev-parse', '--git-common-dir']));
  if (!samePath(common, originalCommon) || !samePath(common, worktree.gitDir)) throw new Error('The worktree repository changed.');
  const branch = await git(item.absolute, ['branch', '--show-current']);
  if (!branch || branch === 'main' || branch !== worktree.branch) throw new Error('The worktree branch changed or is main/detached.');
  const head = await git(item.absolute, ['rev-parse', '--verify', 'HEAD^{commit}']);
  await git(item.absolute, ['merge-base', '--is-ancestor', head, 'refs/heads/main']);
  await noSubmodules(item.absolute);
  // Ignored files (for example .env) are not recoverable from a Git ref either.
  if (await git(item.absolute, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'])) {
    throw new Error('The worktree has modified, untracked or ignored files.');
  }
  ownerCheck(item, deps);
  return { head, branch, repoRoot: worktree.repoRoot };
}

async function buildOutputCheck(item: Item, deps: StorageCleanupDeps): Promise<void> {
  ownerCheck(item, deps);
  const dataDir = path.resolve(deps.dataDir);
  if (!OUTPUT.test(path.basename(item.absolute))) throw new Error('Not a recognised build output.');
  let current = path.dirname(item.absolute);
  let repo: string | undefined;
  for (;;) {
    const marker = path.join(current, '.git');
    let markerExists = false;
    try { fs.lstatSync(marker); markerExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (markerExists) {
      safe(dataDir, marker); // a symlink .git is never followed
      if (!samePath(await git(current, ['rev-parse', '--show-toplevel']), current)) throw new Error('The repository root changed.');
      repo = current;
      break;
    }
    if (current === item.root) break;
    current = path.dirname(current);
  }
  if (repo) {
    await noSubmodules(repo);
    if (await git(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('The workspace repository is dirty.');
    if (await git(repo, ['ls-files', '-z', '--', path.relative(repo, item.absolute)])) throw new Error('Tracked files are not disposable build outputs.');
  } else if (!regular(dataDir, path.join(path.dirname(item.absolute), 'package.json'))) {
    throw new Error('No Git repository or adjacent package.json.');
  } else if ((await gitRun(item.root, ['rev-parse', '--show-toplevel'])).ok) {
    throw new Error('The repository root is outside the assigned workspace.');
  }
  ownerCheck(item, deps);
}

async function eligible(item: Item, deps: StorageCleanupDeps): Promise<void> {
  if (identity(path.resolve(deps.dataDir), item.absolute, item.agentId!, item.kind) !== item.id) throw new Error('The directory was replaced.');
  if (item.kind === 'worktree') await worktreeState(item, deps);
  else await buildOutputCheck(item, deps);
}

async function discover(deps: StorageCleanupDeps, skipped?: Map<string, string>): Promise<Item[]> {
  const protection = storageAppProtection(deps.desktopExecutable);
  const dataDir = path.resolve(deps.dataDir);
  const result: Item[] = [];
  const seen = new Set<string>();
  const add = async (owner: Owner, root: string, absolute: string, kind: Item['kind']) => {
    try {
      if (seen.has(absolute)) return;
      const item: Item = {
        id: identity(dataDir, absolute, owner.id, kind), agentId: owner.id, kind,
        label: kind === 'worktree' ? `${owner.name}: ${owner.worktree!.branch}` : `${owner.name}: ${path.basename(absolute)}`,
        relPath: path.relative(dataDir, absolute), absolute, root, owner, bytes: 0,
        reason: kind === 'worktree' ? 'Clean branch merged into main; a backup ref is kept.' : 'Build output; moved to backups, freeing no space until backups are emptied. Refresh afterward for merged worktrees blocked by ignored outputs.',
      };
      const reason = await protection(absolute, root);
      if (reason) {
        skipped?.set(item.id, reason);
        return;
      }
      await eligible(item, deps);
      item.bytes = bytes(absolute, kind === 'build-output');
      result.push(item);
      seen.add(absolute);
    } catch { /* A candidate must pass every check; unreadable or changing trees are excluded. */ }
  };
  for (const owner of deps.agents()) {
    if (busy(owner)) continue;
    for (const root of roots(dataDir, owner)) {
      if (!directory(dataDir, root)) continue;
      if (owner.worktree && path.resolve(owner.worktree.path) === root) await add(owner, root, root, 'worktree');
      const walk = async (dir: string): Promise<void> => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === '.git') continue;
          const file = path.join(dir, entry.name);
          if (!directory(dataDir, file)) continue;
          if (OUTPUT.test(entry.name)) await add(owner, root, file, 'build-output');
          else await walk(file);
        }
      };
      try { await walk(root); } catch { /* Files may disappear during a scan. */ }
    }
  }
  return result;
}

export async function listStorageCleanupCandidates(deps: StorageCleanupDeps): Promise<StorageCleanupCandidate[]> {
  return (await discover(canonicalDeps(deps))).map(({ absolute: _absolute, root: _root, owner: _owner, ...candidate }) => candidate);
}

/** Serialize destructive requests, including emptying backups, within this server process. */
async function exclusive<T>(deps: StorageCleanupDeps, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(deps.dataDir);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}

function mkdirSafe(dataDir: string, dir: string): void {
  if (fs.existsSync(dir)) {
    if (!safe(dataDir, dir).isDirectory()) throw new Error('Backup path is not a real directory.');
    return;
  }
  if (!within(dataDir, dir)) throw new Error('Backup path escapes the data directory.');
  const parent = path.dirname(dir);
  if (parent !== dataDir) mkdirSafe(dataDir, parent);
  else if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('Symlink data directory.');
  fs.mkdirSync(dir, { mode: 0o700 });
  safe(dataDir, dir);
}

export async function cleanupStorage(ids: readonly string[], deps: StorageCleanupDeps): Promise<StorageCleanupResult> {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
    throw new HttpError(400, 'Choose at most 500 candidate ids from the cleanup list.');
  }
  deps = canonicalDeps(deps);
  return exclusive(deps, async () => {
    const dataDir = path.resolve(deps.dataDir);
    const protectedIds = new Map<string, string>();
    const available = new Map((await discover(deps, protectedIds)).map(item => [item.id, item]));
    const result: StorageCleanupResult = { backupDir: null, removed: [], skipped: [], freedBytes: 0 };
    const manifest: { version: 1; kind: string; items: Record<string, unknown>[] } = { version: 1, kind: 'podcode-storage-cleanup', items: [] };
    const save = () => {
      if (!result.backupDir) {
        result.backupDir = path.join(dataDir, 'backups', `storage-cleanup-${Date.now()}-${randomBytes(8).toString('hex')}`);
        mkdirSafe(dataDir, result.backupDir);
      }
      safe(dataDir, result.backupDir);
      const temporary = path.join(result.backupDir, `manifest-${randomBytes(8).toString('hex')}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, path.join(result.backupDir, 'manifest.json'));
    };
    const outcome = (entry: Record<string, unknown>, state: string, reason?: string) => {
      entry.outcome = state;
      if (reason) entry.reason = reason;
      try { save(); } catch (error) {
        // If a final manifest write fails, its pre-operation 'pending' record prevents automatic
        // emptying. The backed-up data stays recoverable, and the API still reports what happened.
        console.error('[storage-cleanup] Could not record backup outcome.', error);
      }
    };
    for (const id of new Set(ids)) {
      const item = available.get(id);
      if (!item) {
        result.skipped.push({ id, reason: protectedIds.get(id) ?? 'No longer eligible or no longer exists; refresh the cleanup list.' });
        continue;
      }
      let entry: Record<string, unknown> | undefined;
      let persisted = false;
      try {
        await eligible(item, deps);
        let measured = bytes(item.absolute, item.kind === 'build-output');
        if (item.kind === 'worktree') {
          const state = await worktreeState(item, deps);
          let backupRef = `refs/heads/backup/${state.branch}`;
          const existing = await gitRun(state.repoRoot, ['show-ref', '--verify', '--hash', backupRef]);
          if (existing.ok && existing.stdout.trim() !== state.head) backupRef += `-storage-cleanup-${randomBytes(8).toString('hex')}`;
          // CAS: never replace an earlier backup, even if another process races this request.
          await git(state.repoRoot, ['update-ref', backupRef, state.head, existing.ok && existing.stdout.trim() === state.head ? state.head : '0'.repeat(state.head.length)]);
          entry = { id, kind: item.kind, relPath: item.relPath, bytes: measured, ...state, backupRef, outcome: 'pending' };
          manifest.items.push(entry);
          save();
          persisted = true;
          const afterBackup = await worktreeState(item, deps);
          if (afterBackup.head !== state.head) throw new Error('The worktree HEAD changed during backup.');
          measured = bytes(item.absolute);
          await checkBeforeRemoval(item, deps);
          if (identity(dataDir, item.absolute, item.agentId!, item.kind) !== item.id) throw new Error('The worktree directory was replaced.');
          // No --force: Git remains the last check on changes or a locked worktree.
          await git(state.repoRoot, ['worktree', 'remove', item.absolute]);
          result.freedBytes += measured;
        } else {
          entry = { id, kind: item.kind, relPath: item.relPath, bytes: measured, outcome: 'pending' };
          manifest.items.push(entry);
          save();
          persisted = true;
          const destination = path.join(result.backupDir!, item.relPath);
          mkdirSafe(dataDir, path.dirname(destination));
          await eligible(item, deps);
          measured = bytes(item.absolute, true);
          manifest.items[manifest.items.length - 1].bytes = measured;
          save();
          await checkBeforeRemoval(item, deps);
          const checked = safe(dataDir, item.absolute);
          if (identity(dataDir, item.absolute, item.agentId!, item.kind) !== item.id) throw new Error('The output directory was replaced.');
          fs.renameSync(item.absolute, destination); // same volume only; no copy/delete fallback
          try {
            const moved = safe(dataDir, destination);
            if (!moved.isDirectory() || moved.dev !== checked.dev || moved.ino !== checked.ino) throw new Error('The directory changed during the move.');
          } catch {
            // Another local process can race a rename. Restore only through checked parents and
            // never overwrite something that appeared at the original name in the meantime.
            try {
              safe(dataDir, path.dirname(destination));
              safe(dataDir, path.dirname(item.absolute));
              let exists = false;
              try { fs.lstatSync(item.absolute); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
              if (exists) throw new Error('The original name is occupied.');
              fs.renameSync(destination, item.absolute);
            } catch {
              entry.outcome = 'quarantined';
              throw new Error('Directory identity changed; retained in the backup for manual inspection.');
            }
            throw new Error('Directory identity changed; the move was rolled back.');
          }
        }
        result.removed.push({ id, bytes: measured });
        entry.bytes = measured;
        outcome(entry, item.kind === 'worktree' ? 'removed' : 'moved');
      } catch (error) {
        const reason = (error as Error).message;
        if (entry && persisted) outcome(entry, entry.outcome === 'quarantined' ? 'quarantined' : 'skipped', reason);
        result.skipped.push({ id, reason });
      }
    }
    return result;
  });
}

/** Only storage-cleanup backups are disposable here. Other backups and Git refs stay intact. */
export async function emptyStorageBackups(deps: StorageCleanupDeps): Promise<{ freedBytes: number }> {
  deps = canonicalDeps(deps);
  return exclusive(deps, async () => {
    const dataDir = path.resolve(deps.dataDir);
    const backupRoot = path.join(dataDir, 'backups');
    if (!directory(dataDir, backupRoot)) return { freedBytes: 0 };
    let freedBytes = 0;
    for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
      const file = path.join(backupRoot, entry.name);
      if (!BACKUP.test(entry.name) || !entry.isDirectory() || !directory(dataDir, file) || !regular(dataDir, path.join(file, 'manifest.json'))) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(file, 'manifest.json'), 'utf8'));
        if (manifest.version !== 1 || manifest.kind !== 'podcode-storage-cleanup' || !Array.isArray(manifest.items)) continue;
        if (manifest.items.some((item: { outcome?: string } | null) => !item || item.outcome === 'pending' || item.outcome === 'quarantined')) continue;
        if ([...deps.projects()].some(project => project.path === file || within(project.path, file) || within(file, project.path))) continue;
        const measured = bytes(file);
        safe(dataDir, file);
        fs.rmSync(file, { recursive: true }); // child symlinks are unlinked, never traversed
        freedBytes += measured;
      } catch { /* Leave unreadable, malformed or changing backups for the user to inspect. */ }
    }
    return { freedBytes };
  });
}
