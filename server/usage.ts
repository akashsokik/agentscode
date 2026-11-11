import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EngineInfo, EngineKind, EngineUsage, UsageWindow } from '../shared/types.ts';

/**
 * Each engine's subscription usage (5-hour and weekly limits) for the footer, read the way
 * MonoCode reads it (monocode-core/src/usage.rs): Claude's from Anthropic's OAuth usage endpoint
 * with the token Claude Code keeps in the Keychain, Codex's from `codex app-server`. Credentials
 * are read only, never refreshed or written (the CLIs own their rotating refresh tokens), never
 * logged, and never leave this process except to the service that issued them.
 */

export class UsageError extends Error {
  /** Signed out or no subscription usage, as opposed to a read that failed and may work next time. */
  readonly unavailable: boolean;
  constructor(message: string, unavailable = false) {
    super(message);
    this.unavailable = unavailable;
  }
}

export type UsageFetcher = () => Promise<UsageWindow[]>;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function numberAt(value: unknown, keys: string[]): number | undefined {
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    const n = value[key];
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** An epoch in seconds or milliseconds (above 1e10 it is milliseconds), or an ISO date; as ms. */
export function timestampMs(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value) ? Number(value)
    : undefined;
  if (numeric !== undefined) return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric > 1e10 ? numeric : numeric * 1000) : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function usageWindow(value: unknown, minutes: number, percentKeys: string[]): UsageWindow | undefined {
  const used = numberAt(value, percentKeys);
  if (used === undefined || !isObject(value)) return undefined;
  const resetsAt = timestampMs(value.resetsAt) ?? timestampMs(value.resets_at);
  return { usedPercent: Math.min(100, Math.max(0, used)), minutes, ...(resetsAt ? { resetsAt } : {}) };
}

const KNOWN_WINDOWS = [300, 10_080, 43_200];

/** Whether a window for this length and model is already listed. */
function listed(windows: UsageWindow[], minutes: number, model?: string): boolean {
  return windows.some(w => w.minutes === minutes && (w.model ?? '').toLowerCase() === (model ?? '').toLowerCase());
}

/** One Codex rate-limit snapshot's windows. A window that names its length wins over the primary/secondary guess. */
function codexWindows(wrapper: unknown, model?: string): UsageWindow[] {
  if (!isObject(wrapper)) return [];
  const windows: UsageWindow[] = [];
  for (const fallbackPass of [false, true]) {
    for (const [key, fallback] of [['primary', 300], ['secondary', 10_080]] as const) {
      const raw = wrapper[key];
      const length = numberAt(raw, ['windowDurationMins', 'window_duration_mins']);
      const classified = length === undefined ? undefined : KNOWN_WINDOWS.find(m => Math.abs(length - m) <= 1);
      if ((classified === undefined) !== fallbackPass) continue;
      const minutes = classified ?? fallback;
      if (windows.some(w => w.minutes === minutes)) continue;
      const found = usageWindow(raw, minutes, ['usedPercent', 'used_percent', 'used_percentage']);
      if (found) windows.push(model ? { ...found, model } : found);
    }
  }
  return windows.sort((a, b) => a.minutes - b.minutes);
}

/**
 * Codex's `account/rateLimits/read` result: the account's own limits, then any a model keeps
 * apart from them (`rateLimitsByLimitId`, a limit id other than the main one, named for its model).
 */
