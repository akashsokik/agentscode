import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BROWSER_UNAVAILABLE, BrowserBridge, attachParentPort, bridgeTokenMatches, writeBridgeToken, type BridgeTransport } from '../server/browserBridge.ts';
import { browserSummary } from '../server/agents/describe.ts';
import { browserScreenshot, presentTool } from '../web/toolPresentation.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

/** A stand-in for the desktop app's main process: records requests, answers when told. */
function fakeMain() {
  const sent: Record<string, any>[] = [];
  const transport: BridgeTransport = { send: message => sent.push(message as Record<string, any>) };
  return { sent, transport, last: () => sent[sent.length - 1] };
}

test('the bridge is unavailable until main says hello', async () => {
  const bridge = new BrowserBridge();
  await assert.rejects(bridge.request('a', 'list', {}), new RegExp(BROWSER_UNAVAILABLE));
  const main = fakeMain();
  bridge.connect(main.transport);
  await assert.rejects(bridge.request('a', 'list', {}), new RegExp(BROWSER_UNAVAILABLE));
  bridge.receive({ type: 'browser:hello', version: 1 });
  assert.equal(bridge.available, true);
});

test('requests carry the envelope; answers resolve, and main\'s error text passes through', async () => {
  const bridge = new BrowserBridge();
  const main = fakeMain();
  bridge.connect(main.transport);
  bridge.receive({ type: 'browser:hello', version: 1 });

  const opening = bridge.request('agent-1', 'open', { url: 'http://localhost:3000/' });
  const request = main.last();
  assert.equal(request.type, 'browser:request');
  assert.equal(request.agentId, 'agent-1');
  assert.equal(request.op, 'open');
  assert.deepEqual(request.args, { url: 'http://localhost:3000/' });
  assert.match(request.id, /^[0-9a-f-]{36}$/);
  bridge.receive({ type: 'browser:response', id: request.id, ok: true, result: { tab_id: 't1', title: 'Home' } });
  assert.deepEqual(await opening, { tab_id: 't1', title: 'Home' });

  const clicking = bridge.request('agent-1', 'click', { tab_id: 't1', ref: 'e9' });
  bridge.receive({ type: 'browser:response', id: main.last().id, ok: false, error: 'No element e9; take a new snapshot.' });
  await assert.rejects(clicking, /No element e9; take a new snapshot\./);

  // Unknown ids and junk are ignored.
  bridge.receive({ type: 'browser:response', id: 'nope', ok: true });
  bridge.receive('junk');
});

test('a request with no answer times out; a replaced or closed connection fails what it was carrying', async () => {
  const bridge = new BrowserBridge(30);
  const first = fakeMain();
  const detachFirst = bridge.connect(first.transport);
  bridge.receive({ type: 'browser:hello', version: 1 });
  await assert.rejects(bridge.request('a', 'snapshot', { tab_id: 't' }), /did not answer within 0s/);

  const slow = new BrowserBridge(60_000);
  const a = fakeMain();
  slow.connect(a.transport);
  slow.receive({ type: 'browser:hello', version: 1 });
  const pending = slow.request('x', 'list', {});
  const b = fakeMain();
  const detachB = slow.connect(b.transport); // the newest connection wins
  await assert.rejects(pending, /replaced/);
  assert.equal(slow.available, false, 'the new connection must say hello first');
  slow.receive({ type: 'browser:response', id: a.last().id, ok: true }, a.transport); // late answer on the old one: ignored
  slow.receive({ type: 'browser:hello', version: 1 }, b.transport);
  const onB = slow.request('x', 'list', {});
  detachB();
  await assert.rejects(onB, /closed the browser connection/);
  assert.equal(slow.available, false);
  detachFirst(); // detaching a connection that was already replaced changes nothing
});

test('agent removal is sent to main only while the bridge is up', () => {
  const bridge = new BrowserBridge();
  const main = fakeMain();
  bridge.connect(main.transport);
  bridge.agentRemoved('gone');
  assert.equal(main.sent.length, 0);
  bridge.receive({ type: 'browser:hello', version: 1 });
  bridge.agentRemoved('gone');
  assert.deepEqual(main.last(), { type: 'browser:agent-removed', agentId: 'gone' });
});

