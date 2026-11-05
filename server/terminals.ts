/**
 * The shells behind the bottom terminal panel. Each runs in a pseudo-terminal (node-pty) in its
 * project's folder and outlives the page: its recent output is kept, so a reloaded page, or a
 * second window, attaches and sees the same screen. The page draws it with Ghostty's terminal
 * (ghostty-web); this side only moves bytes.
 *
 * The folder always comes from the project on the server. A request names a project, never a
 * path, a shell or an environment.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import type { RawData, WebSocket } from 'ws';
import type { Project, TerminalClientMessage, TerminalInfo, TerminalServerMessage } from '../shared/types.ts';
import { HttpError } from './errors.ts';
import { isDirectory } from './projects.ts';

/** Output kept per terminal for pages that attach later, in UTF-16 units (about 1 MB). */
const REPLAY_LIMIT = 1_000_000;
/** A shell gets a hang-up first, like a closed terminal window; this long later, a kill. */
const KILL_GRACE_MS = 3000;
/** Stop reading from a shell while a page is this far behind, and read again once it catches up. */
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const MAX_PER_PROJECT = 24;
/** What an idle terminal's foreground process is called: a shell. Anything else is a running program. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'xonsh', 'elvish', 'pwsh']);
/** OSC 7, the folder a shell reports after each command, ended by BEL or by ESC and a backslash (zsh on macOS). */
const OSC7 = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/**
 * Variables that describe the terminal or tool AgentsCode itself was started from. A shell that
 * inherited them would believe it runs inside iTerm, tmux, VS Code or Ghostty.app, or under npm.
 */
const INHERITED = /^(?:ELECTRON_|npm_|GHOSTTY_|ITERM_|KITTY_|WEZTERM_|VSCODE_|ALACRITTY_|TERM_PROGRAM|LC_TERMINAL)|^(?:TERM|TERMINFO|COLORTERM|TERM_SESSION_ID|TMUX|TMUX_PANE|STY|INIT_CWD|PWD|OLDPWD|SHLVL)$/;

type PtyModule = typeof import('node-pty');
let ptyModule: PtyModule | null = null;

/**
 * node-pty, loaded on first use so a missing or broken native build disables terminals rather
 * than the whole server. npm no longer runs dependency install scripts by default, which leaves
 * the prebuilt spawn-helper without its execute bit; every spawn fails until it has one.
 */
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule;
  const require = createRequire(import.meta.url);
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const dir of ['build/Release', `prebuilds/${process.platform}-${process.arch}`]) {
      const helper = path.join(root, dir, 'spawn-helper');
      if (!fs.existsSync(helper)) continue;
      try {
        fs.accessSync(helper, fs.constants.X_OK);
      } catch {
        fs.chmodSync(helper, 0o755);
      }
    }
    ptyModule = require('node-pty') as PtyModule;
    return ptyModule;
  } catch (err) {
    throw new HttpError(500, `Terminals are not available on this machine: ${(err as Error).message}`);
  }
}

function isExecutable(file: string | undefined): file is string {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The user's login shell: $SHELL, else the account's shell, else zsh, bash or sh. */
export function defaultShell(): string {
  let account: string | undefined;
  try {
    account = os.userInfo().shell ?? undefined;
  } catch {
    // no passwd entry
  }
  return [process.env.SHELL, account, '/bin/zsh', '/bin/bash', '/bin/sh'].find(isExecutable) ?? '/bin/sh';
}

/** The environment a new shell starts with: the server's own, minus the terminal it came from. */
export function shellEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !INHERITED.test(key)) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'AgentsCode';
  env.PWD = cwd;
  // An app opened from the Finder has no locale; without one, shells mangle UTF-8 and prompts.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
  return env;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function send(ws: WebSocket, data: string | Buffer, binary: boolean): void {
  if (ws.readyState === ws.OPEN) ws.send(data, { binary });
}

