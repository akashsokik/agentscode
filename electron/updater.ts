/**
 * Updates for the packaged app, from the GitHub Releases of akashsokik/agentscode (the `publish`
 * entry in package.json, which electron-builder writes into the app as app-update.yml).
 *
 * The app checks at launch and every few hours, without a word unless it finds something. A found
 * update shows in the sidebar as MonoCode's "Update to X" row (web/sidebar/SidebarUpdate.tsx),
 * which reads this module's snapshot through the preload bridge (electron/preload.cts). Clicking it
 * downloads the update with its progress in the row, then restarts into it (Windows NSIS, Linux AppImage).
 *
 * macOS can only swap the app in place when the running app carries a Developer ID signature
 * (Squirrel.Mac checks it), so on an unsigned Mac build the row offers the install command instead.
 * Errors are logged and never shown, except to someone who chose Check for Updates.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, clipboard, dialog, shell, type BrowserWindow } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import { MAC_INSTALL_COMMAND, releaseNotesUrl, type UpdateSnapshot } from '../shared/updates.ts';

const { autoUpdater } = electronUpdater;

/** How often a running app looks for a new release. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Give the server and window a moment before the first check. */
const FIRST_CHECK_DELAY_MS = 10_000;

type Options = {
  /** The window to attach dialogs to, when there is one. */
  window: () => BrowserWindow | null;
  /** Stops the bundled server (and its agents) so the app can quit and install. */
  stopServer: () => Promise<void>;
};

let options: Options | null = null;
/** True when this app can install an update itself; false for an unsigned Mac build. */
let canInstall = false;
let available: UpdateInfo | null = null;
let snapshot: UpdateSnapshot = { phase: 'idle', currentVersion: app.getVersion(), canInstall: false };
const listeners = new Set<(next: UpdateSnapshot) => void>();

function setSnapshot(next: Partial<UpdateSnapshot>): void {
  snapshot = { ...snapshot, ...next, currentVersion: app.getVersion(), canInstall };
  for (const listener of listeners) listener(snapshot);
}

/** The current update state, for the page. */
export function updateSnapshot(): UpdateSnapshot {
  return snapshot;
}

/** Calls back with every new update state; returns the unsubscribe function. */
export function onUpdateChange(listener: (next: UpdateSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when the running .app is signed with a Developer ID, which Squirrel.Mac needs. */
function hasDeveloperIdSignature(): Promise<boolean> {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  return new Promise(resolve => {
    execFile('codesign', ['-dv', '--verbose=2', bundle], { timeout: 10_000 }, (_error, stdout, stderr) => {
      resolve(/Authority=Developer ID Application/.test(`${stdout}\n${stderr}`));
    });
  });
}

async function showMessage(message: Electron.MessageBoxOptions): Promise<number> {
  const win = options?.window();
  const result = win ? await dialog.showMessageBox(win, message) : await dialog.showMessageBox(message);
  return result.response;
}

/** The unsigned Mac build's way to update: it cannot replace itself, so it explains how. */
async function offerDownload(info: UpdateInfo): Promise<void> {
  const response = await showMessage({
    type: 'info',
    buttons: ['Copy Install Command', 'Release Notes', 'Later'],
    defaultId: 0,
    cancelId: 2,
    message: `Podcode ${info.version} is available`,
    detail: `You have ${app.getVersion()}. To update, quit Podcode and run this in Terminal:\n\n${MAC_INSTALL_COMMAND}`,
  });
  if (response === 0) clipboard.writeText(MAC_INSTALL_COMMAND);
  if (response === 1) void shell.openExternal(releaseNotesUrl(info.version));
}

/**
 * Installs the available update, from the sidebar row or the menu: downloads it (progress in the
 * row), stops the agents and restarts into it. An unsigned Mac build explains how to update instead.
 */
export async function installUpdate(): Promise<void> {
  if (!options || !available) return;
  if (!canInstall) {
    await offerDownload(available);
    return;
  }
  if (snapshot.phase === 'downloading' || snapshot.phase === 'ready') return;
  try {
    setSnapshot({ phase: 'downloading', progress: 0, error: undefined });
    await autoUpdater.downloadUpdate();
    setSnapshot({ phase: 'ready', progress: 100 });
    await options.stopServer();
    // With the server stopped, the app's before-quit handler lets the quit through.
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    console.error('[updater] install failed:', error);
    // Back to "Update to X", so another click tries again.
    setSnapshot({ phase: 'available', progress: undefined, error: error instanceof Error ? error.message : String(error) });
    await showMessage({
      type: 'warning',
      message: `Podcode could not update to ${available.version}`,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Looks for a new release. `manual` (Check for Updates) reports the outcome in a dialog. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!options) {
    if (manual) await showMessage({ type: 'info', message: 'Updates are only available in the installed app.' });
    return;
  }
  if (snapshot.phase === 'downloading' || snapshot.phase === 'ready') return;
  if (available && manual) {
    await offerInstall(available);
    return;
  }
  setSnapshot({ phase: 'checking' });
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable) {
      available = result.updateInfo;
      setSnapshot({ phase: 'available', availableVersion: result.updateInfo.version, error: undefined });
      if (manual) await offerInstall(result.updateInfo);
      return;
    }
    setSnapshot({ phase: 'current', availableVersion: undefined, error: undefined });
    if (manual) await showMessage({ type: 'info', message: 'Podcode is up to date', detail: `You have version ${app.getVersion()}.` });
  } catch (error) {
    console.error('[updater] check failed:', error);
    // Keep an update already found; otherwise there is nothing to show in the sidebar.
    setSnapshot({ phase: available ? 'available' : 'error', error: error instanceof Error ? error.message : String(error) });
    if (manual) {
      await showMessage({
        type: 'warning',
        message: 'Podcode could not check for updates',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Check for Updates found one: offer it now, the same as the sidebar row. */
async function offerInstall(info: UpdateInfo): Promise<void> {
  if (!canInstall) {
    await offerDownload(info);
    return;
  }
  const response = await showMessage({
    type: 'info',
    buttons: ['Update Now', 'Later', 'Release Notes'],
    defaultId: 0,
    cancelId: 1,
    message: `Podcode ${info.version} is available`,
    detail: `You have ${app.getVersion()}. Updating downloads it, stops running agents and restarts; they pick up where they left off. You can also update later from the sidebar.`,
  });
  if (response === 2) void shell.openExternal(releaseNotesUrl(info.version));
  if (response === 0) await installUpdate();
}

/** Starts update checks: once shortly after launch, then every few hours. Packaged builds only. */
export async function startUpdater(opts: Options): Promise<void> {
  if (!app.isPackaged || process.env.AGENTSCODE_DISABLE_UPDATES) return;
  // A Linux build that is not an AppImage (say, unpacked by hand) has nothing to update.
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  options = opts;
  canInstall = process.platform !== 'darwin' || (await hasDeveloperIdSignature());

  autoUpdater.logger = console;
  // MonoCode's flow: a found update waits for a click, which downloads it and restarts.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = app.getVersion().includes('-');

  autoUpdater.on('download-progress', progress => {
    setSnapshot({ phase: 'downloading', progress: Math.floor(progress.percent) });
  });
  autoUpdater.on('error', error => {
    // Before the first release exists GitHub answers 404 for latest*.yml; that is not worth a dialog.
    console.error('[updater]', error?.message ?? error);
  });

  setSnapshot({});
  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS).unref();
  setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS).unref();
}
