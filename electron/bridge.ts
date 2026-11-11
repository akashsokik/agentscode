/**
 * How the server's agent tools reach the browser in main. The server sends
 * {type:'browser:request', id, agentId, op, args}; main answers {type:'browser:response', id, ok,
 * result | error}. Main says {type:'browser:hello', version} when it connects, and again when the
 * server sends {type:'browser:ping'}. The server may send {type:'browser:agent-removed', agentId}.
 *
 * Two transports carry the same JSON:
 * - the utility process main started: its postMessage and process.parentPort;
 * - a server main did not start (`npm run dev`): a WebSocket to /browser-bridge, authenticated by
 *   the token the server writes to DATA_DIR/browser-bridge.token.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UtilityProcess } from 'electron';
import WebSocket from 'ws';
import { BrowserError, type BrowserHost } from './browser.ts';

export const BRIDGE_VERSION = 1;
const RECONNECT_MS = 3000;

type Inbound =
  | { type: 'browser:request'; id: string; agentId: string; op: string; args?: Record<string, unknown> }
  | { type: 'browser:agent-removed'; agentId: string }
  | { type: 'browser:ping' };

export type Outbound =
  | { type: 'browser:hello'; version: number }
  | { type: 'browser:response'; id: string; ok: true; result: unknown }
  | { type: 'browser:response'; id: string; ok: false; error: string };

function tokenFile(): string {
  return path.join(process.env.AGENTSCODE_HOME ?? path.join(os.homedir(), '.agentscode'), 'browser-bridge.token');
}

export class BrowserBridge {
  private socket: WebSocket | null = null;
  private retry: NodeJS.Timeout | undefined;
  private wantSocket = false;

  private host: BrowserHost;
  private port: number;
  private appShot: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;

  /** How app_screenshot captures the app's windows; set by main once it can. */
  onAppShot(capture: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.appShot = capture;
  }

  constructor(host: BrowserHost, port: number) {
    this.host = host;
    this.port = port;
  }

  /** Handles one message from the server; `reply` sends back on the transport it came by. */
  handle(raw: unknown, reply: (message: Outbound) => void): void {
    const message = raw as Inbound | null;
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'browser:ping') {
      reply({ type: 'browser:hello', version: BRIDGE_VERSION });
      return;
    }
    if (message.type === 'browser:agent-removed') {
      if (typeof message.agentId === 'string') this.host.agentRemoved(message.agentId);
      return;
    }
    if (message.type !== 'browser:request' || typeof message.id !== 'string' || typeof message.agentId !== 'string' || typeof message.op !== 'string') return;
    const { id, agentId, op } = message;
    const args = message.args && typeof message.args === 'object' ? message.args : {};
    // A capture of Podcode's own window rides the same bridge (electron/appShot.ts).
    const work = op === 'app_screenshot'
      ? (this.appShot ? this.appShot(args) : Promise.reject(new BrowserError('Screenshots of the app need the Podcode desktop app.')))
      : this.host.agent(agentId, op, args);
    work.then(
      result => reply({ type: 'browser:response', id, ok: true, result }),
      (err: unknown) => {
        const error = err instanceof BrowserError ? err.message : `The browser failed: ${err instanceof Error ? err.message : String(err)}`;
        reply({ type: 'browser:response', id, ok: false, error });
      },
    );
  }

  /** The server is main's own utility process: talk over its message port. */
  useUtility(server: UtilityProcess): void {
    this.stopSocket();
    const reply = (message: Outbound) => server.postMessage(message);
    server.on('message', message => this.handle(message, reply));
    reply({ type: 'browser:hello', version: BRIDGE_VERSION });
  }

  /** The server is someone else's (say `npm run dev`): connect to it, and keep reconnecting. */
  useSocket(): void {
    this.wantSocket = true;
    if (this.socket || this.retry) return;
    this.connect();
  }

  stopSocket(): void {
    this.wantSocket = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    this.retry = undefined;
    if (!this.wantSocket) return;
    let token: string;
    try {
      token = fs.readFileSync(tokenFile(), 'utf8').trim();
    } catch {
      this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
      return;
    }
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/browser-bridge`, { headers: { 'x-agentscode-bridge': token } });
    this.socket = socket;
    const reply = (message: Outbound) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    socket.on('open', () => reply({ type: 'browser:hello', version: BRIDGE_VERSION }));
    socket.on('message', data => {
      try {
        this.handle(JSON.parse(String(data)), reply);
      } catch {
        // not JSON: ignore
      }
    });
    socket.on('error', () => {
      // 'close' follows and schedules the retry
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (this.wantSocket && !this.retry) this.retry = setTimeout(() => this.connect(), RECONNECT_MS);
    });
  }
}
