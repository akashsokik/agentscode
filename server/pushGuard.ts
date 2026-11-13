import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The force-push rule (ALL-D9), enforced where git runs, not in task text. Every agent process
 * finds PodCode's \`git\` first on its PATH (a small sh shim; your own shell and terminals are
 * untouched). For a push, the shim runs the real git with core.hooksPath set to PodCode's hooks
 * folder, whose pre-push refuses a push that would overwrite or delete what the remote already
 * has (a non-fast-forward, a deleted branch or tag, --mirror or --prune deletions) unless the push
 * carries a one-time token from a force_push you approved, which PodCode checks in memory. The
 * shim also refuses the ways around that check (--no-verify, another core.hooksPath, send-pack).
 * Every other command goes straight to the real git, so its hooks are the repository's own.
 *
 * What it is: a check on agents' ordinary git use, and tamper-evident (changed files are put back
 * and logged). What it is not: a lock. A process that calls another git by its full path, or
 * moves a branch through the GitHub API, is not seen here; GitHub's branch protection is that
 * (ALL-D12).
 */

export const PUSH_GUARD_MARK = '# PodCode push guard (ALL-D9)';
const CLIENT_HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'reference-transaction', 'push-to-checkout', 'post-index-change', 'pre-push',
  // A push to a local remote runs its hooks with the same setting, so they are passed on too.
  'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
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

/** Where the agent's push asks PodCode about a token; written into the hook at install. */
const PRE_PUSH = (url: string) => `#!/bin/sh
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
  case "$token" in ''|*[!a-f0-9]*) token="";; esac
  url='${url}'
  # A token is good only if PodCode issued it for this push and it is unused: PodCode keeps it in
  # memory and answers once (a file here could be written by anyone, so none is trusted).
  code=""
  if [ -n "$token" ] && [ -n "$url" ]; then
    refs=$(printf '%s' "$bad" | tr -d '"\\\\')
    remote=$(printf '%s' "$2" | tr -d '"\\\\')
    answer=$(curl -s -m 5 -w '\\n%{http_code}' -H 'content-type: application/json' --data "{\\"token\\":\\"$token\\",\\"refs\\":\\"$refs\\",\\"remote\\":\\"$remote\\"}" "$url/api/push-guard/redeem" 2>/dev/null)
    code=$(printf '%s' "$answer" | tail -n 1)
    why=$(printf '%s' "$answer" | sed -n 's/.*"why":"\\([^"]*\\)".*/\\1/p' | head -n 1)
    [ -n "$why" ] && echo "PodCode did not take the token: $why." >&2
  fi
  if [ "$code" = 200 ]; then
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

/** dash starts in about half the time of macOS's sh (bash), and the shim runs on every git call. */
const SHIM_SHELL = fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh';

const HOOKS_PATH = '*[hH][oO][oO][kK][sS][pP][aA][tT][hH]*';
/** git's own commands (not aliases), which run as they are, with no check and no extra git call. */
const BUILTINS = 'add|am|annotate|apply|archive|bisect|blame|branch|bundle|cat-file|check-attr|check-ignore|check-mailmap|check-ref-format|checkout|checkout-index|cherry|cherry-pick|citool|clean|clone|column|commit|commit-graph|commit-tree|config|count-objects|credential|credential-cache|credential-osxkeychain|credential-store|describe|diff|diff-files|diff-index|diff-tree|difftool|fast-export|fast-import|fetch|fetch-pack|for-each-ref|for-each-repo|format-patch|fsck|gc|get-tar-commit-id|grep|gui|hash-object|help|hook|index-pack|init|instaweb|interpret-trailers|log|ls-files|ls-remote|ls-tree|lfs|mailinfo|mailsplit|maintenance|merge|merge-base|merge-file|merge-index|merge-tree|mergetool|mktag|mktree|multi-pack-index|mv|name-rev|notes|pack-objects|pack-redundant|pack-refs|patch-id|prune|prune-packed|pull|range-diff|read-tree|rebase|receive-pack|reflog|remote|repack|replace|rerere|reset|restore|rev-list|rev-parse|revert|rm|shortlog|show|show-branch|show-index|show-ref|sparse-checkout|stage|stash|status|stripspace|submodule|switch|symbolic-ref|tag|unpack-file|unpack-objects|update-index|update-ref|update-server-info|upload-archive|upload-pack|var|verify-commit|verify-pack|verify-tag|version|whatchanged|worktree|write-tree';

/**
 * The \`git\` agents run (first on their PATH, see pushGuardEnv). Every command but a push goes
 * straight to the real git, with no extra git call, so commits cost one sh hop and the
 * repository's own hooks run as usual. A push runs with PodCode's hooks folder, and the ways
 * around it are refused: --no-verify, pointing core.hooksPath elsewhere, and send-pack. An alias
 * is looked up (one git call) to see what it stands for. The pre-push file is checked against
 * the one PodCode wrote before every push; a changed one is put back by PodCode first.
 */
const SHIM = (realGit: string, dir: string, url: string, prePushSum: string) => `#!${SHIM_SHELL}
${PUSH_GUARD_MARK}: the git agents run.
real='${realGit}'
hooks='${dir}'
url='${url}'
no() {
  echo "PodCode refused this git command: $1." >&2
  echo "Pushes that overwrite or delete pushed history need the user's approval (take_action force_push). Push a new commit (a revert) instead." >&2
  exit 1
}
# A -c or --config-env that points core.hooksPath elsewhere matters only to a push: a push drops
# it below and runs with PodCode's hooks folder all the same. One that defines an alias or
# includes config is refused for a push or an alias (it could re-point the hooks after ours).
# init, commit, config and the rest run with any of them as usual (test fixtures do that).
sub=""; want=""; at=0; flagged=""; hookset=""
for a in "$@"; do
  at=$((at + 1))
  if [ -n "$want" ]; then
    case "$want$a" in
      c${HOOKS_PATH}) hookset=1;;
      c[aA][lL][iI][aA][sS].*) flagged='define aliases in git config, not with -c, so PodCode can see what they run';;
      c[iI][nN][cC][lL][uU][dD][eE]*) flagged='include config with git config, not with -c';;
    esac
    want=""; continue
  fi
  case "$a" in
    -c|--config-env) want=c;;
    -C|--git-dir|--work-tree|--namespace|--super-prefix|--attr-source|--list-cmds) want=x;;
    ${HOOKS_PATH}) hookset=1;;
    -*) ;;
    *) sub="$a"; break;;
  esac