export function parseCodexLimits(value: unknown): UsageWindow[] {
  const main = isObject(value) && isObject(value.rateLimits) ? value.rateLimits : value;
  const windows = codexWindows(main);
  const mainId = isObject(main) && typeof main.limitId === 'string' ? main.limitId : 'codex';
  const byId = isObject(value) && isObject(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId : {};
  for (const [id, snapshot] of Object.entries(byId)) {
    if (id === mainId || !isObject(snapshot)) continue;
    const name = typeof snapshot.limitName === 'string' && snapshot.limitName.trim() ? snapshot.limitName.trim() : id;
    for (const w of codexWindows(snapshot, name)) if (!listed(windows, w.minutes, w.model)) windows.push(w);
  }
  return windows;
}

const CLAUDE_WINDOWS = [['five_hour', 300], ['seven_day', 10_080], ['seven_day_opus', 10_080, 'Opus'], ['seven_day_sonnet', 10_080, 'Sonnet']] as const;

/**
 * Anthropic's OAuth usage response: the 5-hour and weekly windows every model counts against, the
 * weekly ones a model family keeps on its own (`seven_day_opus`), and any other model's own limit
 * listed under `limits` (a `weekly_scoped` limit whose scope names the model).
 */
export function parseClaudeUsage(value: unknown): UsageWindow[] {
  if (!isObject(value)) throw new UsageError('Claude usage response was unexpected.');
  const windows: UsageWindow[] = [];
  for (const [key, minutes, model] of CLAUDE_WINDOWS) {
    const found = usageWindow(value[key], minutes, ['utilization', 'used_percentage', 'usedPercent']);
    if (found) windows.push(model ? { ...found, model } : found);
  }
  for (const limit of Array.isArray(value.limits) ? value.limits : []) {
    if (!isObject(limit) || typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) continue;
    const scope = isObject(limit.scope) && isObject(limit.scope.model) ? limit.scope.model : undefined;
    const name = scope && typeof scope.display_name === 'string' && scope.display_name.trim() ? scope.display_name.trim()
      : scope && typeof scope.id === 'string' && scope.id ? scope.id
      : undefined;
    // A limit scoped some other way (to a surface, say) is not one the footer can place.
    if (limit.scope && !name) continue;
    const minutes = limit.group === 'session' || limit.group === 'five_hour' ? 300 : 10_080;
    if (listed(windows, minutes, name)) continue;
    const resetsAt = timestampMs(limit.resets_at) ?? timestampMs(limit.resetsAt);
    windows.push({ usedPercent: Math.min(100, Math.max(0, limit.percent)), minutes, ...(resetsAt ? { resetsAt } : {}), ...(name ? { model: name } : {}) });
  }
  if (!windows.some(w => !w.model)) throw new UsageError('No Claude subscription usage available for this account.', true);
  return windows;
}

// ---- Claude ------------------------------------------------------------------

/** Claude Code's Keychain item: one per config folder, named after a hash of it when one is set. */
function keychainService(configDir: string | undefined): string {
  if (!configDir) return 'Claude Code-credentials';
  const digest = crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex');
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}

/** The raw Keychain secret, or undefined when there is no item or it cannot be read. */
function readKeychain(service: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

/** A credentials blob with a non-blank access token, or undefined. Never echoes what it read. */
export function credentialBlob(raw: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim());
    if (!isObject(value)) return undefined;
    const oauth = isObject(value.claudeAiOauth) ? value.claudeAiOauth : value;
    return typeof oauth.accessToken === 'string' && oauth.accessToken.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

async function claudeCredentials(): Promise<Json | undefined> {
  const configDir = process.env.CLAUDE_CONFIG_DIR || undefined;
  // On macOS the CLI keeps its login in the Keychain. An item that is there but blank means signed
  // out; an old .credentials.json must not stand in for it.
  if (process.platform === 'darwin') {
    const raw = await readKeychain(keychainService(configDir));
    if (raw !== undefined) return credentialBlob(raw);
  }
  try {
    return credentialBlob(fs.readFileSync(path.join(configDir ?? path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The access token lasts hours; while a refresh token is there the CLI renews it on its next run,
 * so an expired one is not a sign-out: the last usage stays and the next read will work.
 */
export function expiredError(oauth: Json): UsageError {
  const renewable = typeof oauth.refreshToken === 'string' && oauth.refreshToken.trim() !== '';
  return renewable
    ? new UsageError('Claude usage updates after your next Claude message.')
    : new UsageError('Claude sign-in expired. Run claude auth login, then refresh.', true);
}

export async function fetchClaudeUsage(): Promise<UsageWindow[]> {
  const credentials = await claudeCredentials();
  if (!credentials) throw new UsageError('Sign in with claude auth login, then refresh usage.', true);
  const oauth = isObject(credentials.claudeAiOauth) ? credentials.claudeAiOauth : credentials;
  const token = String(oauth.accessToken);
  const expiry = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : timestampMs(oauth.expiresAt);
  if (expiry !== undefined && expiry <= Date.now()) throw expiredError(oauth);
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.0' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new UsageError('Could not reach Claude usage. Try refreshing again.');
  }
  if (response.status === 401) throw expiredError(oauth);
  if (response.status === 403) throw new UsageError('Claude usage is unavailable for this account.', true);
  if (!response.ok) throw new UsageError(`Claude usage request failed (${response.status}).`);
  const body = await response.text().catch(() => '');
  if (!body || body.length > 1024 * 1024) throw new UsageError('Could not read Claude usage response.');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new UsageError('Claude usage response was not JSON.');
  }
  return parseClaudeUsage(value);
}

// ---- Codex -------------------------------------------------------------------

function codexError(message: string): UsageError {
  const lower = message.toLowerCase();
  if (['not installed', 'not signed in', 'not authenticated', 'authentication required', 'not logged in'].some(s => lower.includes(s))) {
    return new UsageError('Sign in with codex login, then refresh usage.', true);
  }
  return new UsageError(message.length > 200 ? `${message.slice(0, 199)}...` : message || 'Codex usage request failed.');
}

/** Asks a short-lived `codex app-server` for the account's rate limits over its JSON-RPC lines. */
export function fetchCodexUsage(binPath: string | null, timeoutMs = 20_000): Promise<UsageWindow[]> {
  if (!binPath) return Promise.reject(new UsageError('Codex is not installed.', true));
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false;
    let buffer = '';
    const finish = (error: UsageError | null, windows?: UsageWindow[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(windows ?? []);
    };
    const timer = setTimeout(() => finish(new UsageError('Codex usage request timed out.')), timeoutMs);
    const send = (message: Json) => {
      if (!done && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.stdin.on('error', () => {});
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' ? new UsageError('Codex is not installed.', true) : new UsageError('Could not start Codex.')));
    child.on('exit', () => finish(new UsageError('Codex exited before reporting usage.')));
    const handle = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(message)) return;
      const failure = isObject(message.error) ? String(message.error.message ?? 'Codex usage request failed.') : undefined;
      // A request from the server: answer the clock, decline the rest.
      if (typeof message.method === 'string' && message.id !== undefined) {
        send(message.method === 'currentTime/read'
          ? { id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } }
          : { id: message.id, error: { code: -32601, message: 'Unsupported method' } });
        return;
      }
      if (message.id === 1) {
        if (failure) return finish(codexError(failure));
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      } else if (message.id === 2) {
        if (failure) return finish(codexError(failure));
        const windows = parseCodexLimits(message.result);
        if (!windows.length) return finish(new UsageError('No Codex subscription usage available for this account.', true));
        finish(null, windows);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) handle(line);
      }
      if (buffer.length > 4 * 1024 * 1024) finish(new UsageError('Codex usage response was too large.'));
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'podcode', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

// ---- the tracker -----------------------------------------------------------------

interface Slot {
  windows?: UsageWindow[];
  updatedAt?: number;
  error?: string;
  unavailable?: boolean;
  attemptedAt?: number;
  pending?: Promise<void>;
}

/** How long a read stands: 15 minutes, or 5 once a window it reported has reset. */
const FRESH_MS = 15 * 60_000;
const FRESH_AFTER_RESET_MS = 5 * 60_000;

/**
 * Reads each engine's usage when asked and keeps it for a while, one read in flight per engine.
 * Nothing is read until the footer asks, so starting the server (or a test) touches no login.
 */
export class UsageTracker {
  private slots = new Map<EngineKind, Slot>();
  private engines: () => Record<EngineKind, EngineInfo>;
  private fetchers: Partial<Record<EngineKind, UsageFetcher>>;

  constructor(engines: () => Record<EngineKind, EngineInfo>, fetchers?: Partial<Record<EngineKind, UsageFetcher>>) {
    this.engines = engines;
    this.fetchers = fetchers ?? {
      claude: fetchClaudeUsage,
      codex: () => fetchCodexUsage(this.engines().codex?.path ?? null),
    };
  }

  /** Whether the footer can show usage for this engine: it is installed and has a reader. */
  has(engine: string): engine is EngineKind {
    const info = (this.engines() as Partial<Record<string, EngineInfo>>)[engine];
    return Boolean(info?.available && this.fetchers[engine as EngineKind]);
  }

  /** The engine's usage, read again first when stale or when `force` asks. */
  async usage(engine: EngineKind, force = false): Promise<EngineUsage> {
    await this.refresh(engine, force);
    const slot = this.slot(engine);
    return {
      windows: slot.windows ?? [],
      ...(slot.updatedAt ? { updatedAt: slot.updatedAt } : {}),
      ...(slot.error ? { error: slot.error } : {}),
      ...(slot.unavailable ? { unavailable: true } : {}),
    };
  }

  private slot(engine: EngineKind): Slot {
    let slot = this.slots.get(engine);
    if (!slot) this.slots.set(engine, (slot = {}));
    return slot;
  }

  private refresh(engine: EngineKind, force: boolean): Promise<void> {
    const slot = this.slot(engine);
    if (slot.pending) return slot.pending;
    const fetcher = this.fetchers[engine];
    if (!fetcher) return Promise.resolve();
    const now = Date.now();
    const resetPassed = slot.windows?.some(w => w.resetsAt !== undefined && slot.updatedAt !== undefined && w.resetsAt > slot.updatedAt && w.resetsAt <= now);
    const fresh = resetPassed ? FRESH_AFTER_RESET_MS : FRESH_MS;
    if (!force && slot.attemptedAt !== undefined && now - slot.attemptedAt < fresh) return Promise.resolve();
    slot.attemptedAt = now;
    slot.pending = fetcher()
      .then(windows => {
        slot.windows = windows;
        slot.updatedAt = Date.now();
        slot.error = undefined;
        slot.unavailable = undefined;
      }, (error: unknown) => {
        const failure = error instanceof UsageError ? error : new UsageError('Could not read usage.');
        slot.error = failure.message;
        slot.unavailable = failure.unavailable || undefined;
        // Signed out clears what was there; a failed read keeps the last one.
        if (failure.unavailable) {
          slot.windows = undefined;
          slot.updatedAt = undefined;
        }
      })
      .finally(() => {
        slot.pending = undefined;
      });
    return slot.pending;
  }
}