test('the parentPort transport carries the same envelope', async () => {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  const posted: any[] = [];
  const port = { on: (_: 'message', listener: (event: { data: unknown }) => void) => { listeners.push(listener); }, postMessage: (m: unknown) => { posted.push(m); } };
  const bridge = new BrowserBridge();
  assert.equal(attachParentPort(bridge, undefined), false);
  assert.equal(attachParentPort(bridge, port), true);
  // Main's first hello may have come before the listener: the server asks again.
  assert.deepEqual(posted.shift(), { type: 'browser:ping' });
  listeners[0]({ data: { type: 'browser:hello', version: 1 } });
  const listing = bridge.request('a', 'list', {});
  listeners[0]({ data: { type: 'browser:response', id: posted[0].id, ok: true, result: { tabs: [] } } });
  assert.deepEqual(await listing, { tabs: [] });
});

test('the socket token is private to the user, fresh each start, and checked in constant time', () => {
  const dir = tempDir('bridge');
  const one = writeBridgeToken(dir);
  const file = path.join(dir, 'browser-bridge.token');
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(file, 'utf8'), one);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const two = writeBridgeToken(dir);
  assert.notEqual(two, one);
  assert.equal(bridgeTokenMatches(two, two), true);
  assert.equal(bridgeTokenMatches(two, one), false);
  assert.equal(bridgeTokenMatches(two, two.slice(1)), false);
  assert.equal(bridgeTokenMatches(two, undefined), false);
  assert.equal(bridgeTokenMatches('', ''), false);
});

test('browser calls read as short rows, and a screenshot row finds its file', () => {
  assert.equal(browserSummary('open', { url: 'http://localhost:3000/login' }), 'localhost:3000/login');
  assert.equal(browserSummary('type', { ref: 'e4', text: 'ada@example.com', submit: true }), 'e4 "ada@example.com" and Enter');
  assert.deepEqual(presentTool({ name: 'mcp__agentscode__browser_open', summary: 'localhost:3000/login', status: 'ok' }), { action: 'Opened', target: 'localhost:3000/login' });
  assert.deepEqual(presentTool({ name: 'agentscode.browser_snapshot', summary: 'agentscode.browser_snapshot', status: 'ok' }), { action: 'Read page', target: '' });
  const clicked = { name: 'mcp__agentscode__browser_click', summary: 'e12', status: 'ok' as const, output: JSON.stringify({ url: 'http://localhost:3000/', title: 'Home', input: 'synthetic' }) };
  assert.deepEqual(presentTool(clicked), { action: 'Clicked', target: 'e12 (synthetic input)' });
  assert.deepEqual(presentTool({ ...clicked, output: JSON.stringify({ url: 'x', title: 'y', input: 'trusted' }) }), { action: 'Clicked', target: 'e12' });
  const shot = { name: 'mcp__agentscode__browser_screenshot', summary: 't1', status: 'ok' as const, output: JSON.stringify({ path: '/Users/me/.agentscode/agents/x/browser/2026-11-08T13-00-00-000Z-t1.png', width: 1280, height: 800 }) };
  assert.equal(browserScreenshot(shot), '2026-11-08T13-00-00-000Z-t1.png');
  assert.equal(browserScreenshot({ ...shot, status: 'error' }), null);
  assert.equal(browserScreenshot({ ...shot, output: JSON.stringify({ path: '/x/../../etc/passwd' }) }), null);
});

