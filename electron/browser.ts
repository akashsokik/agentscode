/**
 * The integrated browser. Each browser tab is a WebContentsView that main owns and lays over the
 * app window where the page's BrowserPane says its content box is. A tab nobody is looking at, or
 * one an agent opened while no window is open, stays alive unattached: it still loads, and the
 * agent tools (electron/cdp.ts) still read, click and capture it.
 *
 * Browser tabs share one session of their own, apart from the app's, with no preload, no Node, and
 * every permission prompt refused. They never load AgentsCode itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, session, shell, WebContentsView, type Input, type Session } from 'electron';
import { blockedReason, normalizeAddress, type BrowserEvent, type BrowserTabState, type ConsoleEntry } from '../shared/browser.ts';
import { BrowserError } from './browserError.ts';
import { Cdp } from './cdp.ts';

export { BrowserError };

export const BROWSER_PARTITION = 'persist:agentscode-browser';
/** The viewport an agent's tab has while no pane shows it. */
const DEFAULT_SIZE = { width: 1280, height: 800 };
const CONSOLE_LIMIT = 1000;
/** How long after an agent's last action its tab still reads as driven. */
const DRIVING_MS = 2500;
const OPEN_TIMEOUT_MS = 30_000;
const OP_TIMEOUT_MS = 10_000;
/** A tab no pane shows paints only now and then, so its screenshot may take a few tries. */
const SHOT_TIMEOUT_MS = 20_000;

export interface Rect { x: number; y: number; width: number; height: number }

interface Tab {
  id: string;
  view: WebContentsView;
  agentId: string | null;
  console: ConsoleEntry[];
  seq: number;
  errors: number;
  failure: string | null;
  status: number | null;
  shown: boolean;
  drivingUntil: number;
  drivingTimer?: NodeJS.Timeout;
  paused: boolean;
  /** When an agent last used the tab, to pick its most recent one. */
  usedAt: number;
  cdp: Cdp;
}

interface Options {
  /** The AgentsCode server's port, which browser tabs may never load. */
  appPort: number;
  window: () => BrowserWindow | null;
}

let nextId = 0;
const newId = () => `b${Date.now().toString(36)}${(nextId++).toString(36)}`;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserError(`${what} took longer than ${Math.round(ms / 1000)}s.`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, err => { clearTimeout(timer); reject(err); });
  });
}

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return png.length > 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : { width: 0, height: 0 };
}

/** Shortcuts the app keeps while a browser tab has the keyboard; the page runs them. */
function appShortcut(input: Input, mac: boolean): boolean {
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (input.control && !input.meta && !input.alt && input.code === 'Tab') return true;
  if (input.control && !input.meta && input.code === 'Backquote') return true;
  if (!mod) return false;
  if (input.shift) return ['BracketLeft', 'BracketRight', 'KeyB'].includes(input.code);
  if (input.alt) return input.code === 'KeyB';
  return ['KeyW', 'KeyK', 'KeyN', 'KeyB', 'KeyJ', 'Comma'].includes(input.code) || /^Digit[1-9]$/.test(input.code);
}

export class BrowserHost {
  private tabs = new Map<string, Tab>();
  private attachedTo: BrowserWindow | null = null;
  /**
   * Where tabs live while no app window is open (macOS keeps running with it closed): a window
   * that is never shown. A view in no window at all paints once and then stops, so screenshots of
   * it hang; in this one they do not. Elsewhere the app quits with its window, so there is none.
   */
  private holder: BrowserWindow | null = null;
  private configured = false;

  private options: Options;

  constructor(options: Options) {
    this.options = options;
  }

  private get session(): Session {
    const s = session.fromPartition(BROWSER_PARTITION);
    if (!this.configured) {
      this.configured = true;
      s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
      s.on('will-download', (_event, item) => {
        item.setSavePath(path.join(os.homedir(), 'Downloads', path.basename(item.getFilename()) || 'download'));
      });
      s.webRequest.onErrorOccurred(details => {
        if (details.error === 'net::ERR_ABORTED' || details.webContentsId === undefined) return;
        const tab = this.byContents(details.webContentsId);
        if (tab) this.log(tab, { level: 'error', source: 'network', text: `${details.error} ${details.method} ${details.url}`, url: details.url });
      });
      s.webRequest.onCompleted(details => {
        if (details.statusCode < 400 || details.webContentsId === undefined) return;
        const tab = this.byContents(details.webContentsId);
        if (tab) this.log(tab, { level: 'error', source: 'network', text: `${details.statusCode} ${details.method} ${details.url}`, url: details.url });
      });
    }
    return s;
  }

