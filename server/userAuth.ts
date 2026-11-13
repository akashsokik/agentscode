import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The user's key to PodCode's own API (issue 4fc2ba28, ALL-D9). Every /api route and the app's
 * sockets need it, so a process on this Mac (an agent's shell running curl, say) cannot change
 * settings, answer the SuperAgent's questions or edit issues as the user.
 *
 * The server makes one per run and keeps it in memory only: never in a file, never in the
 * environment its agents inherit, never in a response. The desktop app's main process gets it
 * over the utility process's parentPort and adds it as a header to its own windows' requests
 * (electron/main.ts), so the page's scripts never see it either. Without the desktop app (npm run
 * dev or npm start in a browser), the server prints a one-time sign-in link in its own terminal,
 * which sets it as an HttpOnly cookie.
 */

export const USER_HEADER = 'x-podcode-user';
export const USER_COOKIE = 'podcode_user';
/** What main and the server say to each other about it, over parentPort. */
export const USER_TOKEN_MESSAGE = 'podcode:user-token';

export interface UserAuth {
  /** Whether these request headers carry the user's key (header or cookie). */
  allows(headers: IncomingHttpHeaders): boolean;
  /** Whether a window has used the key yet this run: the hand-off reached it (GET /api/health's \`window\`). */
  windowSignedIn?(): boolean;
}

function same(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The cookie a sign-in link set, from a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** One server run's key, and the one-time sign-in code for a browser without the desktop app. */
export class UserKey implements UserAuth {
  readonly token = randomBytes(32).toString('hex');
  private loginCode: string | null = null;
  private used = false;
  /** Called after a sign-in code is used, so the server can print the next one (one browser each). */
  onLoginUsed: (() => void) | null = null;

  allows(headers: IncomingHttpHeaders): boolean {
    const ok = same(this.token, headers[USER_HEADER]) || same(this.token, cookieValue(headers.cookie, USER_COOKIE));
    if (ok) this.used = true;
    return ok;
  }

  windowSignedIn(): boolean {
    return this.used;
  }

  /** A fresh one-time sign-in code (the last one stops working). */
  newLoginCode(): string {
    this.loginCode = randomBytes(16).toString('hex');
    return this.loginCode;
  }

  /** Use the sign-in code: true once, for the code last made. */
  redeemLoginCode(code: unknown): boolean {
    if (!this.loginCode || !same(this.loginCode, code)) return false;
    this.loginCode = null;
    this.onLoginUsed?.();
    return true;
  }
}

/** For tests that exercise the API itself, not the key: every request passes. */
export const OPEN_AUTH: UserAuth = { allows: () => true };

/**
 * Routes reachable without the user's key, each with its own check or nothing to expose:
 * agents' tool calls (their own Bearer tokens), the git push check in agents' shells (a one-time
 * token only PodCode issued; a restore of its own files), the sign-in link, and a health line
 * for scripts. Everything else under /api needs the key.
 */
export const OPEN_ROUTES: readonly string[] = ['POST /api/comms', 'POST /api/push-guard/redeem', 'POST /api/push-guard/check', 'GET /api/health', 'GET /login'];

export function isOpenRoute(method: string, pathname: string): boolean {
  return OPEN_ROUTES.includes(`${method === 'HEAD' ? 'GET' : method} ${pathname.toLowerCase().replace(/\/+$/, '') || '/'}`);
}

/** How long a browser's sign-in lasts (no desktop app): half a day, then a new link. */
export const LOGIN_MAX_AGE_S = 12 * 60 * 60;

/** Where a sign-in may send the browser next: a path on this server only, never //host or /\\host. */
export function safeNext(to: unknown): string {
  return typeof to === 'string' && /^\/(?![\/\\])/.test(to) ? to : '/';
}