test('agents\' browser tools: plan-only limits, the scripts setting, URL check, screenshot path, removal', async () => {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const reader = await h.manager.create({ name: 'Reader', engine: 'claude', projectId: web.id, autonomy: 'readonly' });
  const main = fakeMain();
  h.manager.browser.connect(main.transport);
  h.manager.browser.receive({ type: 'browser:hello', version: 1 });
  // main answers every request with its own op, so the test sees what reached it.
  const answer = () => { const r = main.last(); h.manager.browser.receive({ type: 'browser:response', id: r.id, ok: true, result: { op: r.op, args: r.args } }); };
  const call = async (agentId: string, tool: string, args: Record<string, unknown>) => {
    const pending = h.manager.commsTool(h.runner(agentId).ctx.commsToken!, tool, args);
    pending.catch(() => {}); // refusals are asserted by the caller; mark them handled while main answers
    await settle();
    if (main.sent.length && main.last().type === 'browser:request' && !(main.last() as { answered?: boolean }).answered) { answer(); (main.last() as { answered?: boolean }).answered = true; }
    return pending as Promise<{ op: string; args: Record<string, unknown> }>;
  };
  h.manager.send(ada.id, 'Go.');
  h.manager.send(reader.id, 'Look.');
  await settle();

  const opened = await call(ada.id, 'browser_open', { url: 'localhost:3000' });
  assert.deepEqual(opened, { op: 'open', args: { url: 'http://localhost:3000/' } });
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) await assert.rejects(call(ada.id, 'browser_open', { url: bad }), /not a web address/, bad);
  await assert.rejects(call(ada.id, 'browser_open', { url: 'http://127.0.0.1:4320/' }), /does not open AgentsCode itself/);
  assert.equal((await call(ada.id, 'browser_open', { url: 'example.com/docs' })).args.url, 'https://example.com/docs');

  const shot = await call(ada.id, 'browser_screenshot', { tab_id: 't1' });
  const shotPath = String(shot.args.path);
  assert.ok(shotPath.startsWith(path.join(ada.home, 'browser') + path.sep), shotPath);
  assert.match(shotPath, /-t1\.png$/);
  fs.writeFileSync(shotPath, 'png');
  assert.equal(h.manager.browserShot(ada.id, path.basename(shotPath)).path, shotPath);
  assert.throws(() => h.manager.browserShot(ada.id, '../soul.md'), /No such screenshot/);

  // Plan-only agents can look but not touch.
  assert.equal((await call(reader.id, 'browser_snapshot', { tab_id: 't2' })).op, 'snapshot');
  assert.equal((await call(reader.id, 'browser_console', { tab_id: 't2', since: 3 })).op, 'console');
  for (const [tool, args] of [['browser_click', { tab_id: 't2', ref: 'e1' }], ['browser_type', { tab_id: 't2', ref: 'e1', text: 'x' }], ['browser_press', { tab_id: 't2', key: 'Enter' }], ['browser_close', { tab_id: 't2' }], ['browser_eval', { tab_id: 't2', expression: '1' }]] as const) {
    await assert.rejects(call(reader.id, tool, args), /Plan-only agents/, tool);
  }

  // Scripts need the setting, which is off by default.
  assert.equal(h.store.settings.browserEval, false);
  await assert.rejects(call(ada.id, 'browser_eval', { tab_id: 't1', expression: 'document.title' }), /Browser scripts in Settings/);
  h.manager.updateSettings({ browserEval: true });
  assert.equal((await call(ada.id, 'browser_eval', { tab_id: 't1', expression: 'document.title' })).op, 'eval');

  await assert.rejects(call(ada.id, 'browser_click', { tab_id: 't1' }), /Check the browser_click arguments/);

  // Removing an agent tells main to close its tabs.
  await h.manager.remove(reader.id);
  assert.deepEqual(main.last(), { type: 'browser:agent-removed', agentId: reader.id });
});

test('without the desktop app, browser tools say so', async () => {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  h.manager.send(ada.id, 'Go.');
  await settle();
  await assert.rejects(h.manager.commsTool(h.runner(ada.id).ctx.commsToken!, 'browser_list', {}), new RegExp(BROWSER_UNAVAILABLE));
});

