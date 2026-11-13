import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The force-push rule (ALL-D9), enforced where git runs, not in task text: every agent process
 * gets core.hooksPath pointed at PodCode's own hooks folder (through GIT_CONFIG_COUNT, so your
 * own git use is untouched). Its pre-push refuses a push that would overwrite or delete what the
 * remote already has (a non-fast-forward, a deleted branch or tag, --mirror or --prune deletions),
 * unless the push carries a one-time token from a force_push you approved. Every other hook, and
 * pre-push after the check, runs the repository's own (its core.hooksPath, or .git/hooks).
 */

export const PUSH_GUARD_MARK = '# PodCode push guard (ALL-D9)';
const CLIENT_HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'reference-transaction', 'push-to-checkout', 'post-index-change', 'pre-push',
];

/** The repository's own hooks folder, as the repository would use it without PodCode. */
const ORIGINAL_HOOKS = `orig_dir=$(git config --local --get core.hooksPath 2>/dev/null)
if [ -z "$orig_dir" ]; then orig_dir="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"
else case "$orig_dir" in /*) ;; *) orig_dir="$(git rev-parse --show-toplevel 2>/dev/null)/$orig_dir";; esac
fi
self_dir="$(cd "$(dirname "$0")" && pwd)"
[ "$(cd "$orig_dir" 2>/dev/null && pwd)" = "$self_dir" ] && orig_dir=""`;

const PROXY = `#!/bin/sh
${PUSH_GUARD_MARK}: runs the repository's own hook.
${ORIGINAL_HOOKS}
name=$(basename "$0")
if [ -n "$orig_dir" ] && [ -x "$orig_dir/$name" ]; then exec "$orig_dir/$name" "$@"; fi
exit 0
`;

const PRE_PUSH = `#!/bin/sh
${PUSH_GUARD_MARK}: refuses pushes that overwrite or delete what the remote has.
${ORIGINAL_HOOKS}
input=$(cat)
bad=""
while read lref lsha rref rsha; do
  [ -z "$rref" ] && continue
  case "$rsha" in *[!0]*) existing=1;; *) existing=0;; esac
  case "$lsha" in *[!0]*) deleting=0;; *) deleting=1;; esac
  [ "$existing" = 1 ] || continue
  if [ "$deleting" = 1 ]; then bad="$bad $rref(delete)"; continue; fi
  if ! git cat-file -e "$rsha^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$rsha" "$lsha" 2>/dev/null; then
    bad="$bad $rref(overwrite)"
  fi
done <<PODCODE_EOF
$input
PODCODE_EOF
# git does not list --mirror and --prune deletions here, so read the push's own command line.
parent=$(ps -o args= -p "$PPID" 2>/dev/null)
case " $parent " in *" --mirror "*|*" --prune "*|*" --mirror="*) bad="$bad (--mirror/--prune can delete remote branches)";; esac
if [ -n "$bad" ]; then
  token="$PODCODE_PUSH_OVERRIDE"
  case "$token" in ''|*[!a-z0-9]*) token="";; esac
  if [ -n "$token" ] && [ -f "$self_dir/overrides/$token" ]; then
    rm -f "$self_dir/overrides/$token"
    echo "PodCode: the force-push you approved, once:$bad" >&2
  else
    echo "PodCode refused this push: it would overwrite or delete what $1 already has:$bad" >&2
    echo "Force-pushes and deletes of pushed history need the user's approval (take_action force_push). Push a new commit (a revert) instead." >&2
    exit 1
  fi
fi
if [ -n "$orig_dir" ] && [ -x "$orig_dir/pre-push" ]; then printf '%s\\n' "$input" | "$orig_dir/pre-push" "$@" || exit $?; fi
exit 0
`;

let guardDir: string | null = null;

/** Write (or rewrite) PodCode's hooks folder; called at startup, and again if a file was changed. */
export function installPushGuard(dir: string): string {
  fs.mkdirSync(path.join(dir, 'overrides'), { recursive: true });
  for (const name of CLIENT_HOOKS) {
    const file = path.join(dir, name);
    const body = name === 'pre-push' ? PRE_PUSH : PROXY;
    let current: string | null = null;
    try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
    if (current !== body) fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
  guardDir = dir;
  return dir;
}

/** The folder the agents' git uses for hooks, once installed. */
export function pushGuardDir(): string | null {
  return guardDir;
}

/**
 * The environment an agent process runs with: git there uses PodCode's hooks folder. Added to any
 * GIT_CONFIG_COUNT already set, never replacing it.
 */
export function pushGuardEnv(env: NodeJS.ProcessEnv = process.env, dir = guardDir): NodeJS.ProcessEnv {
  if (!dir) return { ...env };
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  return { ...env, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${count}`]: dir };
}

/** One push the user approved (take_action force_push): a token the agent passes as PODCODE_PUSH_OVERRIDE, used once. */
export function issueOverride(dir = guardDir): string {
  if (!dir) throw new Error('The push guard is not installed.');
  const token = randomBytes(12).toString('hex');
  fs.mkdirSync(path.join(dir, 'overrides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'overrides', token), `${new Date().toISOString()}\n`);
  return token;
}

/**
 * Shell commands that would turn the guard off: skipping hooks on a push, or pointing git's hooks
 * or config elsewhere. Agents' Bash calls with these are refused (Claude), and logged.
 */
export function disablesPushGuard(command: string): string | null {
  const text = command.replace(/\\\n/g, ' ');
  if (/\bpush\b[^\n;|&]*\s--no-verify\b|\s--no-verify\b[^\n;|&]*\bpush\b/.test(text)) return 'git push --no-verify skips the push check';
  if (/core\.hooksPath/i.test(text)) return 'changing core.hooksPath turns the push check off';
  if (/\bGIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|NOSYSTEM)\b/.test(text)) return 'changing GIT_CONFIG_* turns the push check off';
  if (/\benv\s+(-[a-zA-Z]*i\b|--ignore-environment\b)/.test(text)) return 'env -i drops the push check';
  if (/PODCODE_PUSH_OVERRIDE=/.test(text) && !/PODCODE_PUSH_OVERRIDE=[a-f0-9]{24}\b/.test(text)) return 'a made-up push override';
  return null;
}
