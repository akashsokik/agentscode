// Loaded before every test file (`node --import ./tests/isolate.ts --test`, package.json), and
// imported first by tests/helpers.ts for a file run on its own: keep a test run from acting on a
// real repository. git reads GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_COMMON_DIR ahead of the
// folder it runs in, and a git hook that runs npm test sets them to the repository being committed.
// They are dropped from this process here, so nothing started from it inherits them; the app's own
// git runners also drop them per call (server/envHygiene.ts).
import { GIT_REPO_ENV, gitEnv, withoutGitRepoEnv } from '../server/envHygiene.ts';

export { GIT_REPO_ENV, gitEnv, withoutGitRepoEnv };

for (const name of GIT_REPO_ENV) delete process.env[name];