  private byContents(id: number): Tab | undefined {
    for (const tab of this.tabs.values()) if (!tab.view.webContents.isDestroyed() && tab.view.webContents.id === id) return tab;
    return undefined;
  }

  private send(event: BrowserEvent): void {
    const win = this.options.window();
    if (win && !win.isDestroyed()) win.webContents.send('browser:event', event);
  }

  state(tab: Tab): BrowserTabState {
    const wc = tab.view.webContents;
    const alive = !wc.isDestroyed();
    return {
      id: tab.id,
      url: alive ? wc.getURL() : '',
      title: alive ? wc.getTitle() : '',
      loading: alive && wc.isLoading(),
      canGoBack: alive && wc.navigationHistory.canGoBack(),
      canGoForward: alive && wc.navigationHistory.canGoForward(),
      errors: tab.errors,
      agentId: tab.agentId,
      driving: tab.drivingUntil > Date.now(),
      paused: tab.paused,
      failure: tab.failure,
    };
  }

  private emit(tab: Tab): void {
    this.send({ type: 'state', tab: this.state(tab) });
  }

  private log(tab: Tab, entry: Omit<ConsoleEntry, 'seq' | 'ts'>): void {
    tab.console.push({ ...entry, seq: ++tab.seq, ts: Date.now() });
    if (tab.console.length > CONSOLE_LIMIT) tab.console.splice(0, tab.console.length - CONSOLE_LIMIT);
    if (entry.level === 'error') {
      tab.errors++;
      this.emit(tab);
    }
  }

  private make(id: string, agentId: string | null): Tab {
    const view = new WebContentsView({
      webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    view.setBounds({ x: 0, y: 0, ...DEFAULT_SIZE });
    view.setVisible(false);
    const tab: Tab = { id, view, agentId, console: [], seq: 0, errors: 0, failure: null, status: null, shown: false, drivingUntil: 0, paused: false, usedAt: Date.now(), cdp: new Cdp(view.webContents) };
    const wc = view.webContents;
    const guard = (event: { preventDefault: () => void }, url: string) => {
      const reason = blockedReason(url, this.options.appPort);
      if (!reason) return;
      event.preventDefault();
      tab.failure = reason;
      this.emit(tab);
    };
    wc.on('will-navigate', event => guard(event, event.url));
    wc.on('will-redirect', event => guard(event, event.url));
    wc.on('will-frame-navigate', event => { if (!event.isMainFrame) guard(event, event.url); });
    wc.setWindowOpenHandler(({ url }) => {
      if (!blockedReason(url, this.options.appPort)) {
        const opened = this.create(newId(), url, tab.agentId);
        this.send({ type: 'opened', tab: this.state(opened), side: true });
      }
      return { action: 'deny' };
    });
    wc.on('did-start-loading', () => {
      tab.failure = null;
      this.emit(tab);
    });
    wc.on('did-stop-loading', () => this.emit(tab));
    wc.on('did-navigate', (_event, _url, code) => {
      tab.status = code > 0 ? code : null;
      tab.errors = 0;
      tab.cdp.forgetRefs();
      this.emit(tab);
    });
    wc.on('did-navigate-in-page', () => this.emit(tab));
    wc.on('page-title-updated', () => this.emit(tab));
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3: aborted, as by a new navigation
      tab.failure = description || `Error ${code}`;
      this.log(tab, { level: 'error', source: 'network', text: `${tab.failure} loading ${url}`, url });
      this.emit(tab);
    });
    wc.on('render-process-gone', (_event, details) => {
      tab.failure = `The page stopped (${details.reason}). Reload to try again.`;
      this.emit(tab);
    });
    wc.on('console-message', event => {
      // Electron's advice to app authors, printed into every page of an unpackaged app.
      if (event.message.startsWith('Electron Security Warning')) return;
      const level = event.level === 'warning' ? 'warn' : event.level === 'info' ? 'log' : event.level;
      this.log(tab, { level, source: 'console', text: event.message.slice(0, 4000), url: event.sourceId ? `${event.sourceId}:${event.lineNumber}` : undefined });
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mac = process.platform === 'darwin';
      const mod = mac ? input.meta && !input.control : input.control && !input.meta;
      if (mod && !input.shift && !input.alt && input.code === 'KeyR') {
        event.preventDefault();
        wc.reload();
      } else if (mod && !input.shift && !input.alt && input.code === 'KeyL') {
        event.preventDefault();
        this.send({ type: 'focus-address', id: tab.id });
      } else if (mod && !input.shift && !input.alt && (input.code === 'BracketLeft' || input.code === 'BracketRight')) {
        event.preventDefault();
        if (input.code === 'BracketLeft') wc.navigationHistory.goBack();
        else wc.navigationHistory.goForward();
      } else if (appShortcut(input, mac)) {
        event.preventDefault();
        this.send({ type: 'shortcut', key: input.key, code: input.code, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift });
      }
    });
    wc.on('focus', () => this.send({ type: 'focus', id: tab.id }));
    this.tabs.set(id, tab);
    this.parent()?.contentView.addChildView(view);
    return tab;
  }

