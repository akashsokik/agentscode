import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineInfo } from '../shared/types.ts';

// The desktop app (electron/main.ts) passes this in. It is removed from the environment
// so the commands agents run never inherit it.
function takeEnv(name: string): string | undefined {
  const value = process.env[name];
  delete process.env[name];
  return value || undefined;
}
const desktopNode = takeEnv('AGENTSCODE_NODE');

export const PORT = Number(process.env.PORT ?? 4320);
export const HOST = '127.0.0.1';
/** The Vite dev server's port (vite.config.ts), whose pages call the API through its proxy during `npm run dev`. */
export const DEV_WEB_PORT = 5174;
/** Set by the desktop app when it starts this server itself; then no dev page is expected. */
export const IN_DESKTOP_APP = Boolean(process.env.AGENTSCODE_NODE);
export const DATA_DIR = process.env.AGENTSCODE_HOME ?? path.join(os.homedir(), '.agentscode');
export const ROOT_DIR = path.resolve(import.meta.dirname, '..');
export const DIST_DIR = path.join(ROOT_DIR, 'dist');
/** The stdio MCP server each agent process starts to reach the comms tools. */
export const COMMS_MCP_ENTRY = path.join(ROOT_DIR, 'server', 'comms', `mcp${path.extname(import.meta.filename)}`);
/** The MCP server name. It appears in three places that must agree: the Claude mcpServers key,
 * the allowedTools prefix and the Codex -c mcp_servers.<name> override. */
export const COMMS_SERVER = 'agentscode';

/**
 * Runs this app's own Node scripts (the comms MCP server) as agent child processes. In the
 * desktop app the runtime is Electron, which only behaves as plain Node when asked to.
 */
export const NODE_RUNTIME: { command: string; env: Record<string, string> } = desktopNode
  ? { command: desktopNode, env: { ELECTRON_RUN_AS_NODE: '1' } }
  : { command: process.execPath, env: {} };

/** Close an idle Claude process after this long; the next message resumes the session. */
export const IDLE_PROCESS_MS = 20 * 60 * 1000;

const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

/** Find an executable on PATH, plus the usual install locations a GUI-launched shell may miss. */
export function findBinary(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...EXTRA_BIN_DIRS];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function versionOf(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.trim().split('\n')[0] ?? '';
      resolve(line.match(/\d+\.\d+\.\d+/)?.[0] ?? (line || null));
    });
  });
}

export async function detectEngine(binary: string): Promise<EngineInfo> {
  const found = findBinary(binary);
  if (!found) return { available: false, path: null, version: null };
  return { available: true, path: found, version: await versionOf(found) };
}
