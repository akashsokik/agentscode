/**
 * Just enough of Electron for electron/browser.ts to run under `node --test`: windows, views and
 * a session that record what happens to them. tests/browserQuit.test.ts points the `electron`
 * import here with a module resolve hook.
 */
type Listener = (...args: unknown[]) => void;

class Emitter {
  private listeners = new Map<string, Listener[]>();
  on(name: string, listener: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return this;
  }
  once(name: string, listener: Listener): this { return this.on(name, listener); }
  emit(name: string, ...args: unknown[]): void { for (const l of this.listeners.get(name) ?? []) l(...args); }
}

class FakeWebContents extends Emitter {
  static next = 1;
  id = FakeWebContents.next++;
  destroyed = false;
  debugger = new Emitter();
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };
  setWindowOpenHandler(): void {}
  isDestroyed(): boolean { return this.destroyed; }
  close(): void { this.destroyed = true; }
  getURL(): string { return ''; }
  getTitle(): string { return ''; }
  isLoading(): boolean { return false; }
  loadURL(): Promise<void> { return Promise.resolve(); }
  send(): void {}
}

class FakeContentView {
  children: unknown[] = [];
  addChildView(view: unknown): void { this.children.push(view); }
  removeChildView(view: unknown): void { this.children = this.children.filter(v => v !== view); }
}

export class BrowserWindow extends Emitter {
  /** Every window made, in order, so a test can see a holder appear. */
  static made: BrowserWindow[] = [];
  options: unknown;
  destroyed = false;
  contentView = new FakeContentView();
  webContents = new FakeWebContents();
  constructor(options: unknown = {}) {
    super();
    this.options = options;
    BrowserWindow.made.push(this);
  }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
}

export class WebContentsView {
  webContents = new FakeWebContents();
  setBounds(): void {}
  setVisible(): void {}
}

const fakeSession = {
  setPermissionRequestHandler(): void {},
  setPermissionCheckHandler(): void {},
  on(): void {},
  webRequest: { onErrorOccurred(): void {}, onCompleted(): void {} },
};

export const session = { fromPartition: () => fakeSession };
export const shell = { openExternal: async () => {} };
export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true }) };