done
case "$sub" in
  push) [ -n "$flagged" ] && no "$flagged";;
  send-pack|http-push) no "git $sub writes to a remote without the push check";;
  ''|${BUILTINS}) exec "$real" "$@";;
  *)
    [ -n "$flagged" ] && no "$flagged"
    # An alias, followed through aliases of aliases (at most 5), so a=b, b=push --no-verify is seen.
    name="$sub"; alias=""; depth=0
    while next=$("$real" config --get "alias.$name" 2>/dev/null); do
      alias="$alias $next"; depth=$((depth + 1))
      [ "$depth" -ge 5 ] && no "the alias $sub nests too deep for PodCode to see what it runs"
      case "$next" in '!'*) break;; esac
      name=\${next%% *}
      case "$name" in ${BUILTINS}|push|send-pack|http-push) break;; esac
    done
    [ -z "$alias" ] && exec "$real" "$@"
    case "$alias" in
      *send-pack*|*http-push*) no "the alias $sub writes to a remote without the push check";;
      ${HOOKS_PATH}) no "the alias $sub points core.hooksPath elsewhere";;
    esac
    case "$alias" in
      ' !'*) exec "$real" "$@";;
      *push*) case "$alias" in *--no-v*) no "the alias $sub skips the push check (--no-verify)";; esac;;
      *) exec "$real" "$@";;
    esac;;
esac
# A push: what it asks for, and then the push check, which runs before anything is sent.
n=0
for a in "$@"; do
  n=$((n + 1)); [ "$n" -le "$at" ] && continue
  case "$a" in
    --) break;;
    --no-v*) no 'git push --no-verify skips the push check';;
    --mi|--mir|--mirr|--mirro|--pru|--prun) no "spell out $a in full, so the push check sees it";;
  esac
done
if [ "$(cksum < "$hooks/pre-push" 2>/dev/null)" != '${prePushSum}' ]; then
  [ -n "$url" ] && curl -s -m 5 -o /dev/null -X POST "$url/api/push-guard/check" 2>/dev/null
  [ "$(cksum < "$hooks/pre-push" 2>/dev/null)" = '${prePushSum}' ] || no 'its push check was changed, and PodCode could not put it back'
fi
if [ -n "$hookset" ]; then
  i=0; total=$#; drop=""
  while [ "$i" -lt "$total" ]; do
    a=$1; shift; i=$((i + 1))
    if [ -n "$drop" ]; then drop=""; continue; fi
    if [ "$i" -lt "$at" ]; then
      case "$a" in
        -c|--config-env) case "$1" in ${HOOKS_PATH}) drop=1; continue;; esac;;
        ${HOOKS_PATH}) continue;;
      esac
    fi
    set -- "$@" "$a"
  done
