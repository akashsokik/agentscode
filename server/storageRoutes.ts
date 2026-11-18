import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Express } from 'express';
import { HttpError } from './errors.ts';
import { StorageUsage, type StorageSource } from './storage.ts';

/** This registrar belongs behind app.ts's userOnly/localOnly middleware. */
export function registerStorageRoutes(app: Express, source: () => StorageSource, reveal = openFolder): StorageUsage {
  const usage = new StorageUsage(source);
  app.get('/api/storage', async (req, res) => { res.json(await usage.get(req.query.refresh === 'true')); });
  app.post('/api/storage/refresh', async (_req, res) => { res.json(await usage.get(true)); });
  app.post('/api/storage/reveal', async (req, res) => {
    const input = source();
    const agent = typeof req.body?.agentId === 'string' ? input.agents.find(a => a.id === req.body.agentId) : undefined;
    let target: string;
    if (req.body?.agentId != null) {
      if (!agent) throw new HttpError(404, 'Agent not found.');
      target = path.join(input.dataDir, 'agents', agent.id);
    } else if (req.body?.target === 'data') target = input.dataDir;
    else if (req.body?.target === 'backups') target = path.join(input.dataDir, 'backups');
    else throw new HttpError(400, 'Choose a PodCode folder.');
    const root = await fs.realpath(input.dataDir);
    const resolved = await fs.realpath(target).catch(error => {
      if (error.code === 'ENOENT') throw new HttpError(404, 'The requested folder does not exist.');
      throw error;
    });
    const rel = path.relative(root, resolved);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !(await fs.stat(resolved)).isDirectory()) throw new HttpError(403, 'Only folders inside PodCode data can be opened.');
    await reveal(resolved);
    res.json({ opened: true });
  });
  return usage;
}
async function openFolder(folder: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [folder], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open the folder.')));
  });
}
