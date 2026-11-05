import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Worktree } from '../shared/types.ts';
import { clip } from './agents/describe.ts';
import { HttpError } from './errors.ts';
import { gitRun, isDirectory } from './projects.ts';

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'agent'
  );
}

function gitError(result: { stderr: string; stdout: string }): string {
  return clip((result.stderr || result.stdout).replace(/^(fatal|error):\s*/gm, ''), 300);
}

/**
 * Create a worktree on a new branch from the project's current commit. It lives
 * under the data folder so the project checkout itself stays untouched.
 */
export async function createWorktree(projectPath: string, agentName: string, requestedBranch: string | undefined, worktreesDir: string): Promise<Worktree> {
  const top = await gitRun(projectPath, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new HttpError(400, 'This project is not a git repository, so the agent cannot get its own worktree.');
  const repoRoot = top.stdout.trim();

  const head = await gitRun(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok) throw new HttpError(400, 'The repository has no commits yet. Make a first commit, then try again.');
  const baseCommit = head.stdout.trim();
  const current = (await gitRun(repoRoot, ['branch', '--show-current'])).stdout.trim();
  const base = current || baseCommit.slice(0, 8);
  const common = await gitRun(repoRoot, ['rev-parse', '--git-common-dir']);
  const gitDir = path.resolve(repoRoot, common.stdout.trim());

  const branch = (requestedBranch ?? '').trim() || `agent/${slug(agentName)}-${randomBytes(2).toString('hex')}`;
  if (!(await gitRun(repoRoot, ['check-ref-format', '--branch', branch])).ok) {
    throw new HttpError(400, `"${branch}" is not a valid branch name.`);
  }
  if ((await gitRun(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok) {
    throw new HttpError(409, `Branch ${branch} already exists. Pick another name.`);
  }

  const repoKey = `${slug(path.basename(repoRoot))}-${createHash('sha1').update(repoRoot).digest('hex').slice(0, 6)}`;
  const dir = path.join(worktreesDir, repoKey, branch.replace(/[^\w.-]+/g, '-'));
  if (fs.existsSync(dir)) throw new HttpError(409, `${dir} already exists. Pick another branch name.`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = await gitRun(repoRoot, ['worktree', 'add', '-b', branch, dir, baseCommit], 120_000);
  if (!add.ok) throw new HttpError(400, `Could not create the worktree: ${gitError(add)}`);

  // If the project is a subfolder of the repo, work in the same subfolder of the worktree.
  const rel = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(projectPath));
  const cwd = rel && !rel.startsWith('..') ? path.join(dir, rel) : dir;
  fs.mkdirSync(cwd, { recursive: true });

  return { path: dir, cwd, branch, base, baseCommit, repoRoot, gitDir };
}

/** Remove the worktree folder. The branch is always kept. Without `force`, git refuses if there are uncommitted changes. */
export async function removeWorktree(worktree: Worktree, force: boolean): Promise<void> {
  if (!isDirectory(worktree.path)) {
    await gitRun(worktree.repoRoot, ['worktree', 'prune']);
    return;
  }
  const result = await gitRun(worktree.repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree.path], 120_000);
  if (!result.ok) throw new HttpError(409, `Could not remove the worktree: ${gitError(result)}`);
}
