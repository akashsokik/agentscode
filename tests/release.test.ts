import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// @ts-expect-error: a plain .mjs script with no type declarations
import { mergeMacYml } from '../scripts/release/merge-mac-yml.mjs';

const feed = (arch: string, hash: string) => `version: 0.2.0
files:
  - url: PodCode-mac-${arch}.zip
    sha512: ${hash}zip
    size: 100
  - url: PodCode-mac-${arch}.dmg
    sha512: ${hash}dmg
    size: 200
path: PodCode-mac-${arch}.zip
sha512: ${hash}zip
releaseDate: '2026-11-07T00:00:00.000Z'
`;

test('mergeMacYml lists both architectures and keeps the first file\'s top-level fields', () => {
  const merged: string = mergeMacYml(feed('arm64', 'a'), feed('x64', 'b'));
  for (const name of ['arm64.zip', 'arm64.dmg', 'x64.zip', 'x64.dmg']) {
    assert.match(merged, new RegExp(`- url: PodCode-mac-${name.replace('.', '\\.')}\\n`));
  }
  assert.match(merged, /- url: PodCode-mac-x64\.zip\n    sha512: bzip\n    size: 100\n/);
  assert.match(merged, /^path: PodCode-mac-arm64\.zip$/m);
  assert.match(merged, /^releaseDate: /m);
  // The file entries stay inside files:, before the top-level keys.
  assert.ok(merged.indexOf('x64.dmg') < merged.indexOf('\npath:'));
});

test('mergeMacYml does not duplicate an entry both files list', () => {
  const merged: string = mergeMacYml(feed('arm64', 'a'), feed('arm64', 'a'));
  assert.equal(merged.match(/- url: /g)?.length, 2);
});

test('mergeMacYml refuses feeds for different versions', () => {
  assert.throws(() => mergeMacYml(feed('arm64', 'a'), feed('x64', 'b').replace('0.2.0', '0.1.9')), /version mismatch/);
});

test('artifact names match the download links the site uses', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.build.artifactName, '${productName}-${os}-${arch}.${ext}');
  assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'akashsokik', repo: 'agentscode', releaseType: 'release' }]);
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater must ship in the app, so it is a dependency');
});
