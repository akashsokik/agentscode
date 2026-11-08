/**
 * The desktop app's bridge to the page, as `window.agentscodeDesktop`:
 * - `updates`, which the sidebar's update row reads (web/sidebar/SidebarUpdate.tsx);
 * - `browser`, the integrated browser's controls and events (web/browser.ts).
 * The page is the AgentsCode server's own UI on 127.0.0.1; main.ts answers only that origin, and
 * browser tabs run without any preload. CommonJS because sandboxed preload scripts cannot be ES
 * modules; tsc compiles this .cts to preload.cjs.
 */
import type { DesktopBrowser } from '../shared/browser.ts';
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

contextBridge.exposeInMainWorld('agentscodeDesktop', { updates, browser });
