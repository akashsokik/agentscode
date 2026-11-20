import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function enclosingCheckout(dir: string, boundary = path.parse(dir).root): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (current === boundary) return;
  }
}

function buildRoot(folder: string): string | undefined {
  // A restart build can be a source export without a .git marker.
  const release = path.dirname(folder);
  if (path.basename(release) === 'release') return path.dirname(release);
  return undefined;
}

function physicalPath(file: string): string | undefined {
  try {
    return fs.realpathSync.native(file);
  } catch { return; }
}

// Electron itself ships a .app under node_modules on macOS.
const dependencyDirs = new Set(['node_modules', '.pnpm-store', 'bower_components', '.venv']);

async function containsApp(dir: string): Promise<boolean> {
  for await (const entry of await fs.promises.opendir(dir)) {
    if (!entry.isDirectory() || entry.name === '.git' || dependencyDirs.has(entry.name)) continue;
    if (/\.app$/i.test(entry.name) || await containsApp(path.join(dir, entry.name))) return true;
  }
  return false;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(path.join(b, path.sep)) || b.startsWith(path.join(a, path.sep));
}

/** Resolve the running app once per pass and scan each checkout at most once in that pass. */
export function storageAppProtection(desktopExecutable?: string) {
  const executable = physicalPath(desktopExecutable ?? process.execPath);
  // An Electron utility process may be inside a nested Helper.app. Protect the outer bundle.
  const bundle = executable?.match(/^(.+?\.app)\/Contents\//i)?.[1];
  const folder = bundle ? path.dirname(bundle) : desktopExecutable && executable && path.dirname(executable);
  const hostingRoot = folder && enclosingCheckout(folder);
  let source = folder && buildRoot(folder);
  if (bundle && process.platform === 'darwin') {
    // The restart script records local build provenance on the installed copy only.
    try {
      const recorded = execFileSync('/usr/bin/xattr', ['-p', 'com.podcode.build-root', bundle], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000,
      }).replace(/\n$/, '');
      if (path.isAbsolute(recorded) && fs.statSync(recorded).isDirectory()) source = fs.realpathSync.native(recorded);
    } catch { /* Older installations have no provenance. */ }
  }
  const packaged = new Map<string, boolean>();
  return async (candidate: string, root: string): Promise<string | undefined> => {
    if ((folder && overlaps(folder, candidate)) || (hostingRoot && overlaps(hostingRoot, candidate))
        || (source && overlaps(source, candidate))) {
      return 'The running PodCode app and its build folder are protected.';
    }
    if (source) return;
    const checkout = enclosingCheckout(candidate, root) ?? root;
    if (!packaged.has(checkout)) {
      try { packaged.set(checkout, await containsApp(checkout)); }
      catch { packaged.set(checkout, true); } // An incomplete scan cannot rule out a packaged app.
    }
    if (packaged.get(checkout)) {
      return 'The running build location is unknown and this workspace contains or may contain a packaged app.';
    }
  };
}
