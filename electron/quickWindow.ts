/**
 * The SuperAgent's floating quick composer (web/quick): a small window over whatever app is in
 * front, opened by the system-wide shortcut or the menu bar. On macOS it is a non-activating panel,
 * so PodCode's main window stays where it is and no Space switches. Frameless and clear: the
 * card draws the only surface. It opens on the screen the pointer is on, takes the card's height,
 * and hides on Esc or when it loses focus, keeping its draft for next time.
 */
import { BrowserWindow, screen } from 'electron';
import { QUICK_MARGIN, QUICK_WIDTH } from '../shared/superAgent.ts';

/** Before the page measures its card. */
const START_HEIGHT = 220;
const MAX_HEIGHT = 720;

export class QuickWindow {
  private win: BrowserWindow | null = null;
  private url: string;
  private preload: string;

  constructor(options: { url: string; preload: string }) {
    this.url = options.url;
    this.preload = options.preload;
  }

  /** The window while it shows, for a screenshot; null when hidden or not made. */
  visible(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() && this.win.isVisible() ? this.win : null;
  }

  /** The window's web contents, so the bridge can tell its messages from the main window's. */
  owns(contents: Electron.WebContents): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.webContents === contents);
  }

  private create(): BrowserWindow {
    const mac = process.platform === 'darwin';
    const win = new BrowserWindow({
      width: QUICK_WIDTH,
      height: START_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false, // the card draws its own
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // A non-activating panel on macOS: typing goes to it without bringing PodCode forward.
      ...(mac ? { type: 'panel' as const } : {}),
      webPreferences: { preload: this.preload },
    });
    win.setAlwaysOnTop(true, 'floating');
    // A macOS panel already shows on every Space and over full-screen apps; setVisibleOnAllWorkspaces
    // there would switch the process type and blink PodCode's windows and Dock icon.
    if (!mac) win.setVisibleOnAllWorkspaces(true);
    // Clicking anywhere else puts it away; the draft stays in the page.
    win.on('blur', () => {
      if (!win.webContents.isDevToolsOpened()) win.hide();
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });
    void win.loadURL(this.url);
    return win;
  }

  /** Centred near the top of the screen the pointer is on, as Spotlight sits, and never past its bottom. */
  private place(win: BrowserWindow): void {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const height = Math.min(win.getSize()[1], area.height);
    const y = Math.min(area.y + area.height * 0.18, area.y + area.height - Math.min(MAX_HEIGHT, area.height));
    win.setBounds({ x: Math.round(area.x + (area.width - QUICK_WIDTH) / 2), y: Math.round(Math.max(area.y, y)), width: QUICK_WIDTH, height });
  }

  /** Make the window hidden ahead of time, so the first press opens it at once, already connected. */
  prepare(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create();
    const win = this.win;
    this.place(win);
    const reveal = () => {
      win.show();
      // A panel takes the keyboard on show; elsewhere it has to be focused.
      if (process.platform !== 'darwin') win.focus();
      win.webContents.send('quick:shown');
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
    else reveal();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.hide();
    else this.show();
  }

  /** The page measured its card: the window takes that height, its top edge fixed. */
  fit(height: number): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !Number.isFinite(height)) return;
    const next = Math.max(80, Math.min(MAX_HEIGHT, Math.ceil(height + QUICK_MARGIN * 2)));
    const bounds = win.getBounds();
    if (bounds.height !== next) win.setBounds({ ...bounds, height: next });
  }
}
