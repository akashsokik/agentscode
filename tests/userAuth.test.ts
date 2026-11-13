import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { createApp, createServer } from '../server/app.ts';
import { Hub } from '../server/hub.ts';
import { AgentManager } from '../server/manager.ts';
import { Store } from '../server/store.ts';
import { cookieValue, isOpenRoute, OPEN_ROUTES, USER_COOKIE, USER_HEADER, UserKey } from '../server/userAuth.ts';
import { tempDir } from './helpers.ts';

// The user's key to PodCode's API (issue 4fc2ba28): a process on this Mac without it (an agent's
// shell running curl) gets 401 on every route but the few with their own check.

function boot(key = new UserKey()) {
  const dir = tempDir('user-auth');
  const store = new Store(path.join(dir, 'data'));
  store.load();
  const hub = new Hub();
  const engine = { available: false, path: null, version: null };
  const manager = new AgentManager(store, hub, { claude: engine, codex: engine, orcacode: engine });
  manager.init();
  return { key, manager, hub };
}

async function listen(server: { listen(port: number, host: string): unknown; address(): unknown; once(event: string, cb: () => void): unknown }) {
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('every /api route needs the key but the open few; with it, none is refused (a new route cannot skip the check)', async () => {
  const { key, manager } = boot();
  const app = createApp(manager, undefined, undefined, key);
  const routes = ((app as unknown as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router.stack)
    .filter(layer => layer.route && layer.route.path.startsWith('/api'))
    .flatMap(layer => Object.keys(layer.route!.methods).map(method => ({ method: method.toUpperCase(), path: layer.route!.path })));
  assert.ok(routes.length > 60, `found ${routes.length} routes`);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const refused: string[] = [];
    const open: string[] = [];
    for (const { method, path: route } of routes) {
      const url = base + route.replace(/:(\w+)/g, 'x');
      const init = { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' };
      const without = await fetch(url, init);
      // The key's refusal is marked (WWW-Authenticate: PodCode-User); an open route may still refuse on its own check.
      const keyRefused = without.status === 401 && without.headers.get('www-authenticate') === 'PodCode-User';
      if (isOpenRoute(method, route)) { open.push(`${method} ${route}`); assert.ok(!keyRefused, `${method} ${route} is open`); }
      else if (!keyRefused) refused.push(`${method} ${route}: ${without.status}`);
      await without.body?.cancel();
      const withKey = await fetch(url, { ...init, headers: { ...init.headers, [USER_HEADER]: key.token } });
      assert.notEqual(withKey.headers.get('www-authenticate'), 'PodCode-User', `${method} ${route} with the key`);
      await withKey.body?.cancel();
    }
    assert.deepEqual(refused, [], 'every other route refuses without the key');
    assert.deepEqual(open.sort(), OPEN_ROUTES.filter(r => r.includes(' /api/')).sort(), 'the open routes are exactly the listed ones');
    // A wrong key, a key of the wrong length and the Bearer form all fail.
    for (const headers of [{ [USER_HEADER]: 'f'.repeat(64) }, { [USER_HEADER]: key.token.slice(1) }, { authorization: `Bearer ${key.token}` }]) {
      assert.equal((await fetch(`${base}/api/state`, { headers })).status, 401);
    }
    // Health tells a script only that the server answers and how many agents are busy.
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, busyAgents: 0 });
    // Agents' tool calls keep their own check (a Bearer comms token), never the user's key.
    const comms = await fetch(`${base}/api/comms`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify({ tool: 'list_agents', args: {} }) });
    assert.notEqual(comms.headers.get('www-authenticate'), 'PodCode-User', 'judged by its own Bearer check');
  } finally { server.close(); }
});

test('without the desktop app: a one-time sign-in link sets an HttpOnly cookie that works like the header', async () => {
  const { key, manager } = boot();
  const server = createApp(manager, undefined, undefined, key).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/login?code=nope`, { redirect: 'manual' })).status, 403, 'no code made yet');
    const code = key.newLoginCode();
    const signIn = await fetch(`${base}/login?code=${code}&to=/issues`, { redirect: 'manual' });
    assert.equal(signIn.status, 303);
    assert.equal(signIn.headers.get('location'), '/issues');
    const cookie = signIn.headers.get('set-cookie') ?? '';
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal(cookieValue(cookie.split(';')[0], USER_COOKIE), key.token);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: `${USER_COOKIE}=${key.token}` } })).status, 200);
    assert.equal((await fetch(`${base}/login?code=${code}`, { redirect: 'manual' })).status, 403, 'used once');
    const again = key.newLoginCode();
    assert.equal((await fetch(`${base}/login?code=${again}&to=//evil.example`, { redirect: 'manual' })).headers.get('location'), '/', 'never sends you off-site');
  } finally { server.close(); }
});

test('the app socket and terminal sockets need the key too', async () => {
  const { key, manager, hub } = boot();
  const server = createServer(manager, hub, { auth: key });
  const host = await listen(server);
  const open = (url: string, headers: Record<string, string> = {}) => new Promise<'open' | 'refused'>(resolve => {
    // No Origin, like the desktop app's own requests; the Origin rule is tested in websocket.test.ts.
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });
  try {
    assert.equal(await open(`ws://${host}/ws`), 'refused');
    assert.equal(await open(`ws://${host}/ws/terminal/t1`), 'refused');
    assert.equal(await open(`ws://${host}/ws`, { [USER_HEADER]: key.token }), 'open');
    assert.equal(await open(`ws://${host}/ws`, { cookie: `${USER_COOKIE}=${key.token}` }), 'open');
  } finally { server.close(); }
});

test('an API made without a key refuses everything rather than being open', async () => {
  const { manager } = boot();
  const server = createApp(manager).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/state`)).status, 401);
  } finally { server.close(); }
});
