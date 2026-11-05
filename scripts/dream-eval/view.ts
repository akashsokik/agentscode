import fs from 'node:fs';
import path from 'node:path';
import type { Entry } from '../../shared/types.ts';
import type { SessionView } from './scenario.ts';

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** Every file in the project, relative path ('/'-separated) to contents. */
export function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(full);
      } else if (item.isFile()) {
        files.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  return files;
}

/** Write the seed into an empty project folder. */
export function writeSeed(root: string, seed: Record<string, string>): void {
  for (const [rel, text] of Object.entries(seed)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
}

/** The entries of the newest session: everything after the last fresh-session marker. */
export function latestSession(entries: Entry[]): Entry[] {
  const start = entries.findLastIndex(entry => entry.sessionStart);
  return entries.slice(start + 1);
}

/** The shell command of a Bash (Claude) or Shell (Codex) tool entry, without Claude's "# description" line. */
export function commandOf(entry: Entry): string | null {
  const tool = entry.tool;
  if (entry.kind !== 'tool' || !tool || !/^(Bash|Shell)$/.test(tool.name)) return null;
  const text = (tool.detail || tool.summary || '').split('\n').filter(line => !line.startsWith('# ')).join('\n').trim();
  return text || null;
}

export function sessionView(root: string, seed: Record<string, string>, entries: Entry[]): SessionView {
  const session = latestSession(entries);
  const files = snapshot(root);
  const replies = session.filter(entry => entry.kind === 'agent' && entry.text.trim());
  const done = session.filter(entry => entry.kind === 'done');
  const changed = [...files.keys()].filter(rel => seed[rel] !== files.get(rel)).sort();
  return {
    project: root,
    entries: session,
    finalReply: replies.at(-1)?.text ?? done.at(-1)?.text ?? '',
    commands: session.flatMap(entry => commandOf(entry) ?? []),
    read: rel => files.get(rel) ?? null,
    changed,
    added: changed.filter(rel => !(rel in seed)),
  };
}
