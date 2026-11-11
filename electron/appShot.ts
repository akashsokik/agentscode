/**
 * app_screenshot: a PNG of Podcode's own window as the user sees it, for agents that check UI
 * work (the SuperAgent, reviewers, testers). It never focuses or raises a window. Asked to open an
 * agent's tab or a channel first, it changes what the main window shows, which its tool says.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { BrowserError } from './browser.ts';
import type { SuperCommand } from '../shared/superAgent.ts';

/** How long the page gets to show a tab it was asked to open before the capture. */
const SETTLE_MS = 700;

export interface AppShotDeps {
  main(): BrowserWindow | null;
  /** The quick window, only while it is showing. */
  quick(): BrowserWindow | null;
}

export async function captureApp(deps: AppShotDeps, args: Record<string, unknown>): Promise<{ path: string; width: number; height: number; window: 'main' | 'quick' }> {
  const file = typeof args.path === 'string' ? args.path : '';
  // The server picks the path, in the agent's home under screens/; anything else is refused.
  if (!path.isAbsolute(file) || !file.endsWith('.png') || file.includes('\0') || path.basename(path.dirname(file)) !== 'screens') {
    throw new BrowserError('The screenshot path must be an absolute .png path in a screens folder.');
  }
  const which = args.window === 'quick' ? 'quick' : 'main';
  const win = which === 'quick' ? deps.quick() : deps.main();
  if (!win || win.isDestroyed()) {
    throw new BrowserError(which === 'quick' ? 'The quick window is not open, so there is nothing to capture.' : 'The Podcode window is closed. Ask the user to open it, then try again.');
  }
  if (which === 'main') {
    const command: SuperCommand | null = typeof args.openAgent === 'string' ? { type: 'openAgent', agentId: args.openAgent }
      : typeof args.openChannel === 'string' ? { type: 'openChannel', channelId: args.openChannel } : null;
    if (command) {
      // The page switches tabs; the window is neither focused nor raised.
      win.webContents.send('super:command', command);
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    }
  }
  const image = await win.webContents.capturePage();
  if (image.isEmpty()) throw new BrowserError('The window is minimized or hidden, so the capture came out empty.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
  const { width, height } = image.getSize();
  return { path: file, width, height, window: which };
}