test('the bridge socket takes main only: right token, no Origin; then requests flow both ways', async () => {
  const { createServer } = await import('../server/app.ts');
  const { Hub } = await import('../server/hub.ts');
  const { default: WebSocket } = await import('ws');
  const h = harness();
  const token = 'a'.repeat(64);
  const server = createServer(h.manager, new Hub(), { bridgeToken: token });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/browser-bridge`;
  const refused = (headers: Record<string, string>) => new Promise<boolean>(resolve => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); resolve(false); });
    ws.on('error', () => resolve(true));
  });
  try {
    assert.equal(await refused({}), true, 'no token');
    assert.equal(await refused({ 'x-agentscode-bridge': 'b'.repeat(64) }), true, 'wrong token');
    assert.equal(await refused({ 'x-agentscode-bridge': token, Origin: `http://127.0.0.1:${port}` }), true, 'a page, even the app\'s own');

    const ws = new WebSocket(url, { headers: { 'x-agentscode-bridge': token } });
    const pings: unknown[] = [];
    ws.on('message', data => {
      const message = JSON.parse(String(data));
      if (message.type === 'browser:ping') { pings.push(message); return; }
      ws.send(JSON.stringify({ type: 'browser:response', id: message.id, ok: true, result: { tabs: [{ tab_id: 't1' }] } }));
    });
    await new Promise(resolve => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'browser:hello', version: 1 }));
    await settle();
    assert.equal(h.manager.browser.available, true);
    assert.equal(pings.length, 1, 'the server pings a new socket');
    assert.deepEqual(await h.manager.browser.request('a', 'list', {}), { tabs: [{ tab_id: 't1' }] });
    ws.close();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(h.manager.browser.available, false, 'closing the socket takes the browser away');
  } finally {
    server.close();
  }
});

test('console results collapse repeats, keep errors within the budget, and keep the cursor', async () => {
  const { compactConsole } = await import('../server/browserBridge.ts');
  const preload = (n: number) => ({ seq: n, ts: n, level: 'warn', source: 'console', text: `The resource https://cdn.example/${n}.png was preloaded using link preload but not used.` });
  const entries = [
    ...Array.from({ length: 199 }, (_, i) => preload(i + 1)),
    { seq: 200, ts: 200, level: 'error', source: 'exception', text: 'TypeError: x is undefined' },
    { seq: 201, ts: 201, level: 'log', source: 'console', text: 'ready' },
    { seq: 202, ts: 202, level: 'log', source: 'console', text: 'ready' },
  ];
  const out = compactConsole({ entries, next: 203 }) as { entries: { level: string; text: string; count?: number }[]; next: number; omitted?: number };
  assert.equal(out.next, 203);
  assert.equal(out.entries.length, 3);
  assert.equal(out.omitted, undefined);
  assert.equal(out.entries[0].count, 199);
  assert.match(out.entries[0].text, /and 198 more like it, e\.g\. https:\/\/cdn\.example\/2\.png/);
  assert.deepEqual(out.entries.map(e => e.level), ['warn', 'error', 'log'], 'original order is kept');
  assert.match(out.entries[2].text, /^ready \(x2\)$/);

  // Over budget: errors are kept first, and the agent is told how many were left out.
  const noisy = Array.from({ length: 50 }, (_, i) => ({ seq: i, ts: i, level: 'log', source: 'console', text: `step ${i} ${'x'.repeat(200)}` }));
  const tight = compactConsole({ entries: [...noisy, { seq: 99, ts: 99, level: 'error', source: 'console', text: 'boom' }], next: 100 }, 1200) as { entries: { text: string }[]; omitted: number; note: string };
  assert.ok(tight.entries.some(e => e.text === 'boom'));
  assert.ok(tight.omitted > 40);
  assert.match(tight.note, /since=100/);
  assert.ok(JSON.stringify(tight).length < 2000);

  assert.equal(compactConsole('odd'), 'odd');
});

test('a snapshot reads a run of one-word text pieces as one line', async () => {
  const { formatAXTree } = await import('../shared/browser.ts');
  const node = (id: string, role: string, name: string, childIds: string[] = [], parentId?: string) => ({ nodeId: id, role: { value: role }, name: { value: name }, childIds, parentId });
  const words = ['Paris', 'offers', 'modern', 'hotels.'];
  const nodes = [
    node('root', 'RootWebArea', 'Page', ['p'], undefined),
    node('p', 'paragraph', '', [...words.map((_, i) => `w${i}`), 'a', 'w9'], 'root'),
    ...words.map((w, i) => node(`w${i}`, 'StaticText', w, [], 'p')),
    { ...node('a', 'link', 'More', [], 'p'), backendDOMNodeId: 7 },
    node('w9', 'StaticText', 'after the link', [], 'p'),
  ];
  const { text } = formatAXTree(nodes, 10_000);
  assert.equal(text, [
    '- RootWebArea "Page"',
    '  - paragraph',
    '    - StaticText "Paris offers modern hotels."',
    '    - link "More" [e1]',
    '    - StaticText "after the link"',
  ].join('\n'));
});
