// Notarizes the signed Mac app without holding a runner on Apple's queue: submit, record the
// submission id, poll for a bounded time, staple. The release workflow runs it in two steps.
//
//   node scripts/release/notarize.mjs submit <Podcode.app> <state-dir> <tag> <arch> <commit>
//     Zips the signed app into <state-dir>/Podcode.zip, submits it with `notarytool submit
//     --no-wait`, and writes <state-dir>/state.json ({ tag, arch, commit, id, submittedAt }). The
//     workflow uploads <state-dir> as an artifact, so a re-run of the same build polls this
//     submission (and staples this exact app) instead of building and submitting again.
//
//   node scripts/release/notarize.mjs reusable <state-dir> <tag> <arch> <commit>
//     Exits 0 when <state-dir>/state.json is a submission of this tag, arch and commit, so the
//     workflow may reuse it; 1 otherwise (missing, unreadable, or from another build), and the
//     workflow submits afresh. A tag moved to another commit, or another arch's artifact, is
//     never reused.
//
//   node scripts/release/notarize.mjs wait <Podcode.app> <state-dir> [minutes]
//     Polls `notarytool info <id>` every 30 seconds for up to <minutes> (default 40).
//     Accepted: staples the ticket to the app and validates it. Invalid or Rejected: prints
//     `notarytool log <id>` and fails. Still in progress at the deadline: fails with the id.
//
// Credentials come from the environment (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, or
// APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER). They are passed to notarytool as arguments,
// never through a shell and never printed; any error text is scrubbed of them before it is shown.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Seconds between polls; NOTARY_POLL_SECONDS overrides it (tests). */
const POLL_SECONDS = Number(process.env.NOTARY_POLL_SECONDS ?? 30);
const SECRET_VARS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

/** Removes every credential value from text that may be shown. */
export function scrub(text, env = process.env) {
  let out = String(text ?? '');
  for (const name of SECRET_VARS) {
    const value = env[name];
    if (value && value.length >= 4) out = out.split(value).join('***');
  }
  return out;
}

/** notarytool's authentication arguments: an App Store Connect API key if set, else Apple ID and app-specific password. */
export function authArgs(env = process.env) {
  if (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) {
    return ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return ['--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', env.APPLE_TEAM_ID];
  }
  throw new Error('No notarization credentials: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or the APPLE_API_KEY trio).');
}

/** What a poll of `notarytool info` means for the loop. */
export function verdict(status) {
  if (status === 'Accepted') return 'accepted';
  if (status === 'Invalid' || status === 'Rejected') return 'invalid';
  return 'waiting';
}

/**
 * Whether a saved submission belongs to this build: the same tag, arch and commit. Anything
 * else (an older state without a commit, a moved tag, the other Mac arch) is not reused.
 */
export function canReuse(state, { tag, arch, commit }) {
  if (!state || typeof state !== 'object' || typeof state.id !== 'string' || !state.id) return false;
  if (!tag || !arch || !commit) return false;
  return state.tag === tag && state.arch === arch && state.commit === commit;
}

