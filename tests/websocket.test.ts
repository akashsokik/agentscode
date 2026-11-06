import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { ServerEvent } from '../shared/types.ts';
import { createServer } from '../server/app.ts';
import { Hub } from '../server/hub.ts';
import { AgentManager } from '../server/manager.ts';
import { Store } from '../server/store.ts';
import { projectDir, tempDir } from './helpers.ts';

async function boot(distDir?: string) {
  const dir = tempDir('ws');
  const store = new Store(path.join(dir, 'data'));
  store.load();
  const hub = new Hub();
  const engine = { available: false, path: null, version: null };
  const manager = new AgentManager(store, hub, { claude: engine, codex: engine, orcacode: engine });
  manager.init();
  const server = createServer(manager, hub, { distDir });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { dir, server, port };
}

/** Collect events from a socket; `next` resolves with the next one, buffered or future. */
function listen(ws: WebSocket) {
  const queue: ServerEvent[] = [];
  const waiters: ((event: ServerEvent) => void)[] = [];
  ws.on('message', data => {
    const event = JSON.parse(String(data)) as ServerEvent;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else queue.push(event);
  });
  return {
    next: () => new Promise<ServerEvent>((resolve, reject) => {
      const queued = queue.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(() => reject(new Error('No event arrived.')), 3000);
      waiters.push(event => { clearTimeout(timer); resolve(event); });
    }),
  };
}

test('a local socket gets a snapshot, then live events', async () => {
  const { dir, server, port } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://localhost:5174' } });
  try {
    const events = listen(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const first = await events.next();
    assert.equal(first.type, 'snapshot');
    // The open terminals follow the snapshot; they have their own feed event.
    assert.deepEqual(await events.next(), { type: 'terminals', terminals: [] });
    const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: projectDir(dir, 'live') }),
    });
    assert.equal(response.status, 201);
    const next = await events.next();
    assert.equal(next.type, 'project');
  } finally {
    ws.close();
    server.close();
  }
});

test('sockets from other origins are refused', async () => {
  const { server, port } = await boot();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://evil.example' } });
    const outcome = await new Promise<string>(resolve => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('refused'));
    });
    assert.equal(outcome, 'refused');
  } finally {
    server.close();
  }
});

test('the built app is served for client routes, the API keeps JSON 404s', async () => {
  const dist = tempDir('dist');
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>AgentsCode</title>');
  const { server, port } = await boot(dist);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/some/client/route`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /AgentsCode/);
    const missing = await fetch(`http://127.0.0.1:${port}/api/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Not found.' });
  } finally {
    server.close();
  }
});
