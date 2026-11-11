// Podcode release commands. The order is notes, prepare, tag, and each command checks the one
// before it ran.
//
//   npm run release:notes   -- <version>   draft docs/releases/<version>.md from the commits since the last tag
//   npm run release:prepare -- <version>   set the version in package.json and package-lock.json, commit with the notes
//   npm run release:tag     -- <version>   tag v<version> and push it; CI builds every platform and publishes
//
// The tag push starts .github/workflows/release.yml. It builds macOS (arm64, x64), Windows (x64) and
// Linux (x64), then publishes one GitHub Release with the installers, the update feeds
// (latest*.yml) the installed apps read, SHA256SUMS, and the notes file as the release body.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = 'akashsokik/agentscode';
const root = path.join(import.meta.dirname, '..');
const PLACEHOLDER = 'One sentence on what this release is about. Replace this line before running prepare.';

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const die = message => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const [command, version] = process.argv.slice(2);
if (!command || !['notes', 'prepare', 'tag'].includes(command)) {
  die('usage: node scripts/release.mjs <notes|prepare|tag> <version>');
}
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) die(`version must look like X.Y.Z, got '${version ?? ''}'`);

const tag = `v${version}`;
const notes = path.join(root, 'docs', 'releases', `${version}.md`);
const notesRel = path.relative(root, notes);
const packageVersion = () => JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const lastTag = () => git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean)[0] ?? '';
const requireClean = () => {
  if (git('status', '--porcelain', '--untracked-files=no')) die('the working tree has uncommitted changes; commit or stash them first');
};
const tagExists = name => {
  try {
    git('rev-parse', '-q', '--verify', `refs/tags/${name}`);
    return true;
  } catch {
    return false;
  }
};

function draftNotes() {
  if (existsSync(notes)) die(`${notesRel} already exists; edit it, or delete it to draft again`);
  const prev = lastTag();
  const range = prev ? `${prev}..HEAD` : 'HEAD';
  const subjects = git('log', '--no-merges', '--pretty=%s', range).split('\n').filter(Boolean);
  const section = (title, pattern) => {
    const lines = subjects.filter(s => pattern.test(s)).map(s => `- ${s.replace(/^[a-z]+(\([^)]*\))?!?: /, '')}`);
    return lines.length ? `## ${title}\n\n${lines.join('\n')}\n\n` : '';
  };
  const body =
    `${PLACEHOLDER}\n\n` +
    section('Highlights', /^feat(\(|:|!)/) +
    section('Fixes', /^fix(\(|:|!)/) +
    section('Performance', /^perf(\(|:|!)/) +
    section('Other changes', /^(?!(feat|fix|perf)(\(|:|!))/) +
    `## Download

| File | Platform |
| :-- | :-- |
| Podcode-mac-arm64.dmg | macOS, Apple silicon |
| Podcode-mac-x64.dmg | macOS, Intel |
| Podcode-win-x64.exe | Windows x64 |
| Podcode-linux-x86_64.AppImage | Linux x64 |

An installed Podcode updates itself. Verify downloads against \`SHA256SUMS\`.
` +
    (prev ? `\n**Full changelog:** https://github.com/${REPO}/compare/${prev}...${tag}\n` : '');
  mkdirSync(path.dirname(notes), { recursive: true });
  writeFileSync(notes, body);
  console.log(`drafted ${notesRel} from ${subjects.length} commits (${range})`);
  console.log(`edit it, then: npm run release:prepare -- ${version}`);
}

function prepare() {
  requireClean();
  if (!existsSync(notes)) die(`${notesRel} is missing; run: npm run release:notes -- ${version}`);
  if (readFileSync(notes, 'utf8').includes(PLACEHOLDER)) die(`${notesRel} still has the draft placeholder line; edit it first`);
  if (tagExists(tag)) die(`tag ${tag} already exists`);
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') console.log(`note: preparing on branch ${branch}, not main`);
  if (packageVersion() !== version) {
    execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  git('add', 'package.json', 'package-lock.json', notesRel);
  git('commit', '-q', '-m', `chore(release): Podcode v${version}`);
  console.log(`committed: chore(release): Podcode v${version}`);
  console.log(`next: git push origin ${branch} && npm run release:tag -- ${version}`);
}

function tagAndPush() {
  requireClean();
  if (packageVersion() !== version) die(`package.json is at ${packageVersion()}, not ${version}; run: npm run release:prepare -- ${version}`);
  if (!existsSync(notes)) die(`${notesRel} is missing`);
  if (tagExists(tag)) die(`tag ${tag} already exists`);
  git('tag', '-a', tag, '-m', `Podcode v${version}`);
  git('push', 'origin', tag);
  console.log(`pushed ${tag}; the release workflow is building it: https://github.com/${REPO}/actions/workflows/release.yml`);
}

if (command === 'notes') draftNotes();
else if (command === 'prepare') prepare();
else tagAndPush();
