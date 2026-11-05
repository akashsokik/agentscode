import fs from 'node:fs';
import path from 'node:path';
import type { ComposerCommand } from '../shared/composer.ts';
import type { EngineKind } from '../shared/types.ts';

/*
 * The skills and commands an agent's engine can run, for the composer's `/` picker, found where each
 * engine looks for them (after MonoCode's skill catalog):
 *
 * - Claude Code: skills in .claude/skills/<name>/SKILL.md and commands in .claude/commands/**.md, in
 *   the workspace and in the home folder, plus those of every enabled plugin as <plugin>:<name>.
 * - Codex: skills in .codex/skills and .agents/skills, in the workspace and in the home folder.
 *
 * Claude Code's own built-in commands are left out; many of them only work in its terminal UI.
 */

/** A command with the file it is defined in, which Codex prompts are built from. */
export interface DiscoveredCommand extends ComposerCommand {
  path: string;
}

type Frontmatter = Record<string, string>;

/** The YAML frontmatter's flat keys, and the body after it. Folded (`>`) and literal (`|`) values are joined. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };
  const data: Frontmatter = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!line) continue;
    let value = line[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(' ').trim();
    }
    data[line[1]] = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return { data, body: match[2] };
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Partials such as a plugin's `_conventions.md`, which Claude Code does not offer as commands. */
function hiddenName(name: string): boolean {
  return name.startsWith('_');
}

function invocable(data: Frontmatter): boolean {
  return data['user-invocable'] !== 'false';
}

type Origin = Pick<ComposerCommand, 'scope' | 'source'>;

/** `<dir>/<name>/SKILL.md` skills; `recursive` also looks in nested folders, as Codex does. */
function skillsIn(dir: string, origin: Origin, prefix = '', recursive = false): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const visit = (folder: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (hiddenName(entry.name)) continue;
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDir(full))) continue;
      const file = path.join(full, 'SKILL.md');
      const text = readText(file);
      if (text !== undefined) {
        const { data, body } = parseFrontmatter(text);
        if (!invocable(data)) continue;
        // Claude Code names a skill after its folder; Codex after its frontmatter.
        const name = recursive ? data.name || entry.name : entry.name;
        out.push({ name: prefix + name, description: data.description || firstLine(body), argumentHint: data['argument-hint'] || undefined, path: file, ...origin });
      } else if (recursive && depth < 3) {
        visit(full, depth + 1);
      }
    }
  };
  visit(dir, 0);
  return out;
}

/** Claude Code commands: `<dir>/**.md`, a nested folder adding `folder:` to the name. */
function commandsIn(dir: string, origin: Origin, prefix = ''): DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];
  const visit = (folder: string, names: string[]) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (hiddenName(entry.name)) continue;
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDir(full))) {
        if (names.length < 3) visit(full, [...names, entry.name]);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const text = readText(full);
      if (text === undefined) continue;
      const { data, body } = parseFrontmatter(text);
      if (!invocable(data)) continue;
      const name = [...names, entry.name.slice(0, -3)].join(':');
      out.push({ name: prefix + name, description: data.description || firstLine(body), argumentHint: data['argument-hint'] || undefined, path: full, ...origin });
    }
  };
  visit(dir, []);
  return out;
}

function readJson(file: string): unknown {
  const text = readText(file);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Enabled Claude Code plugins installed for the user, or for this workspace: name and folder. */
function claudePlugins(home: string, cwd: string): { name: string; dir: string }[] {
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) as { plugins?: Record<string, { installPath?: string; scope?: string; projectPath?: string }[]> } | undefined;
  const enabled: Record<string, unknown> = {};
  for (const settings of [path.join(home, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
    const json = readJson(settings) as { enabledPlugins?: Record<string, unknown> } | undefined;
    Object.assign(enabled, json?.enabledPlugins ?? {});
  }
  const out: { name: string; dir: string }[] = [];
  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    if (enabled[key] !== true || !Array.isArray(installs)) continue;
    const install = installs.find(i => i.scope !== 'project' && i.scope !== 'local') ?? installs.find(i => i.projectPath && path.resolve(i.projectPath) === path.resolve(cwd));
    if (install?.installPath && isDir(install.installPath)) out.push({ name: key.split('@')[0], dir: install.installPath });
  }
  return out;
}

/** The first command of each name wins, in the order given: project, then personal, then plugins. */
function unique(commands: DiscoveredCommand[]): DiscoveredCommand[] {
  const seen = new Set<string>();
  return commands.filter(command => !seen.has(command.name) && Boolean(seen.add(command.name)));
}

export function discoverCommands(engine: EngineKind, cwd: string, home: string): DiscoveredCommand[] {
  if (engine === 'claude') {
    const project: Origin = { scope: 'project', source: 'claude' };
    const user: Origin = { scope: 'user', source: 'claude' };
    return unique([
      ...skillsIn(path.join(cwd, '.claude', 'skills'), project),
      ...commandsIn(path.join(cwd, '.claude', 'commands'), project),
      ...skillsIn(path.join(home, '.claude', 'skills'), user),
      ...commandsIn(path.join(home, '.claude', 'commands'), user),
      ...claudePlugins(home, cwd).flatMap(plugin => [
        ...skillsIn(path.join(plugin.dir, 'skills'), { scope: 'plugin', source: plugin.name }, `${plugin.name}:`),
        ...commandsIn(path.join(plugin.dir, 'commands'), { scope: 'plugin', source: plugin.name }, `${plugin.name}:`),
      ]),
    ]);
  }
  return unique([
    ...skillsIn(path.join(cwd, '.codex', 'skills'), { scope: 'project', source: 'codex' }, '', true),
    ...skillsIn(path.join(cwd, '.agents', 'skills'), { scope: 'project', source: 'agents' }, '', true),
    ...skillsIn(path.join(home, '.codex', 'skills'), { scope: 'user', source: 'codex' }, '', true),
    ...skillsIn(path.join(home, '.agents', 'skills'), { scope: 'user', source: 'agents' }, '', true),
  ]);
}

const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; commands: DiscoveredCommand[] }>();

/** discoverCommands, kept for a few seconds: the picker asks again on every open. */
export function commandsFor(engine: EngineKind, cwd: string, home: string): DiscoveredCommand[] {
  const key = `${engine}\0${cwd}\0${home}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.commands;
  const commands = discoverCommands(engine, cwd, home);
  cache.set(key, { at: Date.now(), commands });
  return commands;
}

/** A skill's instructions, without its frontmatter. */
export function commandBody(command: DiscoveredCommand): string {
  return parseFrontmatter(readText(command.path) ?? '').body;
}
