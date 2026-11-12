/**
 * What this build is, for Settings > About. vite.config.ts bakes it into the page at build time
 * (`__PODCODE_BUILD__`), so the packaged app never runs git. Pure, so it is tested directly.
 */
import type { UpdateSnapshot } from './updates.ts';

export type BuildInfo = {
  /** package.json's version when the page was built. */
  version: string;
  /** Short commit hash, or '' when the build had no git checkout. */
  commit: string;
  /** When the page was built, as an ISO timestamp. */
  date: string;
};

/**
 * One string that names a build, for telling a page from an older or newer build apart: the
 * version, commit and build time. null when the build carries no time (a page loaded some other
 * way), so it never compares as different.
 */
export function buildId(info: Partial<BuildInfo> | null | undefined): string | null {
  if (!info || typeof info.date !== 'string' || !info.date) return null;
  return `${info.version ?? ''}+${info.commit ?? ''}@${info.date}`;
}

/** "Prerelease" for a version with a suffix (0.3.0-beta.1), which updates from prereleases too. */
export function channelLabel(version: string): 'Release' | 'Prerelease' {
  return version.includes('-') ? 'Prerelease' : 'Release';
}

/** "1a2b3c4, built 9 Nov 2026"; either half alone when the other is missing. */
export function buildLabel(info: Pick<BuildInfo, 'commit' | 'date'>): string {
  const when = new Date(info.date);
  const day = Number.isNaN(when.getTime())
    ? ''
    : `built ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  return [info.commit, day].filter(Boolean).join(', ') || 'Unknown build';
}

/** The update state as one line for About. */
export function updateStatusText(snapshot: UpdateSnapshot): string {
  switch (snapshot.phase) {
    case 'idle':
      return 'Not checked yet';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return 'Up to date';
    case 'available':
      return `Version ${snapshot.availableVersion ?? 'newer'} is available`;
    case 'downloading':
      return `Downloading ${snapshot.availableVersion ?? 'the update'}${snapshot.progress != null ? ` (${snapshot.progress}%)` : '…'}`;
    case 'ready':
      return 'Restarting to update…';
    case 'error':
      return `Could not check for updates${snapshot.error ? `: ${firstLine(snapshot.error)}` : ''}`;
  }
}

/** Updater errors can carry a whole HTTP response; one line is enough here. */
function firstLine(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
