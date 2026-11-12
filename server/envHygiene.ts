// Settings the app and its agents must never carry on to the processes they start.
//
// scripts/restart-desktop.sh and install.sh take PODCODE_* (or the older AGENTSCODE_*) overrides
// for real paths: the app to replace, where to keep the previous one, the build to install. If
// the app is ever started with them set (a restart run, a shell that exported them), every agent,
// terminal and test run it starts would inherit them, and a script run there would act on those
// real paths (ACH-N8: a test run deleted a kept copy of the previous app that way, 2026-11-12).
// The app's own settings (PODCODE_HOME, PODCODE_NODE, PODCODE_DISABLE_UPDATES, and the comms
// MCP's TOKEN, TOOLS_URL, EXECUTIVE, EYES) are not on this list.

/** The overrides restart-desktop.sh and install.sh read, by their name after the prefix. */
export const SCRIPT_OVERRIDES = ['APP', 'PREV', 'NEW_BUILD', 'PORT', 'LOCK', 'LEGACY_LOCK', 'TICK', 'INSTALL_DIR', 'VERSION', 'NO_OPEN'] as const;

/** Every environment name to drop: each override under both prefixes. */
export const SCRIPT_OVERRIDE_NAMES: readonly string[] = SCRIPT_OVERRIDES.flatMap(name => [`PODCODE_${name}`, `AGENTSCODE_${name}`]);

/** A copy of `env` without the script overrides. */
export function withoutScriptOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of SCRIPT_OVERRIDE_NAMES) delete out[name];
  return out;
}

/** Drop the script overrides from this process's own environment, so nothing it starts inherits them. Returns the names removed. */
export function scrubScriptOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = SCRIPT_OVERRIDE_NAMES.filter(name => name in env);
  for (const name of removed) delete env[name];
  return removed;
}

// ---- git: a command run in a folder acts on that folder's repository ---------------------------

/**
 * git reads these ahead of the folder it runs in; a git hook (pre-commit, pre-push) sets them to the
 * repository being committed. The app runs git in a project's or agent's folder and means that one,
 * so none of its git commands may inherit them, and nor may a test run started from a hook.
 */
export const GIT_REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] as const;

/** A copy of `env` without the settings that point git at a particular repository. */
export function withoutGitRepoEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of GIT_REPO_ENV) delete out[name];
  return out;
}

/** The environment for a git command, built when it runs: this process's, without those settings, plus `extra`. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...withoutGitRepoEnv(process.env), ...extra };
}
