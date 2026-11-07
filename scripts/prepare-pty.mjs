// node-pty runs spawn-helper to start each terminal on macOS and Linux. npm does not always keep
// its executable bit, so set it before packaging. Windows has no spawn-helper; this is a no-op there.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty');
const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
const prebuilds = path.join(root, 'prebuilds');
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) candidates.push(path.join(prebuilds, dir, 'spawn-helper'));
}
for (const file of candidates) {
  if (existsSync(file)) chmodSync(file, 0o755);
}
