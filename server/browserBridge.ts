import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// The server's side of the browser bridge (protocol v1, agreed with the Electron side in
// electron/browser.ts). Agents' browser_* tools become requests to the desktop app's main process,
// which owns the browser views. Two transports carry the same JSON envelope: the utility process's
// parentPort when main started this server, or a token-checked socket at /browser-bridge when main
// attached to a server it did not start. Until main says hello, the browser is unavailable; main may
// say it before this side listens, so the server asks with a ping once it does.

/** app_screenshot captures AgentsCode's own window (electron/appShot.ts), not a browser tab; it rides the same bridge. */
export const BROWSER_OPS = ['open', 'list', 'close', 'snapshot', 'screenshot', 'console', 'click', 'type', 'press', 'eval', 'app_screenshot'] as const;
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
      // Any hello means main is there (agreed with electron/bridge.ts); the version is for later changes.
      this.ready = true;
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
  // Main's first hello can arrive before the listener above existed; ask again.
  transport.send({ type: 'browser:ping' });
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

interface ConsoleLine {
  seq: number;
  ts: number;
  level: string;
  source: string;
  text: string;
  url?: string;
}

const SEVERITY: Record<string, number> = { error: 0, warn: 1, info: 2, log: 3, debug: 4 };
/** About 12k characters of console per call: enough to act on, small enough for any agent. */
export const CONSOLE_BUDGET = 12_000;

/**
 * A console result as an agent can use it: the same message repeated becomes one line with a
 * count, messages that differ only in their URLs become one line with a count and an example, and
 * the whole stays within a budget, errors first. `next` is kept, so the agent's cursor still works.
 */
export function compactConsole(result: unknown, budget = CONSOLE_BUDGET): unknown {
  const raw = result as { entries?: unknown; next?: unknown } | null;
  if (!raw || !Array.isArray(raw.entries)) return result;
  const entries = raw.entries as ConsoleLine[];
  const groups = new Map<string, { first: ConsoleLine; count: number; urls: Set<string> }>();
  for (const entry of entries) {
    const text = String(entry.text ?? '');
    const pattern = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/gi, '<url>');
    const key = `${entry.level}|${entry.source}|${pattern}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      if (group.urls.size < 3 && text !== group.first.text) group.urls.add(text.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)]+/i)?.[0] ?? '');
    } else {
      groups.set(key, { first: entry, count: 1, urls: new Set() });
    }
  }
  const lines = [...groups.values()].map(({ first, count, urls }) => {
    const examples = [...urls].filter(Boolean);
    const text = count > 1 && examples.length
      ? `${first.text} (and ${count - 1} more like it, e.g. ${examples.join(', ')})`
      : count > 1 ? `${first.text} (x${count})` : first.text;
    return { ...first, text: text.length > 600 ? `${text.slice(0, 600)}...` : text, ...(count > 1 ? { count } : {}) };
  });
  // Within the budget, errors before warnings before the rest; shown in their original order.
  const ranked = [...lines].sort((a, b) => (SEVERITY[a.level] ?? 5) - (SEVERITY[b.level] ?? 5) || a.seq - b.seq);
  const kept = new Set<ConsoleLine>();
  let used = 0;
  for (const line of ranked) {
    const size = JSON.stringify(line).length;
    if (used + size > budget) continue;
    kept.add(line);
    used += size;
  }
  const shown = lines.filter(line => kept.has(line));
  const omitted = entries.length - shown.reduce((n, line) => n + ((line as { count?: number }).count ?? 1), 0);
  return {
    ...raw,
    entries: shown,
    ...(omitted > 0 ? { omitted, note: `${omitted} more console entries were left out to keep this short (lower-severity first). Call again with since=${String(raw.next)} for newer ones.` } : {}),
  };
}
