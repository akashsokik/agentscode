/**
 * App updates as the desktop app reports them to the page (electron/updater.ts, through the
 * preload bridge), and the rules the sidebar's update row follows. The row is MonoCode's
 * (src/app/shell/SidebarUpdate.tsx and UpdateRailCard.tsx in hardbeat920/monocode).
 */

export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'error';

export type UpdateSnapshot = {
  phase: UpdatePhase;
  /** The running app's version. */
  currentVersion: string;
  /** The newer release, once a check found one. */
  availableVersion?: string;
  /** Download progress, 0 to 100, while downloading. */
  progress?: number;
  error?: string;
  /**
   * False when this app cannot replace itself: an unsigned Mac build (Squirrel.Mac needs a
   * Developer ID signature). Its update row then explains how to update instead of installing.
   */
  canInstall: boolean;
};

/** What the preload script puts on `window.agentscodeDesktop.updates`. */
export type DesktopUpdates = {
  get(): Promise<UpdateSnapshot>;
  /** Installs the available update: downloads it, then restarts into it. */
  install(): Promise<void>;
  /** Calls back with every new snapshot; returns the unsubscribe function. */
  onChange(callback: (snapshot: UpdateSnapshot) => void): () => void;
  /** Check for Updates: looks now and reports the outcome in a dialog, as the app menu's item does. */
  check(): Promise<void>;
  /** The app menu's About Podcode: calls back to open Settings at About. */
  onShowAbout(callback: () => void): () => void;
};

/**
 * The Mac installer (install.sh at the repo root). curl does not quarantine what it downloads, so
 * an unsigned build it installs opens without Gatekeeper's "Apple could not verify" refusal. A copy
 * downloaded in a browser is quarantined and needs Open Anyway in System Settings first.
 */
export const MAC_INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/akashsokik/agentscode/main/install.sh | bash';

export const RELEASES_URL = 'https://github.com/akashsokik/agentscode/releases';

export function releaseNotesUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/**
 * The sidebar row only earns its space when there is something to act on: an update waiting, one
 * downloading, or one downloaded and about to restart. Every other phase, including a failed
 * check, stays silent; Check for Updates in the app menu reports those.
 */
export function isUpdateActionable(snapshot: UpdateSnapshot): boolean {
  return snapshot.phase === 'available' || snapshot.phase === 'downloading' || snapshot.phase === 'ready';
}

export function updateLabel(snapshot: UpdateSnapshot): string {
  if (snapshot.phase === 'downloading') return `Downloading${snapshot.progress != null ? ` ${snapshot.progress}%` : '…'}`;
  if (snapshot.phase === 'ready') return 'Restarting…';
  return `Update to ${snapshot.availableVersion ?? 'the latest version'}`;
}

/**
 * The "Updated to X" card after an update. The page remembers the last version it ran on; when the
 * app's version differs from it, the app was updated (by itself or by a reinstall) and the card
 * shows until dismissed. A first run only records the version.
 */
export function updatedNotice(lastSeen: string | null, current: string): string | null {
  if (!lastSeen || !current || lastSeen === current) return null;
  return current;
}
