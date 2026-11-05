import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirListing } from '../shared/types.ts';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function normalizeDir(input: string): string {
  return path.resolve(expandHome(input.trim()));
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Package.swift', 'Gemfile', 'pom.xml'];

/** Folders under a directory, for the add-project picker. */
export function listDirs(input: string, showHidden: boolean): DirListing {
  const dir = normalizeDir(input || os.homedir());
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && (showHidden || !e.name.startsWith('.')))
    .map((e) => path.join(dir, e.name))
    .filter(isDirectory)
    .map((full) => ({
      name: path.basename(full),
      path: full,
      isProject: PROJECT_MARKERS.some((m) => fs.existsSync(path.join(full, m))),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs };
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function gitRun(cwd: string, args: string[], timeout = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Walk up from a folder looking for a .git entry (a directory, or a file in worktrees). */
export function isInsideGitRepo(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** `git status --porcelain=v1 -z` entries. Renames carry the new path. */
export function parsePorcelainZ(stdout: string): { status: string; path: string }[] {
  const parts = stdout.split('\0');
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;
    const status = item.slice(0, 2).trim() || '?';
    files.push({ status, path: item.slice(3) });
    if (item[0] === 'R' || item[0] === 'C') i++; // skip the original path
  }
  return files;
}