  /** Loads a URL in a tab; resolves once the main document has loaded, with its status. */
  private async load(tab: Tab, url: string): Promise<void> {
    const reason = blockedReason(url, this.options.appPort);
    if (reason) throw new BrowserError(reason);
    tab.failure = null;
    try {
      await tab.view.webContents.loadURL(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ERR_ABORTED/.test(message)) return; // replaced by a newer navigation, or a download
      tab.failure = tab.failure ?? message.replace(/\s*\(-?\d+\)\s*loading.*$/, '');
      this.emit(tab);
      throw new BrowserError(`Could not load ${url}: ${tab.failure}${/localhost|127\.0\.0\.1/.test(url) ? '. Is the dev server running?' : ''}`);
    }
  }

  // ---- The page's side: tabs the user sees ----

  /** Creates the tab, or returns the one with this id. A tab the page restores reloads its last URL. */
  create(id: string, url: string, agentId: string | null = null): Tab {
    const existing = this.tabs.get(id);
    if (existing) return existing;
    const tab = this.make(id, agentId);
    const target = url ? normalizeAddress(url) : null;
    if (target) void this.load(tab, target).catch(() => {});
    return tab;
  }

  get(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new BrowserError('That browser tab is closed.');
    return tab;
  }

  /** Shows a tab at a rect in the window's page coordinates; the page's zoom is applied here. */
  show(id: string, rect: Rect): void {
    const tab = this.get(id);
    const win = this.attachedTo;
    if (!win || win.isDestroyed()) return;
    const zoom = win.webContents.getZoomFactor();
    const bounds = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    };
    tab.view.setBounds(bounds);
    if (!tab.shown) {
      tab.shown = true;
      tab.view.setVisible(true);
    }
  }

  hide(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab?.shown) return;
    tab.shown = false;
    tab.view.setVisible(false);
  }

  navigate(id: string, input: string): void {
    const tab = this.get(id);
    const url = normalizeAddress(input);
    if (!url) throw new BrowserError('Type an address like localhost:3000 or https://example.com.');
    void this.load(tab, url).catch(() => {});
  }

  history(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): void {
    const wc = this.get(id).view.webContents;
    if (action === 'back') wc.navigationHistory.goBack();
    else if (action === 'forward') wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else wc.stop();
  }

  devtools(id: string): void {
    this.get(id).view.webContents.openDevTools({ mode: 'detach' });
  }

  openExternal(id: string): void {
    const url = this.get(id).view.webContents.getURL();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  }

  /** A still of the tab as shown, for the page to draw while a dialog covers it. */
  async capture(id: string): Promise<string | null> {
    const tab = this.get(id);
    if (!tab.shown) return null;
    try {
      const image = await tab.view.webContents.capturePage();
      return image.isEmpty() ? null : image.toDataURL();
    } catch {
      return null;
    }
  }

  destroy(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    clearTimeout(tab.drivingTimer);
    tab.cdp.detach();
    const parent = this.parent(false);
    if (parent) parent.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.send({ type: 'closed', id });
  }

  /**
   * The page's tabs after a load: closes the user's tabs it no longer has, and returns agents'
   * tabs it does not have yet (opened while the window was closed) for it to add.
   */
  sync(ids: string[]): BrowserTabState[] {
    const known = new Set(ids);
    const missing: BrowserTabState[] = [];
    for (const tab of [...this.tabs.values()]) {
      if (known.has(tab.id)) continue;
      if (tab.agentId) missing.push(this.state(tab));
      else this.destroy(tab.id);
    }
    return missing;
  }

  setPaused(id: string, paused: boolean): void {
    const tab = this.get(id);
    tab.paused = paused;
    this.emit(tab);
  }

  list(): BrowserTabState[] {
    return [...this.tabs.values()].map(tab => this.state(tab));
  }

  /** The window tabs belong in now: the app window, else (on macOS) the hidden holder. */
  private parent(create = true): BrowserWindow | null {
    if (this.attachedTo && !this.attachedTo.isDestroyed()) return this.attachedTo;
    if (this.holder && !this.holder.isDestroyed()) return this.holder;
    if (!create || process.platform !== 'darwin') return null;
    this.holder = new BrowserWindow({ show: false, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
    return this.holder;
  }

  /** Puts every tab in a new window (the previous one closed, or this is the first). */
  attachWindow(win: BrowserWindow): void {
    const from = this.parent(false);
    this.attachedTo = win;
    for (const tab of this.tabs.values()) {
      tab.shown = false;
      tab.view.setVisible(false);
      if (from && from !== win) from.contentView.removeChildView(tab.view);
      win.contentView.addChildView(tab.view);
    }
    if (this.holder && !this.holder.isDestroyed()) this.holder.destroy();
    this.holder = null;
  }

  /** Takes the tabs out of a closing window so they outlive it, into the holder on macOS. */
  detachWindow(win: BrowserWindow): void {
    if (this.attachedTo !== win) return;
    this.attachedTo = null;
    const holder = this.tabs.size ? this.parent() : null;
    for (const tab of this.tabs.values()) {
      tab.shown = false;
      tab.view.setVisible(false);
      if (!win.isDestroyed()) win.contentView.removeChildView(tab.view);
      holder?.contentView.addChildView(tab.view);
      tab.view.setBounds({ x: 0, y: 0, ...DEFAULT_SIZE });
    }
  }

  closeAll(): void {
    for (const id of [...this.tabs.keys()]) this.destroy(id);
    if (this.holder && !this.holder.isDestroyed()) this.holder.destroy();
    this.holder = null;
  }

  // ---- The agents' side (electron/bridge.ts) ----

  private agentTab(agentId: string, tabId: unknown): Tab {
    if (typeof tabId !== 'string' || !tabId) throw new BrowserError('Give the tab_id that browser_open returned.');
    const tab = this.tabs.get(tabId);
    if (!tab) throw new BrowserError(`No browser tab ${tabId}. It may have been closed; call browser_open to open one.`);
    if (tab.agentId !== agentId) throw new BrowserError('That tab belongs to someone else. Call browser_open to open your own.');
    return tab;
  }

  private drive(tab: Tab, input: boolean): void {
    if (input && tab.paused) throw new BrowserError('The user took over this tab. Wait for them to hand it back, or ask them to.');
    tab.usedAt = Date.now();
    tab.drivingUntil = Date.now() + DRIVING_MS;
    clearTimeout(tab.drivingTimer);
    tab.drivingTimer = setTimeout(() => this.emit(tab), DRIVING_MS + 50);
    this.emit(tab);
  }

  /** Settles after an action: waits for a navigation it started to finish loading. */
  private async settle(tab: Tab): Promise<{ url: string; title: string }> {
    await new Promise(resolve => setTimeout(resolve, 250));
    const wc = tab.view.webContents;
    if (wc.isLoading()) {
      await withTimeout(new Promise<void>(resolve => wc.once('did-stop-loading', () => resolve())), OP_TIMEOUT_MS, 'The page').catch(() => {});
    }
    return { url: wc.getURL(), title: wc.getTitle() };
  }

  async agent(agentId: string, op: string, args: Record<string, unknown>): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      switch (op) {
        case 'open': {
          const url = typeof args.url === 'string' ? normalizeAddress(args.url) : null;
          if (!url) throw new BrowserError('Give a URL like http://localhost:3000 or https://example.com.');
          const reason = blockedReason(url, this.options.appPort);
          if (reason) throw new BrowserError(reason);
          let tab: Tab | undefined;
          if (args.tab_id !== undefined) tab = this.agentTab(agentId, args.tab_id);
          else tab = [...this.tabs.values()].filter(t => t.agentId === agentId).sort((a, b) => b.usedAt - a.usedAt)[0];
          if (tab?.paused) throw new BrowserError('The user took over this tab. Wait for them to hand it back, or ask them to.');
          const fresh = !tab;
          tab ??= this.make(newId(), agentId);
          this.drive(tab, true);
          if (fresh) this.send({ type: 'opened', tab: this.state(tab), side: true });
          await this.load(tab, url);
          const wc = tab.view.webContents;
          return { tab_id: tab.id, url: wc.getURL(), title: wc.getTitle(), status: tab.status };
        }
        case 'list':
          return { tabs: [...this.tabs.values()].filter(t => t.agentId === agentId).map(t => ({ tab_id: t.id, url: t.view.webContents.getURL(), title: t.view.webContents.getTitle() })) };
        case 'close': {
          const tab = this.agentTab(agentId, args.tab_id);
          this.destroy(tab.id);
          return { closed: true };
        }
        case 'snapshot': {
          const tab = this.agentTab(agentId, args.tab_id);
          this.drive(tab, false);
          const max = typeof args.max_chars === 'number' ? Math.min(Math.max(1000, args.max_chars), 100_000) : 20_000;
          const { text, truncated } = await tab.cdp.snapshot(max);
          const wc = tab.view.webContents;
          return { tab_id: tab.id, url: wc.getURL(), title: wc.getTitle(), text, truncated };
        }
        case 'screenshot': {
          const tab = this.agentTab(agentId, args.tab_id);
          const file = typeof args.path === 'string' ? args.path : '';
          if (!path.isAbsolute(file) || !file.endsWith('.png')) throw new BrowserError('The screenshot path must be an absolute .png path.');
          this.drive(tab, false);
          const { png, fullPage } = await tab.cdp.screenshot(args.full_page === true);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, png);
          return { path: file, ...pngSize(png), ...(args.full_page === true && !fullPage ? { note: 'The full page could not be captured; this is the visible part.' } : {}) };
        }
        case 'console': {
          const tab = this.agentTab(agentId, args.tab_id);
          const since = typeof args.since === 'number' ? args.since : 0;
          const entries = tab.console.filter(e => e.seq > since).slice(0, 200);
          return { entries, next: entries.at(-1)?.seq ?? Math.max(since, tab.seq) };
        }
        case 'click': {
          const tab = this.agentTab(agentId, args.tab_id);
          this.drive(tab, true);
          const input = await tab.cdp.click(String(args.ref ?? ''));
          return { ...(await this.settle(tab)), input };
        }
        case 'type': {
          const tab = this.agentTab(agentId, args.tab_id);
          this.drive(tab, true);
          const input = await tab.cdp.type(String(args.ref ?? ''), String(args.text ?? ''), args.submit === true);
          return { ...(await this.settle(tab)), input };
        }
        case 'press': {
          const tab = this.agentTab(agentId, args.tab_id);
          this.drive(tab, true);
          const input = await tab.cdp.press(String(args.key ?? ''));
          return { ...(await this.settle(tab)), input };
        }
        case 'eval': {
          const tab = this.agentTab(agentId, args.tab_id);
          this.drive(tab, true);
          return await tab.cdp.evaluate(String(args.expression ?? ''));
        }
        default:
          throw new BrowserError(`Unknown browser operation ${op}.`);
      }
    };
    return withTimeout(run(), op === 'open' ? OPEN_TIMEOUT_MS : op === 'screenshot' ? SHOT_TIMEOUT_MS : OP_TIMEOUT_MS, `browser ${op}`);
  }

  agentRemoved(agentId: string): void {
    for (const tab of [...this.tabs.values()]) if (tab.agentId === agentId) this.destroy(tab.id);
  }
}
