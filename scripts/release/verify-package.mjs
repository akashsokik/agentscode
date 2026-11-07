// Checks a packaged AgentsCode app before it ships: the pieces that are platform specific, and so
// easy to get wrong in a CI matrix, are there for the platform and architecture being built.
//
//   node scripts/release/verify-package.mjs <platform> <arch>     (darwin|win32|linux, arm64|x64)
//
// It finds the unpacked app under release/ (asar is off, so the app's files are plain files).
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const [platform, arch] = process.argv.slice(2);
if (!platform || !arch) {
  console.error('usage: verify-package.mjs <darwin|win32|linux> <arm64|x64>');
  process.exit(1);
}

const release = path.join(import.meta.dirname, '..', '..', 'release');

/** The Resources directory of the unpacked app electron-builder left in release/. */
function findResources() {
  for (const dir of readdirSync(release)) {
    const full = path.join(release, dir);
    if (!statSync(full).isDirectory()) continue;
    const mac = path.join(full, 'AgentsCode.app', 'Contents', 'Resources');
    if (existsSync(mac)) return mac;
    const other = path.join(full, 'resources');
    if (existsSync(path.join(other, 'app'))) return other;
  }
  throw new Error(`no unpacked app in ${release}`);
}

const resources = findResources();
const app = path.join(resources, 'app');
const modules = path.join(app, 'node_modules');
const pty = path.join(modules, 'node-pty');
const checks = [
  ['app-update.yml (updater feed)', path.join(resources, 'app-update.yml')],
  ['electron main', path.join(app, 'out', 'electron', 'main.js')],
  ['electron updater module', path.join(app, 'out', 'electron', 'updater.js')],
  ['server', path.join(app, 'out', 'server', 'index.js')],
  ['web app', path.join(app, 'out', 'dist', 'index.html')],
  ['electron-updater', path.join(modules, 'electron-updater', 'package.json')],
  [`claude-agent-sdk ${platform}-${arch}`, path.join(modules, '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}`, 'package.json')],
];
const ptyBinary = [path.join(pty, 'build', 'Release', 'pty.node'), path.join(pty, 'prebuilds', `${platform}-${arch}`, 'pty.node')];

let failed = false;
for (const [label, file] of checks) {
  const ok = existsSync(file);
  failed ||= !ok;
  console.log(`${ok ? 'ok     ' : 'MISSING'} ${label}  ${path.relative(release, file)}`);
}
const pty_ = ptyBinary.find(existsSync);
failed ||= !pty_;
console.log(`${pty_ ? 'ok     ' : 'MISSING'} node-pty ${platform}-${arch}  ${pty_ ? path.relative(release, pty_) : ptyBinary.map(f => path.relative(release, f)).join(' or ')}`);
if (failed) {
  console.error('the packaged app is missing files; see above');
  process.exit(1);
}
