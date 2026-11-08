/**
 * The app window's bridge to main, as `window.agentscode`. Only the AgentsCode page gets it:
 * browser tabs run without a preload. CommonJS (.cts), because a sandboxed preload cannot be an
 * ES module.
 */
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

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
