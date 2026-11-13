import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { buildId } from '../shared/buildInfo.ts';
import type { ServerEvent } from '../shared/types.ts';
import { readBuildId } from '../server/buildStamp.ts';
import { createServer } from '../server/app.ts';
import { Hub } from '../server/hub.ts';
import { AgentManager } from '../server/manager.ts';
import { Store } from '../server/store.ts';
import { staleAction, typedOutsideComposers } from '../shared/staleBuild.ts';
import { draftsHaveText, registerDraftStore, stashDrafts } from '../web/draftStore.ts';
import { tempDir } from './helpers.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';

// A page left open from an older build reloads (issue ad10ed8e): the server says which build it
// serves, the page compares, and reloads on its own only when nobody is using it, once.

const OLD = buildId({ version: '0.3.1', commit: '2d61cf2', date: '2026-11-12T15:11:19.000Z' });
const NEW = buildId({ version: '0.3.1', commit: 'bc960f4', date: '2026-11-12T15:51:30.000Z' });
const base = { page: OLD, server: NEW, reloadedFor: null, hidden: false, idle: false, unsent: false };

test('a build is named by its version, commit and time; one without a time names nothing', () => {
  assert.equal(OLD, '0.3.1+2d61cf2@2026-11-12T15:11:19.000Z');
  assert.notEqual(OLD, NEW);
  assert.equal(buildId({ version: '0.3.1', commit: 'x', date: '' }), null);
  assert.equal(buildId(null), null);
  assert.equal(buildId({}), null);
});

test('the same build, or one that cannot be read, does nothing', () => {
  assert.equal(staleAction({ ...base, server: OLD, hidden: true }), 'none');
  assert.equal(staleAction({ ...base, page: null, hidden: true }), 'none', 'a page with no stamp (npm run dev) never compares');
  assert.equal(staleAction({ ...base, server: null, hidden: true }), 'none', 'a server with no build.json');
  assert.equal(staleAction({ ...base, server: undefined, hidden: true }), 'none', 'before the server has said');
});

test('an older page reloads on its own only when hidden or idle, and never with text typed', () => {
  assert.equal(staleAction({ ...base, hidden: true }), 'reload');
  assert.equal(staleAction({ ...base, idle: true }), 'reload');
  assert.equal(staleAction(base), 'notice', 'in use: a notice, not a reload under the user');
  assert.equal(staleAction({ ...base, hidden: true, unsent: true }), 'notice', 'typed text is never lost');
  assert.equal(staleAction({ ...base, idle: true, unsent: true }), 'notice');
});

test('no reload loop: once reloaded for a server build, a page still different only shows the notice', () => {
  // First pass: hidden, nothing typed: reload, remembering the build it reloaded for.
  let reloadedFor: string | null = null;
  const first = staleAction({ ...base, hidden: true, reloadedFor });
  assert.equal(first, 'reload');
  reloadedFor = NEW;
  // The reloaded page is still the old build (a cached page, a server serving an old dist): no second reload.
  for (const state of [{ hidden: true, idle: false }, { hidden: false, idle: true }, { hidden: true, idle: true }]) {
    assert.equal(staleAction({ ...base, ...state, reloadedFor }), 'notice');
  }
  // A later, different server build may reload once more.
  const NEWER = buildId({ version: '0.3.2', commit: 'abcdef0', date: '2026-11-13T09:00:00.000Z' });
  assert.equal(staleAction({ ...base, server: NEWER, hidden: true, reloadedFor }), 'reload');
});

test('the server reads the build it serves from build.json beside the page; anything else is null', () => {
  const dist = tempDir('stale-dist');
  assert.equal(readBuildId(dist), null, 'no build.json');
  assert.equal(readBuildId(undefined), null);
  fs.writeFileSync(path.join(dist, 'build.json'), 'not json');
  assert.equal(readBuildId(dist), null);
  fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ version: '0.3.1', commit: 'bc960f4', date: '2026-11-12T15:51:30.000Z' }));
  assert.equal(readBuildId(dist), NEW);
});

test('every new connection is told the build the server serves now, read afresh each time', async () => {
  const dir = tempDir('stale-ws');
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ version: '0.3.1', commit: '2d61cf2', date: '2026-11-12T15:11:19.000Z' }));
  const store = new Store(path.join(dir, 'data'));
  store.load();
  const hub = new Hub();
  const engine = { available: false, path: null, version: null };
  const manager = new AgentManager(store, hub, { claude: engine, codex: engine, orcacode: engine });
  manager.init();
  const server = createServer(manager, hub, { distDir: dist, auth: OPEN_AUTH });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const buildEvent = () => new Promise<ServerEvent>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://localhost:5174' } });
    const timer = setTimeout(() => reject(new Error('no build event')), 3000);
    ws.on('message', data => {
      const event = JSON.parse(String(data)) as ServerEvent;
      if (event.type === 'build') { clearTimeout(timer); ws.close(); resolve(event); }
    });
  });
  try {
    assert.deepEqual(await buildEvent(), { type: 'build', id: OLD });
    // Rebuilt while the server runs: the next page compares with the new build, never with itself.
    fs.writeFileSync(path.join(dist, 'build.json'), JSON.stringify({ version: '0.3.1', commit: 'bc960f4', date: '2026-11-12T15:51:30.000Z' }));
    assert.deepEqual(await buildEvent(), { type: 'build', id: NEW });
  } finally {
    server.close();
  }
});

test('composer drafts count as unsent text and come back after a reload in the same tab', () => {
  const session = new Map<string, string>();
  const fake = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); }, removeItem: (k: string) => { session.delete(k); } };
  const saved = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = fake;
  try {
    const before = new Map<string, string>([['a1', 'half a message'], ['a2', '  ']]);
    registerDraftStore('test-agent', before);
    assert.equal(draftsHaveText(), true);
    stashDrafts();
    assert.match(session.get('podcode:drafts-before-reload') ?? '', /half a message/);
    assert.doesNotMatch(session.get('podcode:drafts-before-reload') ?? '', /"a2"/, 'blank drafts are not kept');
    // The page loads again: the composer's empty map is filled back in, and the stash is cleared.
    const after = new Map<string, string>();
    registerDraftStore('test-agent', after);
    assert.equal(after.get('a1'), 'half a message');
    assert.equal(session.has('podcode:drafts-before-reload'), false);
    after.set('a1', '');
    assert.equal(draftsHaveText(), false);
  } finally {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = saved;
  }
});

test('Reload asks first whenever a field outside the composers has text, drafts or not (review M1)', () => {
  const draft = { value: 'half a message to Ada', draft: true };
  const issue = { value: 'Stale tabs reload', draft: false };
  assert.equal(typedOutsideComposers([draft, issue]), true, 'a draft plus a half-typed issue: ask');
  assert.equal(typedOutsideComposers([issue]), true);
  assert.equal(typedOutsideComposers([draft]), false, 'only drafts: they are kept, so no question');
  assert.equal(typedOutsideComposers([{ value: '   ', draft: false }]), false, 'blank fields do not count');
  assert.equal(typedOutsideComposers([]), false);
});

test('the browser pane\'s address bar counts only once the user changed it (review L1)', () => {
  const url = 'http://localhost:5173/';
  assert.equal(typedOutsideComposers([{ value: url, draft: false, baseline: url }]), false, 'showing its page\'s address');
  assert.equal(typedOutsideComposers([{ value: 'http://localhost:5173/sett', draft: false, baseline: url }]), true, 'being edited');
  assert.equal(typedOutsideComposers([{ value: url, draft: false, baseline: null }]), true, 'a field without a baseline counts as typed');
});
