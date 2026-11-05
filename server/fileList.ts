import fs from 'node:fs';
import path from 'node:path';
import type { ProjectFileList } from '../shared/composer.ts';
import { gitRun, isInsideGitRepo } from './projects.ts';

/** The most files the `@` picker indexes; past this the listing says it was cut short. */
export const MAX_LISTED_FILES = 20_000;
const MAX_DEPTH = 12;
/** Folders a walk skips when the workspace is not a git repository. */
const SKIPPED = new Set(['.git', 'node_modules', '.DS_Store', 'dist', 'build', 'out', '.next', 'target', '.turbo', '.cache', '__pycache__', '.venv', 'venv']);

/** A path an `@` token can carry: no whitespace, which would end the token. */
function mentionable(relative: string): boolean {
  return relative.length > 0 && !/\s/.test(relative);
}

function capped(files: string[]): ProjectFileList {
  const usable = files.filter(mentionable);
  return { files: usable.slice(0, MAX_LISTED_FILES), truncated: usable.length > MAX_LISTED_FILES };
}

function walk(root: string): ProjectFileList {
  const files: string[] = [];
  const visit = (dir: string, rel: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !visit(path.join(dir, entry.name), child, depth + 1)) return false;
      } else if (entry.isFile()) {
        files.push(child);
        // One past the cap tells the caller the listing was cut short.
        if (files.length > MAX_LISTED_FILES) return false;
      }
    }
    return true;
  };
  visit(root, '', 0);
  return capped(files);
}

/**
 * Every file under `root`, relative to it, for the composer's `@` picker. In a git repository this
 * is git's view (tracked plus untracked, ignored files left out); elsewhere a walk that skips
 * dependency and build folders.
 */
export async function listProjectFiles(root: string): Promise<ProjectFileList> {
  if (isInsideGitRepo(root)) {
    const result = await gitRun(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (result.ok) {
      const unique = [...new Set(result.stdout.split('\0').filter(Boolean))];
      return capped(unique);
    }
  }
  return walk(root);
}
