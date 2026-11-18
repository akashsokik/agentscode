import fs from 'node:fs/promises';
import path from 'node:path';
import { agentLook, AVATAR_FILL } from '../shared/avatar.ts';
import type { Agent } from '../shared/types.ts';
import type { StorageAgent, StorageCategory, StorageSnapshot } from '../shared/storage.ts';

export interface StorageSource { dataDir: string; worktreesRoot: string; agents: Pick<Agent, 'id' | 'name' | 'role' | 'avatar' | 'worktree'>[] }
const inside = (root: string, candidate: string) => candidate === root || (!path.relative(root, candidate).startsWith(`..${path.sep}`) && path.relative(root, candidate) !== '..' && !path.isAbsolute(path.relative(root, candidate)));
const categories: StorageCategory[] = ['transcripts', 'channels', 'attachments', 'archive', 'projects', 'state', 'backups', 'other', 'unassignedAgents', 'unassignedWorktrees'];

/** One bounded asynchronous scan at a time. No scan runs on normal state broadcasts. */
export class StorageUsage {
  private cached: StorageSnapshot | null = null;
  private running: Promise<StorageSnapshot> | null = null;
  private generation = 0;
  private source: () => StorageSource;
  private ttl: number;
  constructor(source: () => StorageSource, ttl = 60_000) { this.source = source; this.ttl = ttl; }
  invalidate(): void { this.cached = null; this.generation++; }
  get(force = false): Promise<StorageSnapshot> {
    if (this.running) return this.running;
    if (!force && this.cached && Date.now() - Date.parse(this.cached.measuredAt) < this.ttl) return Promise.resolve(this.cached);
    const generation = this.generation;
    this.running = scanStorage(this.source()).then(result => {
      if (generation === this.generation) this.cached = result;
      return result;
    }).finally(() => { this.running = null; });
    return this.running;
  }
}

export async function scanStorage(source: StorageSource): Promise<StorageSnapshot> {
  const startedAt = new Date().toISOString();
  const shared = Object.fromEntries(categories.map(key => [key, 0])) as Record<StorageCategory, number>;
  const agents: StorageAgent[] = source.agents.map(a => ({ id: a.id, name: a.name, color: AVATAR_FILL[agentLook(a).color], home: 0, workspace: 0, worktrees: 0, total: 0 }));
  const configuredData = path.resolve(source.dataDir);
  // Resolve the explicitly configured root once. Walk its children with lstat.
  const data = await fs.realpath(configuredData).catch(() => configuredData);
  const rooted = (entry: string) => {
    const resolved = path.resolve(entry);
    return inside(configuredData, resolved) ? path.join(data, path.relative(configuredData, resolved)) : resolved;
  };
  const worktrees = rooted(source.worktreesRoot);
  const homes = new Map(agents.map(a => [a.id, a]));
  // Only registered worktrees inside the configured worktree root or an agent's private workspace.
  const owned = source.agents.flatMap(a => {
    if (!a.worktree) return [];
    const root = rooted(a.worktree.path);
    return inside(worktrees, root) || inside(path.join(data, 'agents', a.id, 'workspace'), root) ? [{ root, agent: homes.get(a.id)! }] : [];
  }).sort((a, b) => b.root.length - a.root.length);
  let errors = 0, rootFailed = false, total = 0;
  const seenDirectories = new Set<string>();
  const links = new Map<string, { file: string; bytes: number }>();
  const assign = (file: string, bytes: number) => {
    total += bytes;
    const worktree = owned.find(w => inside(w.root, file));
    if (worktree) { worktree.agent.worktrees += bytes; return; }
    if (inside(worktrees, file)) { shared.unassignedWorktrees += bytes; return; }
    const rel = path.relative(data, file).split(path.sep);
    if (rel[0] === 'agents' && rel.length > 1) {
      const agent = homes.get(rel[1]);
      if (!agent) { shared.unassignedAgents += bytes; return; }
      agent[rel[2] === 'workspace' ? 'workspace' : 'home'] += bytes;
      return;
    }
    const group: StorageCategory = ({ transcripts: 'transcripts', channels: 'channels', attachments: 'attachments', 'channel-attachments': 'attachments', archive: 'archive', projects: 'projects', 'state.json': 'state', backups: 'backups' } as Record<string, StorageCategory>)[rel[0]] ?? 'other';
    shared[group] += bytes;
  };
  const roots = [data, ...(!inside(data, worktrees) ? [worktrees] : [])];
  const directories: string[] = [];
  function recordError(file: string, error: unknown) {
    if (file === worktrees && file !== data && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    errors++;
    if (file === data) rootFailed = true;
  }

  async function measure(file: string) {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) {
        if (roots.includes(file)) recordError(file, undefined);
        return;
      }
      const bytes = process.platform === 'win32' && !stat.blocks ? stat.size : typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
      if (stat.isDirectory()) {
        const key = `${stat.dev}:${stat.ino}`;
        if (seenDirectories.has(key)) return;
        seenDirectories.add(key);
        directories.push(file);
      } else if (stat.nlink > 1) {
        const key = `${stat.dev}:${stat.ino}`;
        const previous = links.get(key);
        if (previous) {
          if (file < previous.file) {
            assign(previous.file, -previous.bytes);
            assign(file, previous.bytes);
            previous.file = file;
          }
          return;
        }
        links.set(key, { file, bytes });
      }
      assign(file, bytes);
    } catch (error) { recordError(file, error); }
  }

  await Promise.all(roots.map(measure));
  // Keep only pending directories and one batch of file stats, even in a wide directory.
  while (directories.length) {
    const folder = directories.pop()!;
    const batch: Promise<void>[] = [];
    try {
      const dir = await fs.opendir(folder);
      for await (const entry of dir) {
        batch.push(measure(path.join(folder, entry.name)));
        if (batch.length === 8) {
          await Promise.all(batch);
          batch.length = 0;
        }
      }
    } catch (error) { recordError(folder, error); }
    await Promise.all(batch);
  }
  for (const a of agents) a.total = a.home + a.workspace + a.worktrees;
  agents.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { startedAt, measuredAt: new Date().toISOString(), status: rootFailed ? 'error' : errors ? 'partial' : 'complete', errors, total, agents, shared };
}