class Session {
  readonly info: TerminalInfo;
  readonly pty: IPty;
  readonly clients = new Set<WebSocket>();
  private output: string[] = [];
  private size = 0;
  private paused = false;
  /** The end of the last output, so an OSC 7 split across two chunks still parses. */
  private tail = '';
  /** The shell's folder now, as it last reported it; where a split from it starts. */
  cwd: string;
  exited = false;

  constructor(info: TerminalInfo, pty: IPty) {
    this.info = info;
    this.pty = pty;
    this.cwd = info.cwd;
  }

  /** Keep the newest output for later attaches, and pass it to every page attached now. */
  push(chunk: string): void {
    this.trackCwd(chunk);
    this.output.push(chunk);
    this.size += chunk.length;
    while (this.size > REPLAY_LIMIT && this.output.length > 1) this.size -= this.output.shift()!.length;
    const bytes = Buffer.from(chunk, 'utf8');
    for (const ws of this.clients) send(ws, bytes, true);
    this.throttle();
  }

  private trackCwd(chunk: string): void {
    const text = this.tail + chunk;
    this.tail = text.slice(-1024);
    if (!text.includes('\x1b]7;')) return;
    let latest: string | undefined;
    for (const match of text.matchAll(OSC7)) latest = match[1];
    if (!latest) return;
    try {
      const folder = decodeURIComponent(latest);
      if (path.isAbsolute(folder)) this.cwd = folder;
    } catch {
      // a malformed escape: keep the last good folder
    }
  }

  /** The program in the foreground when it is not the shell itself, such as "npm" or "vim". */
  runningProgram(): string | null {
    if (this.exited) return null;
    let name: string;
    try {
      name = this.pty.process;
    } catch {
      return null;
    }
    name = path.basename(String(name ?? '')).replace(/^-/, '');
    return !name || SHELLS.has(name) || name === this.info.shell ? null : name;
  }

  replay(): string {
    const all = this.output.join('');
    this.output = all ? [all] : [];
    return all;
  }

  private backlog(): number {
    let most = 0;
    for (const ws of this.clients) most = Math.max(most, ws.bufferedAmount);
    return most;
  }

  /** Stop reading while a page lags far behind (say `cat` of a huge file), so memory stays bounded. */
  private throttle(): void {
    if (this.paused || this.backlog() < HIGH_WATER) return;
    this.paused = true;
    this.pty.pause();
    const check = setInterval(() => {
      if (!this.exited && this.backlog() > LOW_WATER) return;
      clearInterval(check);
      this.paused = false;
      if (!this.exited) this.pty.resume();
    }, 25);
    check.unref();
  }
}

export class Terminals {
  private sessions = new Map<string, Session>();
  private listeners = new Set<(terminals: TerminalInfo[]) => void>();
  private readonly lookup: (projectId: string) => Project;

