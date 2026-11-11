/**
 * The PodCode desktop app: a window on the PodCode server. It starts the bundled server
 * (compiled to out/server) in an Electron utility process and opens a window once it listens.
 * When a PodCode server already answers on the port (say `npm run dev`), the window opens
 * on that one instead, so two servers never share ~/.podcode. Ported from Agent Office.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { app, autoUpdater as nativeUpdater, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { isLocalUrl } from '../shared/browser.ts';
import { BrowserError, BrowserHost, type Rect } from './browser.ts';
import { BrowserBridge } from './bridge.ts';
import { checkForUpdates, installUpdate, onUpdateChange, startUpdater, updateSnapshot } from './updater.ts';
import { startSuperBridge, stopSuperBridge } from './superTray.ts';
import { QuickWindow } from './quickWindow.ts';
import { captureApp } from './appShot.ts';

// The app was called AgentsCode before 0.3.0, and Electron names the userData folder after the app.
// That folder holds the window's localStorage (layout, drafts), the integrated browser's logins
// (persist:agentscode-browser) and the single-instance lock. Keeping its old name means an update
// keeps all of that, and an old AgentsCode.app and a PodCode.app can never run at once. Set before
// anything reads userData, and before requestSingleInstanceLock below.
app.setPath('userData', path.join(app.getPath('appData'), 'AgentsCode'));

const PORT = Number(process.env.PORT ?? 4320);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** How long the server gets to stop its agents before the app quits anyway. */
const SHUTDOWN_GRACE_MS = 8000;
/** How long a fresh server gets to start listening before the app gives up. */
const START_TIMEOUT_MS = 60_000;
/** The line server/index.ts logs once it listens. */
const READY_LINE = 'PodCode is open at';

let server: UtilityProcess | null = null;
let window: BrowserWindow | null = null;
/** The SuperAgent's floating quick composer, made once the app is ready. */
let quick: QuickWindow | null = null;
let ready = false;
let quitting = false;
const recentOutput: string[] = [];
/** Resolves whoever waits in stopServer() once the bundled server has exited. */
const serverStopped: Array<() => void> = [];
/** The integrated browser's tabs, and the line the server's agent tools reach them by. */
const browser = new BrowserHost({ appPort: PORT, window: () => window });
const bridge = new BrowserBridge(browser, PORT);

/** Finder starts apps with a bare PATH; agents need the user's own to find node, git, claude and codex. */
function useLoginShellPath(): void {
  try {
    const output = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = output.match(/__PATH__(.*)__PATH__/)?.[1];
    if (found) process.env.PATH = found;
  } catch {
    // keep the default PATH; server/config.ts also checks the usual install locations
  }
}

