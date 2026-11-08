/**
 * The app window's bridges to main. Only the AgentsCode page gets them: browser tabs run without a
 * preload, and main answers only the app window. CommonJS (.cts), because a sandboxed preload cannot
 * be an ES module; tsc compiles this to preload.cjs.
 *
 * - window.agentscodeDesktop.updates: the sidebar's update row (web/sidebar/SidebarUpdate.tsx).
 * - window.agentscode.browser: the integrated browser's controls (web/browser.ts).
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

contextBridge.exposeInMainWorld('agentscode', {
  browser: {
    call: (op: string, args?: unknown): Promise<unknown> => ipcRenderer.invoke('browser', op, args),
    onEvent: (listener: (event: unknown) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown) => listener(payload);
      ipcRenderer.on('browser:event', handler);
      return () => ipcRenderer.removeListener('browser:event', handler);
    },
  },
});