fi
exec "$real" -c "core.hooksPath=$hooks" "$@"
`;

/** For bash (BASH_ENV): the shim first on PATH again, after a login profile ran. */
const ENV_SH = (bin: string) => `${PUSH_GUARD_MARK}: keeps PodCode's git first on PATH.
if [ -n "\${PODCODE_USER_BASH_ENV:-}" ] && [ -f "$PODCODE_USER_BASH_ENV" ] && ! grep -q 'PodCode push guard' "$PODCODE_USER_BASH_ENV" 2>/dev/null; then . "$PODCODE_USER_BASH_ENV"; fi
case "$PATH" in '${bin}:'*) ;; *) PATH='${bin}':"$PATH"; export PATH;; esac
`;

/** For zsh (ZDOTDIR): the user's own startup file, then the shim first on PATH again. */
const ZSH_FILE = (name: string, zdot: string, bin: string) => `${PUSH_GUARD_MARK}: runs your own ${name}, then keeps PodCode's git first on PATH.
ZDOTDIR="\${PODCODE_USER_ZDOTDIR:-$HOME}"
if [ -f "$ZDOTDIR/${name}" ]; then . "$ZDOTDIR/${name}"; fi
ZDOTDIR='${zdot}'
case "$PATH" in '${bin}:'*) ;; *) PATH='${bin}':"$PATH"; export PATH;; esac
`;

/** The first git on PATH that is not PodCode's own. */
function findRealGit(dir: string): string {
  const own = path.join(dir, 'bin');
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!entry || path.resolve(entry) === own) continue;
    const candidate = path.join(entry, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile() && !isShim(candidate)) return candidate;
    } catch { /* next */ }
  }
  return '/usr/bin/git';
}

/**
 * Whether a git on PATH is a PodCode shim itself (another PodCode's, say the running app's when
 * this server runs in an agent's shell): calling it would wrap one shim in another, and it would
 * refuse this one's own hooks setting on every push.
 */
function isShim(file: string): boolean {
  return isGuardFile(file);
}

/** Whether a file is one PodCode's push guard wrote (its first lines carry the mark). */
function isGuardFile(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(200);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, n).toString('utf8').includes(PUSH_GUARD_MARK);
  } catch {
    return false;
  } finally { if (fd !== null) fs.closeSync(fd); }
}

/** cksum's output for a text, as the shim compares it. */
function cksum(text: string): string {
  const out = spawnSync('cksum', { input: text, encoding: 'utf8' });
  return out.stdout.trim();
}

interface Installed { dir: string; url: string; realGit: string }
let installed: Installed | null = null;

/** Write one file if it is not what it should be; true when it was changed. */
function put(file: string, body: string, mode: number): boolean {
  let current: string | null = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
  const changed = current !== body;
  if (changed) fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return changed;
}

function writeAll(target: Installed): string[] {
  const { dir, url, realGit } = target;
  const changed: string[] = [];
  const bin = path.join(dir, 'bin');
  const zdot = path.join(dir, 'zsh');
  const envSh = path.join(dir, 'env.sh');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(zdot, { recursive: true });
  // One-time tokens used to be files here; none is trusted now (PodCode keeps them in memory).
  fs.rmSync(path.join(dir, 'overrides'), { recursive: true, force: true });
  const prePush = PRE_PUSH(url);
  for (const name of CLIENT_HOOKS) if (put(path.join(dir, name), name === 'pre-push' ? prePush : PROXY, 0o755)) changed.push(name);
  if (put(path.join(bin, 'git'), SHIM(realGit, dir, url, cksum(prePush)), 0o755)) changed.push('bin/git');
  if (put(envSh, ENV_SH(bin), 0o644)) changed.push('env.sh');
  for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) if (put(path.join(zdot, name), ZSH_FILE(name, zdot, bin), 0o644)) changed.push(`zsh/${name}`);
  return changed;
}

/**
 * Write (or rewrite) PodCode's push guard: the hooks folder, the git shim, and the shell startup
 * files that keep the shim first on PATH. Called at startup; \`url\` is where the pre-push asks
 * about an approved force-push's token (none: no token is ever accepted).
 */
export function installPushGuard(dir: string, options: { url?: string; realGit?: string } = {}): string {
  const target: Installed = { dir, url: options.url ?? '', realGit: options.realGit ?? findRealGit(dir) };
  writeAll(target);
  installed = target;
  return dir;
}

/**
 * Put back any guard file that was changed since it was written (an agent rewriting its pre-push,
 * say), and say which ones; run before each agent turn and when the shim sees a changed pre-push.
 */
export function ensurePushGuard(): string[] {
  if (!installed) return [];
  const changed = writeAll(installed);
  if (changed.length) console.warn(`[push-guard] put back files that were changed: ${changed.join(', ')}`);
  return changed;
}

/** The folder the agents' git uses for hooks, once installed. */
export function pushGuardDir(): string | null {
  return installed?.dir ?? null;
}

/**
 * The environment an agent process runs with: PodCode's git first on PATH, and kept first by
 * bash (BASH_ENV, which runs after a login profile) and zsh (ZDOTDIR, which Claude Code's and
 * Codex's shells start through), whose startup files would otherwise put another git ahead of it.
 * Not CLAUDE_ENV_FILE: Claude Code's SessionStart hooks write their own exports there.
 */
export function pushGuardEnv(env: NodeJS.ProcessEnv = process.env, dir = installed?.dir ?? null): NodeJS.ProcessEnv {
  if (!dir) return { ...env };
  const bin = path.join(dir, 'bin');
  const zdot = path.join(dir, 'zsh');
  const envSh = path.join(dir, 'env.sh');
  const rest = (env.PATH ?? '').split(path.delimiter).filter(p => p && p !== bin);
  const out: NodeJS.ProcessEnv = { ...env, PATH: [bin, ...rest].join(path.delimiter), BASH_ENV: envSh, ZDOTDIR: zdot };
  // The user's own startup files, to run first. Inside another PodCode's agent shell (a server
  // started there, or tests), BASH_ENV and ZDOTDIR are that PodCode's own: keep the user's they
  // already recorded rather than record PodCode's as the user's, which would source itself forever.
  const userBashEnv = env.BASH_ENV && env.BASH_ENV !== envSh && !isGuardFile(env.BASH_ENV) ? env.BASH_ENV : env.PODCODE_USER_BASH_ENV;
  const userZdot = env.ZDOTDIR && env.ZDOTDIR !== zdot && !isGuardFile(path.join(env.ZDOTDIR, '.zshenv')) ? env.ZDOTDIR : env.PODCODE_USER_ZDOTDIR;
  if (userBashEnv) out.PODCODE_USER_BASH_ENV = userBashEnv; else delete out.PODCODE_USER_BASH_ENV;
  if (userZdot) out.PODCODE_USER_ZDOTDIR = userZdot; else delete out.PODCODE_USER_ZDOTDIR;
  return out;
}

/** Force-pushes the user approved and not yet made: token, the branch and the remotes it is for. Memory only. */
const overrides = new Map<string, { branch: string; remotes: string[]; at: number }>();
const OVERRIDE_TTL = 6 * 60 * 60_000;

function gitOut(args: string[], cwd: string): Promise<string | null> {
  return new Promise(resolve => execFile('git', args, { cwd, timeout: 10_000 }, (error, stdout) => resolve(error ? null : String(stdout))));
}

/**
 * Where a push from the project goes: each remote's push URLs as git resolves them (pushurl,
 * insteadOf and pushInsteadOf applied, which is what the pre-push gets as $2), plus the raw
 * config values. Fixed read-only git calls.
 */
export async function pushRemotes(cwd: string): Promise<string[]> {
  const config = await gitOut(['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'], cwd);
  if (config === null) return [];
  const lines = config.split('\n').filter(Boolean);
  const raw = lines.map(line => line.split(' ').slice(1).join(' ').trim()).filter(Boolean);
  const names = [...new Set(lines.map(line => /^remote\.(.+)\.(url|pushurl) /.exec(line)?.[1]).filter((n): n is string => Boolean(n)))];
  const resolved: string[] = [];
  for (const name of names) {
    const out = await gitOut(['remote', 'get-url', '--push', '--all', name], cwd);
    if (out) resolved.push(...out.split('\n').map(s => s.trim()).filter(Boolean));
  }
  return [...new Set([...resolved, ...raw])];
}

/**
 * The project's main lines, which no token is ever for: main, master, develop and trunk, the
 * remote's HEAD (origin/HEAD, "origin/production" read as "production") when git has it, and
 * init.defaultBranch. A repo pushed without a clone has no origin/HEAD, so the names stand in.
 * The branch the project's own checkout is on is not one: it is often a feature branch.
 */
export async function mainLines(cwd: string): Promise<Set<string>> {
  const lines = new Set(['main', 'master', 'develop', 'trunk']);
  const head = (await gitOut(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd))?.trim();
  if (head) lines.add(head.replace(/^[^/]+\//, ''));
  const configured = (await gitOut(['config', '--get', 'init.defaultBranch'], cwd))?.trim();
  if (configured) lines.add(configured);
  return lines;
}

/** A remote URL fit to show: any user name, password or token in it removed. */
export function safeRemote(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** A remote as git may write it: no trailing slash or .git, so the pre-push's URL and \`git remote -v\`'s compare. */
function sameRemote(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}

/**
 * One push the user approved (take_action force_push): a token the agent passes as
 * PODCODE_PUSH_OVERRIDE, for one branch (never main or a tag; take_action checks) on the
 * project's remotes, used once within six hours.
 */
export function issueOverride(binding: { branch: string; remotes: string[] }): string {
  const branch = binding.branch.replace(/^refs\/heads\//, '');
  if (!branch || /^refs\//.test(branch)) throw new Error('A force-push token is for one branch.');
  // A second lock behind take_action's: main, master and tags are shared history (ALL-D9).
  if (branch === 'main' || branch === 'master') throw new Error(`${branch} is never force-pushed.`);
  const token = randomBytes(12).toString('hex');
  overrides.set(token, { branch, remotes: binding.remotes.map(sameRemote), at: Date.now() });
  return token;
}

/**
 * The pre-push asking whether a token is good for this push: every ref it would overwrite is the
 * approved branch, never a tag, on one of its remotes. Yes uses the token up; a no leaves it for
 * the right push (the refusal says why).
 */
export function redeemOverride(token: unknown, refs: unknown, remote?: unknown): { ok: boolean; why?: string } {
  if (typeof token !== 'string' || !/^[a-f0-9]{24}$/.test(token)) return { ok: false, why: 'not a token PodCode issued' };
  const entry = overrides.get(token);
  if (!entry) return { ok: false, why: 'not a token PodCode issued, or used already' };
  if (Date.now() - entry.at > OVERRIDE_TTL) { overrides.delete(token); return { ok: false, why: 'the approval is over six hours old' }; }
  const named = String(refs ?? '').split(/\s+/).filter(Boolean).map(r => r.replace(/\(.*$/, ''));
  if (named.some(r => r.startsWith('refs/tags/'))) return { ok: false, why: 'tags are never force-pushed; the token is still good for its branch' };
  if (!named.length || !named.every(r => r === `refs/heads/${entry.branch}`)) return { ok: false, why: `the token is for ${entry.branch} only; it is still good for that push` };
  if (typeof remote !== 'string' || !entry.remotes.includes(sameRemote(remote))) return { ok: false, why: `the token is for ${entry.branch} on ${entry.remotes.map(safeRemote).join(', ')} only; it is still good for that push` };
  overrides.delete(token);
  return { ok: true };
}

/**
 * Shell commands that would turn the guard off: skipping hooks on a push, or pointing git's hooks
 * or config elsewhere. Agents' Bash calls with these are refused (Claude), and logged.
 */
export function disablesPushGuard(command: string): string | null {
  const text = command.replace(/\\\n/g, ' ');
  if (/\bpush\b[^\n;|&]*\s--no-v|\s--no-v[a-z]*\b[^\n;|&]*\bpush\b/.test(text)) return 'git push --no-verify skips the push check';
  if (/core\.hooksPath/i.test(text) && /\bpush\b/.test(text)) return 'changing core.hooksPath turns the push check off';
  if (/\bsend-pack\b|\bhttp-push\b/.test(text)) return 'git send-pack writes to a remote without the push check';
  if (/(^|[\s;|&(])\/[\w./-]*\/git\s+([^\n;|&]*\s)?push\b/.test(text)) return 'running another git by its full path skips the push check';
  if (/\b(BASH_ENV|ZDOTDIR)=/.test(text)) return 'changing the shell startup that keeps PodCode\'s git first';
  if (/git-hooks\/(bin|zsh|env\.sh|pre-push|[a-z-]+\b)/.test(text) && /(>|\b(cp|mv|rm|ln|tee|sed\s+-i|chmod|truncate|install)\b)/.test(text)) return 'changing PodCode\'s push check files';
  if (/\benv\s+(-[a-zA-Z]*i\b|--ignore-environment\b)/.test(text)) return 'env -i drops the push check';
  if (/PODCODE_PUSH_OVERRIDE=/.test(text) && !/PODCODE_PUSH_OVERRIDE=[a-f0-9]{24}\b/.test(text)) return 'a made-up push override';
  return null;
}