/** True when a PodCode server already answers on the port. */
async function serverAnswers(): Promise<boolean> {
  try {
    const res = await fetch(`${ORIGIN}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const state = (await res.json()) as { agents?: unknown };
    return Array.isArray(state.agents);
  } catch {
    return false;
  }
}

function markReady(): void {
  if (ready) return;
  ready = true;
  showWindow();
  // Its page needs the server, which answers now.
  quick?.prepare();
}

function startServer(): void {
  server = utilityProcess.fork(path.join(import.meta.dirname, '..', 'server', 'index.js'), [], {
    serviceName: 'PodCode Server',
    stdio: 'pipe',
    // The server runs agents' comms tools with this binary, as plain Node (server/config.ts).
    env: { ...process.env, PODCODE_NODE: process.execPath },
  });
  for (const [stream, sink] of [[server.stdout, process.stdout], [server.stderr, process.stderr]] as const) {
    stream?.on('data', (chunk: Buffer) => {
      sink.write(chunk);
      const text = chunk.toString();
      recentOutput.push(text);
      if (recentOutput.length > 40) recentOutput.shift();
      if (text.includes(READY_LINE)) markReady();
    });
  }
  server.on('exit', onServerExit);
  bridge.useUtility(server);
  // In case the ready line is missed, ask the server itself.
  const started = Date.now();
  const poll = setInterval(() => {
    if (ready || !server) return clearInterval(poll);
    if (Date.now() - started > START_TIMEOUT_MS) {
      clearInterval(poll);
      dialog.showErrorBox('PodCode could not start', `The server did not answer on port ${PORT} within a minute.`);
      app.exit(1);
      return;
    }
    void serverAnswers().then(up => { if (up) markReady(); });
  }, 500);
}

/**
 * While the window shows a server this app did not start (say `npm run dev`), keep an eye on it:
 * if it stops answering for a few seconds, start the bundled one in its place. The page
 * reconnects on its own. A short gap, like `node --watch` restarting, is not enough.
 */
function watchAttachedServer(): void {
  let misses = 0;
  const timer = setInterval(() => {
    if (server || quitting) return clearInterval(timer);
    void serverAnswers().then(up => {
      misses = up ? 0 : misses + 1;
      if (misses >= 3 && !server && !quitting) {
        clearInterval(timer);
        startServer();
      }
    });
  }, 2000);
}

/**
 * Stops the bundled server, which stops every agent first (SIGTERM runs manager.shutdown() in
 * server/index.ts). Resolves once it has exited, or after the grace period.
 */
function stopServer(): Promise<void> {
  if (!server) return Promise.resolve();
  quitting = true;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      server = null;
      resolve();
    }, SHUTDOWN_GRACE_MS);
    serverStopped.push(() => {
      clearTimeout(timer);
      resolve();
    });
    server?.kill();
  });
}

function onServerExit(code: number): void {
  server = null;
  if (quitting) {
    for (const done of serverStopped.splice(0)) done();
    return;
  }
  void serverAnswers().then(up => {
    // Another PodCode server took the port first (it came back while ours started): use it.
    if (up) {
      markReady();
      bridge.useSocket();
      watchAttachedServer();
      return;
    }
    const tail = recentOutput.join('').trim().split('\n').slice(-8).join('\n');
    dialog.showErrorBox(
      ready ? 'PodCode stopped' : 'PodCode could not start',
      `The PodCode server exited with code ${code}.${tail ? `\n\n${tail}` : ''}`,
    );
    app.exit(1);
  });
}

/** About PodCode: Settings > About in the window (version, build, updates), else the native panel. */
function showAbout(): void {
  if (!window || window.isDestroyed()) {
    app.showAboutPanel();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send('updates:about');
}

/**
 * The app menu: the standard Edit, View and Window commands. Close Window moves to Shift+Cmd+W
 * so Cmd+W reaches the page, where it closes the current tab (web/shortcuts.ts) as in MonoCode.
 */
function setMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { label: `About ${app.name}`, click: showAbout },
              { label: 'Check for Updates…', click: () => void checkForUpdates(true) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    { label: 'File', submenu: [{ label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    {
      role: 'help',
      submenu: [
        ...(process.platform === 'darwin'
          ? []
          : [{ label: 'Check for Updates…', click: () => void checkForUpdates(true) }, { type: 'separator' } as MenuItemConstructorOptions]),
        ...(process.platform === 'darwin' ? [] : [{ label: `About ${app.name}`, click: showAbout }]),
        { label: `Release Notes (v${app.getVersion()})`, click: () => void shell.openExternal(`https://github.com/akashsokik/agentscode/releases/tag/v${app.getVersion()}`) },
        { label: 'All Releases', click: () => void shell.openExternal('https://github.com/akashsokik/agentscode/releases') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function openLink(url: string, external: boolean): void {
  if (!/^https?:/i.test(url)) return;
  if (!external && isLocalUrl(url) && new URL(url).origin !== ORIGIN && window) {
    window.webContents.send('browser:event', { type: 'open-url', url });
    return;
  }
  void shell.openExternal(url);
}

function isRect(value: unknown): value is Rect {
  const r = value as Rect | null;
  return Boolean(r) && [r!.x, r!.y, r!.width, r!.height].every(n => typeof n === 'number' && Number.isFinite(n));
}

/** The bridge behind window.podcodeDesktop.browser (web/browser.ts). Only the PodCode page may call it. */
function registerBrowserIpc(): void {
  ipcMain.handle('browser:call', async (event, op: unknown, raw: unknown) => {
    if (!window || event.sender !== window.webContents || !fromApp(event)) throw new Error('Not allowed.');
    const args = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof args.id === 'string' ? args.id : '';
    try {
      switch (op) {
        case 'create': return browser.state(browser.create(id, typeof args.url === 'string' ? args.url : ''));
        case 'show': if (isRect(args.rect)) browser.show(id, args.rect); return null;
        case 'hide': browser.hide(id); return null;
        case 'navigate': browser.navigate(id, String(args.url ?? '')); return null;
        case 'back': case 'forward': case 'reload': case 'stop': browser.history(id, op); return null;
        case 'devtools': browser.devtools(id); return null;
        case 'external': browser.openExternal(id); return null;
        case 'capture': return await browser.capture(id);
        case 'destroy': browser.destroy(id); return null;
        case 'pause': browser.setPaused(id, args.paused === true); return null;
        case 'sync': return browser.sync(Array.isArray(args.ids) ? args.ids.filter((x): x is string => typeof x === 'string') : []);
        case 'list': return browser.list();
        default: throw new BrowserError('Unknown browser call.');
      }
    } catch (err) {
      // The page shows these; other errors are bugs and keep their stack in the main log.
      if (err instanceof BrowserError) return { error: err.message };
      throw err;
    }
  });
}

function showWindow(): void {
  if (!ready) return;
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'PodCode',
    // The dark theme's base colour (web/styles.css), so the window never flashes white.
    backgroundColor: '#171717',
    // MonoCode's window: no title bar, the traffic lights inside the left column's 40px header.
    // The page leaves room for them and drags the window by its headers (the `desktop` variant).
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 13 } } : {}),
    show: false,
    // window.podcodeDesktop: the update row and the integrated browser's controls
    // (electron/preload.cts). Browser tabs never get a preload.
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs') },
  });
  const opened = window;
  browser.attachWindow(opened);
  // Browser tabs outlive the window (agents keep using theirs while it is closed on macOS).
  opened.on('close', () => browser.detachWindow(opened));
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });
  // A localhost link (a dev server an agent mentions) opens in a browser tab beside; anything
  // else, and a Cmd-clicked localhost link, opens in the user's browser.
  window.webContents.setWindowOpenHandler(({ url, disposition }) => {
    openLink(url, disposition === 'background-tab');
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    if (new URL(event.url).origin === ORIGIN) return;
    event.preventDefault();
    openLink(event.url, false);
  });
  // Right-click: the usual edit commands in a text field, Copy on selected text. Paste runs the
  // page's own paste handling, so an image on the clipboard attaches in the composer.
  window.webContents.on('context-menu', (_event, params) => {
    const flags = params.editFlags;
    const items: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'cut', enabled: flags.canCut },
          { role: 'copy', enabled: flags.canCopy },
          // Left enabled: Chromium reports no paste for a clipboard that holds only an image.
          { role: 'paste' },
          { type: 'separator' },
          { role: 'selectAll', enabled: flags.canSelectAll },
        ]
      : params.selectionText.trim()
        ? [{ role: 'copy' }]
        : [];
    if (items.length && window) Menu.buildFromTemplate(items).popup({ window });
  });
  void window.loadURL(ORIGIN);
}