  /** `lookup` finds a project by id, throwing a 404 HttpError when there is none. */
  constructor(lookup: (projectId: string) => Project) {
    this.lookup = lookup;
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map(s => s.info).sort((a, b) => a.createdAt - b.createdAt);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Called with the full list whenever a terminal opens or ends. */
  onChange(listener: (terminals: TerminalInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }

  /**
   * Start a login shell in the project's folder. `from` names a terminal of the same project to
   * split: the new shell starts in the folder that one is in now, as in Ghostty.
   */
  create(projectId: string, size: { cols?: unknown; rows?: unknown } = {}, from?: string): TerminalInfo {
    const project = this.lookup(projectId);
    if (!isDirectory(project.path)) throw new HttpError(409, `The project folder is missing: ${project.path}.`);
    const open = [...this.sessions.values()].filter(s => s.info.projectId === project.id).length;
    if (open >= MAX_PER_PROJECT) throw new HttpError(409, `${project.name} already has ${open} terminals. Close one first.`);
    const source = from ? this.sessions.get(from) : undefined;
    const cwd = source && source.info.projectId === project.id && isDirectory(source.cwd) ? source.cwd : project.path;

    const shell = defaultShell();
    const cols = clampInt(size.cols, 2, 1000, 80);
    const rows = clampInt(size.rows, 1, 500, 24);
    let pty: IPty;
    try {
      pty = loadPty().spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: shellEnv(cwd) });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `Could not start ${shell}: ${(err as Error).message}`);
    }
    const info: TerminalInfo = {
      id: `term_${randomBytes(6).toString('hex')}`,
      projectId: project.id,
      cwd,
      shell: path.basename(shell),
      createdAt: Date.now(),
    };
    const session = new Session(info, pty);
    this.sessions.set(info.id, session);
    pty.onData(chunk => session.push(chunk));
    pty.onExit(({ exitCode, signal }) => {
      session.exited = true;
      const message: TerminalServerMessage = { type: 'exit', exitCode, ...(signal ? { signal } : {}) };
      for (const ws of session.clients) {
        send(ws, JSON.stringify(message), false);
        ws.close(1000, 'exited');
      }
      session.clients.clear();
      if (this.sessions.get(info.id) === session) {
        this.sessions.delete(info.id);
        this.changed();
      }
    });
    this.changed();
    return info;
  }

  /**
   * Connect a page's socket to a terminal: it gets the kept output, then live output, and
   * its binary frames are keystrokes. Several pages may attach; the last resize wins.
   */
  attach(id: string, ws: WebSocket): void {
    const session = this.sessions.get(id);
    if (!session) {
      ws.close(4404, 'No such terminal.');
      return;
    }
    session.clients.add(ws);
    const kept = session.replay();
    if (kept) send(ws, Buffer.from(kept, 'utf8'), true);
    ws.on('message', (data, isBinary) => {
      if (session.exited) return;
      const bytes = toBuffer(data);
      if (isBinary) {
        session.pty.write(bytes.toString('utf8'));
        return;
      }
      let message: TerminalClientMessage;
      try {
        message = JSON.parse(bytes.toString('utf8')) as TerminalClientMessage;
      } catch {
        return;
      }
      if (message?.type === 'resize') {
        const cols = clampInt(message.cols, 2, 1000, 0);
        const rows = clampInt(message.rows, 1, 500, 0);
        if (!cols || !rows || (cols === session.pty.cols && rows === session.pty.rows)) return;
        try {
          session.pty.resize(cols, rows);
        } catch {
          // the shell ended between the check and the call
        }
      }
    });
    ws.on('close', () => session.clients.delete(ws));
    ws.on('error', () => ws.terminate());
  }

  /** Of these terminals, the ones running a program, with its name: closing them would stop it. */
  busy(ids: string[]): Record<string, string> {
    const running: Record<string, string> = {};
    for (const id of ids) {
      const program = this.sessions.get(id)?.runningProgram();
      if (program) running[id] = program;
    }
    return running;
  }

  /** End a terminal: hang up its shell, and kill it if it ignores that. */
  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new HttpError(404, 'No terminal with that id.');
    this.end(session);
    this.changed();
  }

  /** End every terminal of a project, when it is removed. */
  closeProject(projectId: string): void {
    const doomed = [...this.sessions.values()].filter(s => s.info.projectId === projectId);
    for (const session of doomed) this.end(session);
    if (doomed.length) this.changed();
  }

  /** End every terminal, when AgentsCode stops. */
  closeAll(): void {
    const all = [...this.sessions.values()];
    for (const session of all) this.end(session);
    if (all.length) this.changed();
  }

  private end(session: Session): void {
    this.sessions.delete(session.info.id);
    for (const ws of session.clients) ws.close(1000, 'closed');
    session.clients.clear();
    if (session.exited) return;
    try {
      session.pty.kill('SIGHUP');
    } catch {
      return; // already gone
    }
    const timer = setTimeout(() => {
      if (session.exited) return;
      try {
        session.pty.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, KILL_GRACE_MS);
    timer.unref();
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
