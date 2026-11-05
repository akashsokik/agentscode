import fs from 'node:fs';
import path from 'node:path';
import type { ChangedFile, FileContent, FileDiff, GitStatus, TreeListing } from '../shared/types.ts';
import { HttpError } from './errors.ts';
import { gitRun, parsePorcelainZ } from './projects.ts';

const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'build', '.next', 'target', '.turbo', '.cache', '__pycache__', '.venv']);
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS = 400_000;

/**
 * Resolve a path the browser sent against a root folder. The real path must stay inside
 * the root, so `..` segments and symlinks cannot reach other parts of the disk.
 */
export function resolveInside(root: string, rel: string): string {
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel || '.');
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw new HttpError(404, 'That file no longer exists.');
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new HttpError(403, 'That path is outside the workspace.');
  return real;
}

function relativeTo(root: string, full: string): string {
  return path.relative(fs.realpathSync(root), full).split(path.sep).join('/');
}

export function listTree(root: string, rel: string): TreeListing {
  const dir = resolveInside(root, rel);
  if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, 'That path is not a folder.');
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !HIDDEN.has(e.name))
    .slice(0, MAX_ENTRIES)
    .map(e => {
      const full = path.join(dir, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; }
      }
      return { name: e.name, path: relativeTo(root, full), dir: isDir };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { root, path: relativeTo(root, dir), entries };
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

export function readFile(root: string, rel: string): FileContent {
  const full = resolveInside(root, rel);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new HttpError(400, 'That path is not a file.');
  const fd = fs.openSync(full, 'r');
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    const binary = looksBinary(buffer);
    return {
      path: relativeTo(root, full),
      size: stat.size,
      binary,
      truncated: stat.size > MAX_FILE_BYTES,
      text: binary ? '' : buffer.toString('utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>();
  for (const line of stdout.split('\n')) {
    const [added, removed, ...rest] = line.split('\t');
    if (!rest.length) continue;
    // Renames print as "old => new" or "dir/{old => new}"; key by the new path.
    const file = rest.join('\t').replace(/\{[^{}]* => ([^{}]*)\}/, '$1').replace(/^.* => /, '');
    stats.set(file, { added: Number(added) || 0, removed: Number(removed) || 0 });
  }
  return stats;
}

function countLines(full: string): number {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return 0;
    const text = fs.readFileSync(full, 'utf8');
    if (text.includes('\0')) return 0;
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

/** Working-tree changes against HEAD, with line counts, for the Changes panel. */
export async function gitStatus(root: string, baseCommit?: string): Promise<GitStatus> {
  const inside = await gitRun(root, ['rev-parse', '--show-toplevel'], 10_000);
  if (!inside.ok) return { root, isRepo: false, branch: null, files: [], added: 0, removed: 0, commits: null };
  const top = inside.stdout.trim();
  const [branch, status, numstat, commits] = await Promise.all([
    gitRun(root, ['branch', '--show-current'], 10_000),
    gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], 20_000),
    gitRun(root, ['-c', 'core.quotePath=false', 'diff', 'HEAD', '--numstat', '--', '.'], 20_000),
    baseCommit ? gitRun(root, ['rev-list', '--count', `${baseCommit}..HEAD`], 10_000) : Promise.resolve(null),
  ]);
  const stats = parseNumstat(numstat.stdout);
  const prefix = path.relative(fs.realpathSync(top), fs.realpathSync(root)).split(path.sep).join('/');
  const files: ChangedFile[] = parsePorcelainZ(status.stdout).slice(0, 500).map(f => {
    // Porcelain paths are relative to the repo top; show them relative to the agent's folder.
    const rel = prefix && f.path.startsWith(`${prefix}/`) ? f.path.slice(prefix.length + 1) : f.path;
    const counted = stats.get(f.path);
    const added = counted?.added ?? (f.status === '??' ? countLines(path.join(top, f.path)) : 0);
    return { path: rel, status: f.status, added, removed: counted?.removed ?? 0 };
  });
  return {
    root,
    isRepo: true,
    branch: branch.stdout.trim() || null,
    files,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0),
    commits: commits ? Number(commits.stdout.trim()) || 0 : null,
  };
}

/** Unified diff of one file against HEAD. Untracked files show as fully added. */
export async function gitDiff(root: string, rel: string): Promise<FileDiff> {
  if (!rel || rel.includes('\0')) throw new HttpError(400, 'Choose a file.');
  const full = path.resolve(fs.realpathSync(root), rel);
  const realRoot = fs.realpathSync(root);
  if (full !== realRoot && !full.startsWith(realRoot + path.sep)) throw new HttpError(403, 'That path is outside the workspace.');
  const status = await gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rel], 10_000);
  const code = parsePorcelainZ(status.stdout)[0]?.status ?? '';
  let diff: string;
  if (code === '??') {
    const result = await gitRun(root, ['diff', '--no-index', '--', '/dev/null', rel], 20_000);
    diff = result.stdout; // exits 1 when the files differ, which they always do here
  } else {
    const result = await gitRun(root, ['diff', 'HEAD', '--', rel], 20_000);
    if (!result.ok) throw new HttpError(400, result.stderr.trim() || 'Could not diff that file.');
    diff = result.stdout;
  }
  if (diff.length > MAX_DIFF_CHARS) diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)`;
  return { path: rel, status: code, diff };
}
