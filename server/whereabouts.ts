import path from 'node:path';

// Where an agent is working: which codebase its tool calls touch. Project agents start in their
// own folder; agents with no project roam, so their place is read from the paths they use.

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A folder an agent can work in: a project's checkout, or an agent's worktree of one. */
export interface Place {
  root: string;
  projectId: string;
  /** Known without asking git: a worktree's own branch. */
  branch?: string;
  /** For a worktree: the agent that owns it. */
  agentId?: string;
}

function unquote(token: string): string {
  return token.replace(/^(['"])(.*)\1$/, '$2');
}

function expandHome(p: string, home: string | undefined): string {
  return home && (p === '~' || p.startsWith('~/')) ? path.join(home, p.slice(1)) : p;
}

const TOKEN = String.raw`("[^"]+"|'[^']+'|[^\s;&|]+)`;
const LEADING_CD = new RegExp(String.raw`^\s*cd\s+${TOKEN}`);
const GIT_C = new RegExp(String.raw`\bgit\s+-C\s+${TOKEN}`, 'g');

/** The folders a shell command says it works in: a leading `cd <dir>`, and any `git -C <dir>`. */
export function commandPaths(command: string, cwd: string, home?: string): string[] {
  const found: string[] = [];
  const cd = LEADING_CD.exec(command);
  if (cd) found.push(unquote(cd[1]));
  for (const match of command.matchAll(GIT_C)) found.push(unquote(match[1]));
  return found.map(p => path.resolve(cwd, expandHome(p, home)));
}

/** The paths one tool call points at, absolute. Engines name their tools differently; this takes Claude's and OrcaCode's names, and Codex's Shell. */
export function toolPaths(name: string, input: Input, cwd: string, home?: string): string[] {
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
  const found = file ? [path.resolve(cwd, expandHome(file, home))] : [];
  if (name === 'Bash' || name === 'Shell' || name === 'bash' || name === 'shell') found.push(...commandPaths(str(input.command), cwd, home));
  return found;
}

function inside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The place holding a path: the deepest one, so a worktree inside a project's folder wins over the project. */
export function locate(target: string, places: readonly Place[]): Place | null {
  let best: Place | null = null;
  for (const place of places) {
    if (inside(target, place.root) && (!best || place.root.length > best.root.length)) best = place;
  }
  return best;
}