function run(bin, args, { timeout = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

async function notarytool(args, options) {
  return run('xcrun', ['notarytool', ...args, ...authArgs()], options);
}

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function fail(message) {
  console.error(`::error::${scrub(message)}`);
  process.exit(1);
}

async function submit(app, stateDir, tag, arch, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) fail(`submit needs the full commit (git rev-parse HEAD), got "${commit}".`);
  if (!existsSync(app)) fail(`No app at ${app}.`);
  mkdirSync(stateDir, { recursive: true });
  const zip = path.join(stateDir, 'Podcode.zip');
  const zipped = await run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  if (zipped.code !== 0) fail(`Could not zip ${app}: ${zipped.stderr}`);
  const result = await notarytool(['submit', zip, '--no-wait', '--output-format', 'json'], { timeout: 30 * 60_000 });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { /* reported below */ }
  if (result.code !== 0 || !parsed?.id) fail(`notarytool submit failed (exit ${result.code}): ${result.stdout}\n${result.stderr}`);
  const state = { tag, arch, commit, id: parsed.id, submittedAt: new Date().toISOString() };
  writeFileSync(path.join(stateDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  summary(`Notarization submitted for ${tag} ${arch}: submission id ${parsed.id}`);
}

async function wait(app, stateDir, minutes) {
  const state = JSON.parse(readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  const deadline = Date.now() + minutes * 60_000;
  const started = Date.now();
  let last = '';
  console.log(`Waiting up to ${minutes} min for Apple to notarize submission ${state.id} (${state.tag} ${state.arch}, submitted ${state.submittedAt}).`);
  for (;;) {
    const result = await notarytool(['info', state.id, '--output-format', 'json'], { timeout: 2 * 60_000 });
    let status = '';
    try { status = JSON.parse(result.stdout).status ?? ''; } catch { /* a failed poll: try again */ }
    const elapsed = Math.round((Date.now() - started) / 60_000);
    if (!status) {
      console.log(`[${elapsed} min] notarytool info did not answer (exit ${result.code}): ${scrub(result.stderr.trim().split('\n').pop() ?? '')}; trying again.`);
    } else if (status !== last) {
      console.log(`[${elapsed} min] ${status}`);
      last = status;
    }
    const v = verdict(status);
    if (v === 'accepted') break;
    if (v === 'invalid') {
      const log = await notarytool(['log', state.id], { timeout: 2 * 60_000 });
      console.log(scrub(log.stdout || log.stderr));
      fail(`Apple did not accept submission ${state.id} (${status}); its log is above. Fix the cause, then start a fresh workflow dispatch without notary_run_id: re-running the failed jobs would reuse this rejected submission.`);
    }
    if (Date.now() >= deadline) {
      summary(`Notarization of ${state.tag} ${state.arch} is still ${status || 'unknown'} after ${minutes} min: submission ${state.id}.`);
      fail(`Apple has not finished submission ${state.id} after ${minutes} min. Re-run the failed jobs: the next attempt polls this same submission instead of submitting again.`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_SECONDS * 1000));
  }
  const stapled = await run('xcrun', ['stapler', 'staple', app]);
  if (stapled.code !== 0) fail(`Notarized (${state.id}), but stapling failed: ${stapled.stdout}\n${stapled.stderr}`);
  const valid = await run('xcrun', ['stapler', 'validate', app]);
  if (valid.code !== 0) fail(`The stapled ticket does not validate: ${valid.stdout}\n${valid.stderr}`);
  summary(`Notarized and stapled ${state.tag} ${state.arch}: submission ${state.id}.`);
}

const [command, ...args] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (command === 'submit' && args.length === 5) await submit(...args);
    else if (command === 'reusable' && args.length === 4) {
      const [stateDir, tag, arch, commit] = args;
      let state = null;
      try { state = JSON.parse(readFileSync(path.join(stateDir, 'state.json'), 'utf8')); } catch { /* none or unreadable: not reusable */ }
      const ok = canReuse(state, { tag, arch, commit });
      console.log(ok ? `reusing submission ${state.id} (${tag} ${arch} ${commit.slice(0, 7)})` : `no reusable submission for ${tag} ${arch} ${commit.slice(0, 7)}${state ? ` (saved: ${state.tag ?? '?'} ${state.arch ?? '?'} ${String(state.commit ?? 'no commit').slice(0, 7)})` : ''}`);
      process.exit(ok ? 0 : 1);
    }
    else if (command === 'wait' && (args.length === 2 || args.length === 3)) await wait(args[0], args[1], Number(args[2] ?? 40));
    else fail('usage: notarize.mjs submit <app> <state-dir> <tag> <arch> <commit> | reusable <state-dir> <tag> <arch> <commit> | wait <app> <state-dir> [minutes]');
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
