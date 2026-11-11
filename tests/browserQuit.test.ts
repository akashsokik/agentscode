import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// electron/browser.ts imports 'electron', which under plain Node is only the path to its binary:
// resolve it to tests/fakeElectron.ts instead, for this file's imports.
const fake = pathToFileURL(path.join(import.meta.dirname, 'fakeElectron.ts')).href;
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron' ? { url: fake, shortCircuit: true } : next(specifier, context);
  },
});

interface FakeWindow { destroyed: boolean; contentView: { children: unknown[] }; isDestroyed(): boolean; destroy(): void }
interface Host {
  create(id: string, url: string, agentId?: string | null): { view: { webContents: { isDestroyed(): boolean } } };
  list(): { id: string }[];
  attachWindow(win: FakeWindow): void;
  detachWindow(win: FakeWindow): void;
  shutdown(): void;
}

// Loaded by path so the server typecheck does not take in the desktop code.
const browserModule = path.join(import.meta.dirname, '..', 'electron', 'browser.ts');
const { BrowserHost } = (await import(browserModule)) as { BrowserHost: new (options: unknown) => Host };
const { BrowserWindow } = (await import(fake)) as { BrowserWindow: { new (): FakeWindow; made: FakeWindow[] } };

const darwin = process.platform === 'darwin';

function hostWithWindow() {
  const win = new BrowserWindow();
  const host = new BrowserHost({ appPort: 4320, window: () => win });
  host.attachWindow(win);
  return { host, win };
}

test('without shutdown, closing the app window with a tab open parks the tab in a new holder window (the hang)', { skip: !darwin && 'the holder is macOS only' }, () => {
  const { host, win } = hostWithWindow();
  host.create('t1', '');
  const before = BrowserWindow.made.length;
  host.detachWindow(win);
  const holder = BrowserWindow.made[before];
  assert.ok(holder, 'a holder window was made');
  assert.equal(holder.isDestroyed(), false, 'and it stays: Electron never sees its last window close');
  assert.equal(holder.contentView.children.length, 1);
});

test('shutdown closes every tab and the holder, and no holder appears as the window closes', { skip: !darwin && 'the holder is macOS only' }, () => {
  const { host, win } = hostWithWindow();
  const a = host.create('t1', '');
  const b = host.create('t2', '', 'agent-1');
  // The window closed earlier, so the tabs already live in a holder.
  host.detachWindow(win);
  const holder = BrowserWindow.made.at(-1)!;
  assert.equal(holder.isDestroyed(), false);

  host.shutdown();
  assert.deepEqual(host.list(), [], 'no tabs left');
  assert.equal(a.view.webContents.isDestroyed(), true);
  assert.equal(b.view.webContents.isDestroyed(), true);
  assert.equal(holder.isDestroyed(), true, 'the holder is closed');

  // A window reopened and closing again during the quit: nothing is parked, no new holder.
  const again = new BrowserWindow();
  host.attachWindow(again);
  const count = BrowserWindow.made.length;
  host.detachWindow(again);
  assert.equal(BrowserWindow.made.length, count, 'no holder made while quitting');
});

test('while quitting, no new tab can be made', () => {
  const { host } = hostWithWindow();
  host.shutdown();
  assert.throws(() => host.create('late', ''), /PodCode is quitting/);
  assert.deepEqual(host.list(), []);
});

test('a window closing while quitting with tabs still open makes no holder', { skip: !darwin && 'the holder is macOS only' }, () => {
  const { host, win } = hostWithWindow();
  host.create('t1', '');
  // before-quit runs shutdown before Electron closes the windows; then the window's close detaches.
  host.shutdown();
  const count = BrowserWindow.made.length;
  host.detachWindow(win);
  assert.equal(BrowserWindow.made.length, count);
});
