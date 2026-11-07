/**
 * Updates for the packaged app, from the GitHub Releases of akashsokik/agentscode (the `publish`
 * entry in package.json, which electron-builder writes into the app as app-update.yml).
 *
 * Windows (NSIS) and Linux (AppImage) download an update in the background and install it on
 * restart. macOS can only swap the app in place when the running app carries a Developer ID
 * signature (Squirrel.Mac checks it), so an unsigned Mac build offers the download page instead.
 * Errors are logged and never shown, except to someone who chose Check for Updates.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';

const { autoUpdater } = electronUpdater;

const RELEASES_URL = 'https://github.com/akashsokik/agentscode/releases';
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
let canInstall = true;
/** Set while a Check for Updates the user chose is running, so an update it finds is offered again. */
let manualCheck = false;
let downloaded: UpdateInfo | null = null;
let prompted: string | null = null;

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

function releasePage(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

async function offerDownload(info: UpdateInfo): Promise<void> {
  if (prompted === info.version && !manualCheck) return;
  prompted = info.version;
  const response = await showMessage({
    type: 'info',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: `AgentsCode ${info.version} is available`,
    detail: `You have ${app.getVersion()}. Download the new version and replace the app in Applications.`,
  });
  if (response === 0) void shell.openExternal(releasePage(info.version));
}

async function offerRestart(info: UpdateInfo, force = false): Promise<void> {
  if (prompted === info.version && !force) return;
  prompted = info.version;
  const response = await showMessage({
    type: 'info',
    buttons: ['Restart Now', 'Later', 'Release Notes'],
    defaultId: 0,
    cancelId: 1,
    message: `AgentsCode ${info.version} is ready to install`,
    detail: 'Restart to update. Running agents stop first and pick up where they left off. If you choose Later, the update installs the next time you quit.',
  });
  if (response === 2) {
    void shell.openExternal(releasePage(info.version));
    return;
  }
  if (response === 0) await restartAndInstall();
}

async function restartAndInstall(): Promise<void> {
  if (!options) return;
  await options.stopServer();
  // With the server stopped, the app's before-quit handler lets the quit through.
  autoUpdater.quitAndInstall(false, true);
}

/** Looks for a new release. `manual` shows the outcome, including "up to date" and errors. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!options) {
    if (manual) await showMessage({ type: 'info', message: 'Updates are only available in the installed app.' });
    return;
  }
  if (downloaded) {
    if (manual) await offerRestart(downloaded, true);
    return;
  }
  manualCheck = manual;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!manual) return;
    if (!result?.isUpdateAvailable) {
      await showMessage({ type: 'info', message: 'AgentsCode is up to date', detail: `You have version ${app.getVersion()}.` });
    } else if (canInstall) {
      await showMessage({
        type: 'info',
        message: `Downloading AgentsCode ${result.updateInfo.version}`,
        detail: 'You will be asked to restart when it is ready.',
      });
    }
  } catch (error) {
    console.error('[updater] check failed:', error);
    if (manual) {
      await showMessage({
        type: 'warning',
        message: 'AgentsCode could not check for updates',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    manualCheck = false;
  }
}

/** Starts update checks: once shortly after launch, then every few hours. Packaged builds only. */
export async function startUpdater(opts: Options): Promise<void> {
  if (!app.isPackaged || process.env.AGENTSCODE_DISABLE_UPDATES) return;
  // A Linux build that is not an AppImage (say, unpacked by hand) has nothing to update.
  if (process.platform === 'linux' && !process.env.APPIMAGE) return;
  options = opts;
  canInstall = process.platform !== 'darwin' || (await hasDeveloperIdSignature());

  autoUpdater.logger = console;
  autoUpdater.autoDownload = canInstall;
  autoUpdater.autoInstallOnAppQuit = canInstall;
  autoUpdater.allowPrerelease = app.getVersion().includes('-');

  autoUpdater.on('update-available', info => {
    console.log(`[updater] ${info.version} is available`);
    if (!canInstall) void offerDownload(info);
  });
  autoUpdater.on('update-downloaded', info => {
    downloaded = info;
    console.log(`[updater] ${info.version} downloaded`);
    void offerRestart(info);
  });
  autoUpdater.on('error', error => {
    // Before the first release exists GitHub answers 404 for latest*.yml; that is not worth a dialog.
    console.error('[updater]', error?.message ?? error);
  });

  setTimeout(() => void checkForUpdates(false), FIRST_CHECK_DELAY_MS).unref();
  setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS).unref();
}
