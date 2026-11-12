// Imported first by tests/helpers.ts (and by any test that runs git without it): keep a test run
// from acting on a real repository. git reads GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and
// GIT_COMMON_DIR from the environment ahead of the folder it runs in, and a git hook (pre-commit,
// pre-push) that runs npm test sets them to the repository being committed. Then every `git init`,
// `git add` or `git worktree add` a test (or the code it tests) runs would land in that repository.
// They are dropped from this process at import, so nothing started from it inherits them.

export const GIT_REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const;

/** A copy of `env` without the settings that point git at a particular repository. */
export function withoutGitRepoEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_REPO_ENV) delete out[name];
  return out;
}

/** The environment for a test's own git commands: this process's, without those settings. */
export function gitEnv(): NodeJS.ProcessEnv {
  return withoutGitRepoEnv(process.env);
}

for (const name of GIT_REPO_ENV) delete process.env[name];
