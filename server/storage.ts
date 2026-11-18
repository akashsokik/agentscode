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
  const data = path.resolve(source.dataDir), worktrees = path.resolve(source.worktreesRoot);
  const homes = new Map(agents.map(a => [a.id, a]));
  // Only registered worktrees inside the configured worktree root or an agent's private workspace.
  const owned = source.agents.flatMap(a => {
    if (!a.worktree) return [];
    const root = path.resolve(a.worktree.path);
    return inside(worktrees, root) || inside(path.join(data, 'agents', a.id, 'workspace'), root) ? [{ root, agent: homes.get(a.id)! }] : [];
  }).sort((a, b) => b.root.length - a.root.length);
  let errors = 0, rootFailed = false, total = 0;
  const seen = new Set<string>();
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
  const queue = [...roots];
  // Eight outstanding filesystem operations at most; yielding between batches keeps UI requests responsive.
  for (let offset = 0; offset < queue.length;) {
    const batch = queue.slice(offset, offset + 8);
    offset += batch.length;
    await Promise.all(batch.map(async file => {
      try {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) { if (roots.includes(file)) { errors++; if (file === data) rootFailed = true; } return; }
        const key = `${stat.dev}:${stat.ino}`;
        const bytes = process.platform === 'win32' && !stat.blocks ? stat.size : typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
        if (seen.has(key)) {
          const previous = links.get(key);
          // Stable attribution when parallel stats encounter aliases in a different order.
          if (previous && file < previous.file) {
            assign(previous.file, -previous.bytes); assign(file, previous.bytes);
            links.set(key, { file, bytes: previous.bytes });
          }
          return;
        }
        seen.add(key);
        if (stat.isFile() && stat.nlink > 1) links.set(key, { file, bytes });
        assign(file, bytes);
        if (stat.isDirectory()) {
          const dir = await fs.opendir(file);
          for await (const entry of dir) queue.push(path.join(file, entry.name));
        }
      } catch (error) {
        // Missing optional worktree root is normal. Missing data root is a real scan error.
        if (file === worktrees && file !== data && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
        errors++;
        if (file === data) rootFailed = true;
      }
    }));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  for (const a of agents) a.total = a.home + a.workspace + a.worktrees;
  agents.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { startedAt, measuredAt: new Date().toISOString(), status: rootFailed ? 'error' : errors ? 'partial' : 'complete', errors, total, agents, shared };
}
