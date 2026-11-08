import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The server's side of the browser bridge (protocol v1, agreed with the Electron side in
// electron/browser.ts). Agents' browser_* tools become requests to the desktop app's main process,
// which owns the browser views. Two transports carry the same JSON envelope: the utility process's
// parentPort when main started this server, or a token-checked socket at /browser-bridge when main
// attached to a server it did not start. Until main says hello, the browser is unavailable.

export const BROWSER_OPS = ['open', 'list', 'close', 'snapshot', 'screenshot', 'console', 'click', 'type', 'press', 'eval'] as const;
export type BrowserOp = (typeof BROWSER_OPS)[number];

/** Ops that change a page or run code in it; plan-only agents may not use them. */
export const BROWSER_WRITE_OPS: readonly BrowserOp[] = ['click', 'type', 'press', 'eval', 'close'];

export const BROWSER_UNAVAILABLE = 'The browser needs the AgentsCode desktop app.';
export const BRIDGE_VERSION = 1;
export const BRIDGE_TOKEN_FILE = 'browser-bridge.token';
export const BRIDGE_HEADER = 'x-agentscode-bridge';

export interface BridgeTransport {
  send(message: object): void;
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  transport: BridgeTransport;
}

export class BrowserBridge {
  private transport: BridgeTransport | null = null;
  private ready = false;
  private readonly pending = new Map<string, Pending>();

  private readonly timeoutMs: number;

  constructor(timeoutMs = 45_000) {
    this.timeoutMs = timeoutMs;
  }

  get available(): boolean {
    return this.ready && this.transport !== null;
  }

  /** A new connection to main. The newest wins; requests sent over an older one fail. Returns a detach for when it closes. */
  connect(transport: BridgeTransport): () => void {
    if (this.transport && this.transport !== transport) this.drop(this.transport, 'The browser connection was replaced. Try again.');
    this.transport = transport;
    this.ready = false;
    return () => {
      if (this.transport !== transport) return;
      this.drop(transport, 'The desktop app closed the browser connection. Try again.');
      this.transport = null;
      this.ready = false;
    };
  }

  /** A message from main: hello, or the answer to a request. Anything else is ignored. */
  receive(raw: unknown, from: BridgeTransport | null = this.transport): void {
    if (!raw || typeof raw !== 'object' || from !== this.transport) return;
    const message = raw as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown; version?: unknown };
    if (message.type === 'browser:hello') {
      this.ready = message.version === BRIDGE_VERSION;
      return;
    }
    if (message.type !== 'browser:response' || typeof message.id !== 'string') return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.ok === true) waiting.resolve(message.result);
    else waiting.reject(new Error(typeof message.error === 'string' && message.error ? message.error : 'The browser could not do that.'));
  }

  /** Ask main to do one browser op for an agent. Main's error text is written for the agent and passes through. */
  request(agentId: string, op: BrowserOp, args: Record<string, unknown>): Promise<unknown> {
    const transport = this.transport;
    if (!this.ready || !transport) return Promise.reject(new Error(BROWSER_UNAVAILABLE));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser did not answer within ${Math.round(this.timeoutMs / 1000)}s.`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, transport });
      try {
        transport.send({ type: 'browser:request', id, agentId, op, args });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`Could not reach the browser: ${(error as Error).message}`));
      }
    });
  }

  /** Tell main an agent is gone, so it closes that agent's tabs. */
  agentRemoved(agentId: string): void {
    if (!this.available) return;
    try { this.transport!.send({ type: 'browser:agent-removed', agentId }); } catch { /* main is going away too */ }
  }

  private drop(transport: BridgeTransport, reason: string): void {
    for (const [id, waiting] of this.pending) {
      if (waiting.transport !== transport) continue;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
    }
  }
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

/** When the desktop app started this server as a utility process, its parentPort is the bridge. */
export function attachParentPort(bridge: BrowserBridge, parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort): boolean {
  if (!parentPort) return false;
  const transport: BridgeTransport = { send: message => parentPort.postMessage(message) };
  bridge.connect(transport);
  parentPort.on('message', event => bridge.receive(event?.data, transport));
  return true;
}

/** A fresh secret for the socket transport, readable only by this user; rewritten on every start. */
export function writeBridgeToken(dataDir: string): string {
  const token = randomBytes(32).toString('hex');
  const file = path.join(dataDir, BRIDGE_TOKEN_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // the mode above only applies when the file is created
  return token;
}

/** Constant-time check of the token main sent. */
export function bridgeTokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A URL an agent may open: http or https, nothing else. Main also refuses the AgentsCode origin itself. */
export function browsableUrl(raw: string): string | null {
  const text = raw.trim();
  // "localhost:3000" parses as a "localhost:" scheme, so bare local hosts are matched first.
  const withScheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text) ? `http://${text}`
    : /^[a-z][a-z0-9+.-]*:/i.test(text) ? text
    : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