/** Only the PodCode page itself may use the desktop bridge. */
function fromApp(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  try {
    return new URL(event.senderFrame?.url ?? '').origin === ORIGIN;
  } catch {
    return false;
  }
}

/** The bridge behind window.podcodeDesktop.updates (electron/preload.cts). */
function serveUpdates(): void {
  ipcMain.handle('updates:get', event => (fromApp(event) ? updateSnapshot() : null));
  ipcMain.handle('updates:install', event => (fromApp(event) ? installUpdate() : undefined));
  ipcMain.handle('updates:check', event => (fromApp(event) ? checkForUpdates(true) : undefined));
  onUpdateChange(snapshot => window?.webContents.send('updates:changed', snapshot));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    // On macOS the agents keep working with the window closed, like other Mac apps.
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', stopSuperBridge);
  app.on('before-quit', (event) => {
    if (!server) {
      // The quit goes through, and Electron closes the windows next. Close the browser tabs
      // first, or the window's close parks them in a new holder window and the quit never ends.
      browser.shutdown();
      return;
    }
    event.preventDefault();
    if (quitting) return;
    // Stop the agents, then quit again. The second quit goes through normally (no server left), so
    // the quit events fire and a downloaded update installs on the way out.
    void stopServer().then(() => app.quit());
  });
  // Installing an update closes the windows before before-quit fires. The holder is macOS only.
  if (process.platform === 'darwin') nativeUpdater.on('before-quit-for-update', () => browser.shutdown());
  void app.whenReady().then(async () => {
    setMenu();
    serveUpdates();
    if (app.isPackaged) useLoginShellPath();
    // A packaged app gets its icon from the bundle; running from source would show Electron's.
    else app.dock?.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
    registerBrowserIpc();
    // The SuperAgent's menu bar item and system-wide quick bar shortcut.
    quick = new QuickWindow({ url: `${ORIGIN}/quick.html`, preload: path.join(import.meta.dirname, 'preload.cjs') });
    startSuperBridge({ window: () => window, show: showWindow, fromApp, quick });
    // app_screenshot: the window as the user sees it, never focused or raised for it.
    bridge.onAppShot(args => captureApp({ main: () => window, quick: () => quick?.visible() ?? null }, args));
    if (await serverAnswers()) {
      markReady();
      bridge.useSocket();
      watchAttachedServer();
    } else startServer();
    void startUpdater({ window: () => window, stopServer });
  });
}
