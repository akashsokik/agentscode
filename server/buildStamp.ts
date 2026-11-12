import fs from 'node:fs';
import path from 'node:path';
import { buildId, type BuildInfo } from '../shared/buildInfo.ts';

/**
 * The build of the page this server serves now, from the build.json Vite writes beside it
 * (vite.config.ts), or null when there is none or it cannot be read. Read on every connection,
 * not once: a rebuild while the server runs changes what a reload gets, so a page compares with
 * what it would get, and a new page never sees itself as stale.
 */
export function readBuildId(distDir: string | undefined): string | null {
  if (!distDir) return null;
  try {
    return buildId(JSON.parse(fs.readFileSync(path.join(distDir, 'build.json'), 'utf8')) as Partial<BuildInfo>);
  } catch {
    return null;
  }
}
