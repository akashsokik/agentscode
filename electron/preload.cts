/**
 * The desktop app's bridge to the page: `window.agentscodeDesktop.updates`, which the sidebar's
 * update row reads (web/sidebar/SidebarUpdate.tsx). The page is the AgentsCode server's own UI on
 * 127.0.0.1; main.ts answers only that origin. CommonJS because sandboxed preload scripts cannot
 * be ES modules; tsc compiles this .cts to preload.cjs.
 */
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

contextBridge.exposeInMainWorld('agentscodeDesktop', { updates });
