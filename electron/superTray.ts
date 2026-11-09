/**
 * The SuperAgent outside the window: a menu bar item with what it is doing and the questions it
 * waits on you for, and a system-wide shortcut for its quick bar. The page keeps the menu bar
 * current (window.agentscodeDesktop.super.status) and gets the commands back (web/super.ts).
 */
import { globalShortcut, ipcMain, Menu, nativeImage, Tray, type BrowserWindow, type IpcMainEvent, type MenuItemConstructorOptions } from 'electron';
import { SUPER_GLOBAL_ACCELERATOR, type SuperCommand, type SuperTrayState } from '../shared/superAgent.ts';

interface Options {
  window: () => BrowserWindow | null;
  /** Show the window, making it if it was closed. */
  show: () => void;
  /** Only the AgentsCode page may drive the menu bar. */
  fromApp: (event: IpcMainEvent) => boolean;
}

/**
 * The menu bar icon, drawn here so nothing has to ship beside the app: AgentsCode's 2x2 grid, the
 * top-left and bottom-right cells solid and the others faint, as a template image macOS tints.
 */
function trayIcon(): Electron.NativeImage {
  const size = 36; // 18pt at 2x
  const pad = 2;
  const cell = 14;
  const gap = 4;
  const pixels = Buffer.alloc(size * size * 4);
  const fill = (x0: number, y0: number, alpha: number) => {
    for (let y = y0; y < y0 + cell; y++) for (let x = x0; x < x0 + cell; x++) pixels.writeUInt32BE(alpha, (y * size + x) * 4); // BGRA: black, alpha last
  };
  const far = pad + cell + gap;
  fill(pad, pad, 255);
  fill(far, far, 255);
  fill(far, pad, 80);
  fill(pad, far, 80);
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

export function startSuperBridge(options: Options): void {
  let tray: Tray | null = null;

  /** Bring the window forward and hand the page a command, once the page is there to take it. */
  const send = (command: SuperCommand) => {
    options.show();
    const window = options.window();
    if (!window) return;
    const deliver = () => window.webContents.send('super:command', command);
    // A window made just now has to load the page, and the page to start listening, first.
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', () => setTimeout(deliver, 800));
    else deliver();
  };

  const render = (state: SuperTrayState | null) => {
    if (!state) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      tray = new Tray(trayIcon());
      tray.on('click', () => tray?.popUpContextMenu());
    }
    tray.setTitle(state.asks.length ? String(state.asks.length) : '');
    tray.setToolTip(`SuperAgent: ${state.label}`);
    const items: MenuItemConstructorOptions[] = [
      { label: `SuperAgent: ${state.label}`, enabled: false },
      { type: 'separator' },
      ...state.asks.slice(0, 5).map((ask): MenuItemConstructorOptions => ({ label: ask.question.length > 70 ? `${ask.question.slice(0, 69)}…` : ask.question, click: () => send({ type: 'open' }) })),
      ...(state.asks.length ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
      { label: 'Ask the SuperAgent…', accelerator: SUPER_GLOBAL_ACCELERATOR, click: () => send({ type: 'quick' }) },
      { label: 'Open the SuperAgent', click: () => send({ type: 'open' }) },
      { label: 'Show AgentsCode', click: () => options.show() },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(items));
  };

  ipcMain.on('super:status', (event, state: SuperTrayState | null) => {
    if (!options.fromApp(event)) return;
    render(state && typeof state.label === 'string' && Array.isArray(state.asks) ? state : null);
  });
  ipcMain.on('super:focus', (event) => {
    if (options.fromApp(event)) options.show();
  });

  // Another app may hold the keys already; the quick bar still works inside the window.
  if (!globalShortcut.register(SUPER_GLOBAL_ACCELERATOR, () => send({ type: 'quick' }))) {
    console.warn(`[super] ${SUPER_GLOBAL_ACCELERATOR} is taken by another app; the SuperAgent's quick bar works inside AgentsCode only.`);
  }
}

export function stopSuperBridge(): void {
  globalShortcut.unregisterAll();
}
