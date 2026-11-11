/**
 * The desktop app's bridge to the page, as `window.agentscodeDesktop`:
 * - `updates`, which the sidebar's update row reads (web/sidebar/SidebarUpdate.tsx);
 * - `browser`, the integrated browser's controls and events (web/browser.ts);
 * - `super`, the SuperAgent's menu bar item and system-wide shortcut (web/super.ts, electron/superTray.ts).
 * The page is the Podcode server's own UI on 127.0.0.1; main.ts answers only that origin, and
 * browser tabs run without any preload. CommonJS because sandboxed preload scripts cannot be ES
 * modules; tsc compiles this .cts to preload.cjs.
 */
import type { DesktopBrowser } from '../shared/browser.ts';
import type { DesktopQuick, DesktopSuper, SuperCommand } from '../shared/superAgent.ts';
import type { DesktopUpdates, UpdateSnapshot } from '../shared/updates.ts';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const updates: DesktopUpdates = {
  get: () => ipcRenderer.invoke('updates:get') as Promise<UpdateSnapshot>,
  install: () => ipcRenderer.invoke('updates:install') as Promise<void>,
  onChange(callback) {
    const listener = (_event: unknown, snapshot: UpdateSnapshot) => callback(snapshot);
    ipcRenderer.on('updates:changed', listener);
    return () => {
      ipcRenderer.removeListener('updates:changed', listener);
    };
  },
  check: () => ipcRenderer.invoke('updates:check') as Promise<void>,
  onShowAbout(callback) {
    const listener = () => callback();
    ipcRenderer.on('updates:about', listener);
    return () => {
      ipcRenderer.removeListener('updates:about', listener);
    };
  },
};

const browser: DesktopBrowser = {
  call: (op, args) => ipcRenderer.invoke('browser:call', op, args),
  onEvent(callback) {
    const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on('browser:event', listener);
    return () => {
      ipcRenderer.removeListener('browser:event', listener);
    };
  },
};

const superAgent: DesktopSuper = {
  status: state => ipcRenderer.send('super:status', state),
  focus: () => ipcRenderer.send('super:focus'),
  onCommand(callback) {
    const listener = (_event: unknown, command: SuperCommand) => callback(command);
    ipcRenderer.on('super:command', listener);
    return () => {
      ipcRenderer.removeListener('super:command', listener);
    };
  },
};

/** The floating quick composer's window; main answers these only from that window. */
const quick: DesktopQuick = {
  fit: height => ipcRenderer.send('quick:fit', height),
  hide: () => ipcRenderer.send('quick:hide'),
  openInMain: agentId => ipcRenderer.send('quick:open', agentId),
  onShow(callback) {
    const listener = () => callback();
    ipcRenderer.on('quick:shown', listener);
    return () => {
      ipcRenderer.removeListener('quick:shown', listener);
    };
  },
};

contextBridge.exposeInMainWorld('agentscodeDesktop', { updates, browser, super: superAgent, quick });
