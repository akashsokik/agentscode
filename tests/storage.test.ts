import './isolate.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { scanStorage, StorageUsage, type StorageSource } from '../server/storage.ts';
import { registerStorageRoutes } from '../server/storageRoutes.ts';
import type { Agent } from '../shared/types.ts';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'podcode-storage-'));
  const source: StorageSource = { dataDir: root, worktreesRoot: path.join(root, 'worktrees'), agents: [{ id: 'a', name: 'A', role: 'dev', worktree: null }] };
  const file = async (rel: string, size = 8192) => { const p = path.join(root, rel); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, Buffer.alloc(size, 1)); return p; };
  return { root, source, file, close: () => fs.rm(root, { recursive: true, force: true }) };
}

test('storage walks allocated bytes once, splits home/workspace/worktrees and keeps unknown roots', async () => {
  const f = await fixture();
  try {
    await f.file('agents/a/memory.md'); await f.file('agents/a/workspace/output');
    await f.file('worktrees/owned/output'); await f.file('worktrees/unknown/output');
    await f.file('agents/gone/workspace/output'); await f.file('transcripts/a.jsonl'); await f.file('backups/one/output');
    f.source.agents[0].worktree = { path: path.join(f.root, 'worktrees/owned') } as Agent['worktree'];
    const r = await scanStorage(f.source), a = r.agents[0];
    assert.equal(r.status, 'complete');
    for (const n of [a.home, a.workspace, a.worktrees, r.shared.unassignedWorktrees, r.shared.unassignedAgents, r.shared.transcripts, r.shared.backups]) assert.ok(n >= 8192);
    assert.equal(a.total, a.home + a.workspace + a.worktrees);
    assert.equal(r.total, r.agents.reduce((s, a) => s + a.total, 0) + Object.values(r.shared).reduce((a, b) => a + b, 0));
  } finally { await f.close(); }
});

test('storage never follows symlinks and deduplicates hardlinks across categories', async () => {
  const f = await fixture();
  try {
    const p = await f.file('agents/a/workspace/file', 32768);
    await fs.link(p, path.join(f.root, 'agents/a/workspace/hardlink'));
    await fs.mkdir(path.join(f.root, 'transcripts'));
    await fs.link(p, path.join(f.root, 'transcripts/alias')); 
    await fs.symlink(os.tmpdir(), path.join(f.root, 'agents/a/workspace/outside'));
    await fs.symlink(f.root, path.join(f.root, 'agents/a/workspace/cycle'));
    const result = await scanStorage(f.source);
    const stat = await fs.stat(p), dir = await fs.stat(path.dirname(p));
    assert.equal(result.agents[0].workspace, (stat.blocks + dir.blocks) * 512);
    assert.equal(result.status, 'complete');
  } finally { await f.close(); }
});

test('a nested registered worktree is subtracted from workspace and counted once', async () => {
  const f = await fixture();
  try {
    await f.file('agents/a/workspace/tree/file', 16384);
    f.source.agents[0].worktree = { path: path.join(f.root, 'agents/a/workspace/tree') } as Agent['worktree'];
    const r = await scanStorage(f.source);
    assert.ok(r.agents[0].worktrees >= 16384);
    assert.equal(r.agents[0].workspace, (await fs.stat(path.join(f.root, 'agents/a/workspace'))).blocks * 512);
  } finally { await f.close(); }
});

test('storage caches for 60 seconds, coalesces forced refreshes, and invalidates', async () => {
  const f = await fixture();
  try {
    const usage = new StorageUsage(() => f.source);
    const first = usage.get(), second = usage.get(true);
    assert.equal(first, second);
    const a = await first; await f.file('new', 16384);
    assert.equal(await usage.get(), a);
    const b = await usage.get(true); assert.ok(b.total > a.total);
    usage.invalidate(); assert.notEqual(await usage.get(), b);
    const expired = new StorageUsage(() => f.source, -1);
    assert.notEqual(await expired.get(), await expired.get());
  } finally { await f.close(); }
});

test('missing data is reported as an error, missing optional worktrees is not', async () => {
  const f = await fixture();
  try {
    assert.equal((await scanStorage(f.source)).status, 'complete');
    f.source.dataDir = path.join(f.root, 'missing');
    const r = await scanStorage(f.source); assert.equal(r.status, 'error'); assert.ok(r.errors > 0);
  } finally { await f.close(); }
});

test('Reveal accepts only known managed folders and rejects symlink escapes and arbitrary paths', async () => {
  const f = await fixture(), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'podcode-storage-outside-'));
  const opened: string[] = [], app = express(); app.use(express.json());
  registerStorageRoutes(app, () => f.source, async p => { opened.push(p); });
  app.use((err: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(err.status ?? 500).json({ error: err.message }); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => fetch(url + '/api/storage/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ path: outside })).status, 400);
    assert.equal((await post({ agentId: '../outside' })).status, 404);
    await fs.mkdir(path.join(f.root, 'agents'), { recursive: true }); await fs.symlink(outside, path.join(f.root, 'agents/a'));
    assert.equal((await post({ agentId: 'a' })).status, 403);
    assert.equal((await post({ target: 'data' })).status, 200); assert.deepEqual(opened, [await fs.realpath(f.root)]);
    assert.equal((await fetch(url + '/api/storage')).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); await fs.rm(outside, { recursive: true }); }
});

test('an unreadable subtree is partial, not silently zero, and I/O concurrency stays bounded', async t => {
  const f = await fixture();
  try {
    for (let i = 0; i < 40; i++) await f.file(`agents/a/workspace/file-${i}`, 4096);
    const original = fs.lstat;
    let pending = 0, peak = 0;
    t.mock.method(fs, 'lstat', async (...args: Parameters<typeof fs.lstat>) => {
      pending++; peak = Math.max(peak, pending);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (String(args[0]).endsWith('file-5')) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
        return await original(...args);
      } finally { pending--; }
    });
    const result = await scanStorage(f.source);
    assert.equal(result.status, 'partial'); assert.equal(result.errors, 1);
    assert.ok(peak > 1 && peak <= 8, `peak=${peak}`);
    assert.ok(result.agents[0].workspace > 0);
  } finally { t.mock.restoreAll(); await f.close(); }
});
