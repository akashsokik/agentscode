import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedReason, findLocalUrls, formatAXTree, isLocalUrl, keyEvent, normalizeAddress, type AXNode } from '../shared/browserPolicy.ts';
import { closeTab, getLayout, open, pruneTabs, tabKey, updateBrowserTab } from '../web/layout.ts';

test('typed addresses become URLs: local hosts get http, others https, and non-addresses are refused', () => {
  assert.equal(normalizeAddress('localhost:3000'), 'http://localhost:3000/');
  assert.equal(normalizeAddress('127.0.0.1:5173/app'), 'http://127.0.0.1:5173/app');
  assert.equal(normalizeAddress('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeAddress('  https://x.dev/a?b=1 '), 'https://x.dev/a?b=1');
  assert.equal(normalizeAddress('file:///etc/passwd'), null);
  assert.equal(normalizeAddress('javascript:alert(1)'), null);
  assert.equal(normalizeAddress('how do I center a div'), null);
  assert.equal(normalizeAddress(''), null);
});

test('the browser opens only http(s), and never AgentsCode itself', () => {
  assert.equal(blockedReason('http://localhost:3000/', 4320), null);
  assert.equal(blockedReason('https://example.com/', 4320), null);
  assert.match(blockedReason('http://127.0.0.1:4320/api/state', 4320)!, /AgentsCode itself/);
  assert.match(blockedReason('http://localhost:4320/', 4320)!, /AgentsCode itself/);
  assert.match(blockedReason('http://[::1]:4320/', 4320)!, /AgentsCode itself/);
  assert.match(blockedReason('file:///tmp/x.html', 4320)!, /http and https/);
  assert.match(blockedReason('data:text/html,hi', 4320)!, /http and https/);
  assert.match(blockedReason('not a url', 4320)!, /valid URL/);
  assert.equal(isLocalUrl('http://localhost:1/'), true);
  assert.equal(isLocalUrl('https://localhost.example.com/'), false);
});

test('dev server URLs are found in coloured terminal output, once each', () => {
  const output = '\x1b[32m  ➜  Local:\x1b[39m   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n'
    + '  Network: http://0.0.0.0:3000/app.\n  ready on http://127.0.0.1:8080, again http://127.0.0.1:8080\n  see https://vite.dev for docs';
  assert.deepEqual(findLocalUrls(output), ['http://localhost:5173/', 'http://localhost:3000/app', 'http://127.0.0.1:8080/']);
  assert.deepEqual(findLocalUrls('nothing here, not even localhost'), []);
});

test('the accessibility tree reads as indented lines with refs on what an agent can act on', () => {
  const nodes: AXNode[] = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Todo' }, childIds: ['2', '3'] },
    { nodeId: '2', parentId: '1', role: { value: 'generic' }, childIds: ['4', '5', '6'] },
    { nodeId: '3', parentId: '1', role: { value: 'link' }, name: { value: 'Docs' }, backendDOMNodeId: 30, properties: [{ name: 'url', value: { value: 'https://x.dev/' } }], childIds: ['7'] },
    { nodeId: '4', parentId: '2', role: { value: 'heading' }, name: { value: 'Tasks' }, childIds: ['8'] },
    { nodeId: '5', parentId: '2', role: { value: 'textbox' }, name: { value: 'New task' }, value: { value: 'milk' }, backendDOMNodeId: 50, properties: [{ name: 'focused', value: { value: true } }] },
    { nodeId: '6', parentId: '2', role: { value: 'checkbox' }, name: { value: 'Done' }, backendDOMNodeId: 60, properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'disabled', value: { value: false } }] },
    { nodeId: '7', parentId: '3', role: { value: 'StaticText' }, name: { value: 'Docs' } },
    { nodeId: '8', parentId: '4', role: { value: 'StaticText' }, name: { value: 'Tasks' } },
  ];
  const { text, refs, truncated } = formatAXTree(nodes, 10_000);
  assert.equal(text, [
    '- RootWebArea "Todo"',
    '  - heading "Tasks"',
    '  - textbox "New task" value="milk" focused [e1]',
    '  - checkbox "Done" checked=true [e2]',
    '  - link "Docs" -> https://x.dev/ [e3]',
  ].join('\n'));
  assert.deepEqual([...refs], [['e1', 50], ['e2', 60], ['e3', 30]]);
  assert.equal(truncated, false);
  const cut = formatAXTree(nodes, 60);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 60);
});

test('browser_press knows named keys and single characters', () => {
  assert.deepEqual(keyEvent('Enter'), { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  assert.equal(keyEvent('Escape')?.text, undefined);
  assert.deepEqual(keyEvent('a'), { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
  assert.equal(keyEvent('7')?.code, 'Digit7');
  assert.equal(keyEvent('Space')?.key, ' ');
  assert.equal(keyEvent('Hyper'), null);
});

test('a browser tab is keyed by its id, follows its page, and closes with the agent that owns it', () => {
  assert.equal(tabKey({ kind: 'browser', id: 'b1', url: 'http://localhost:3000/' }), 'browser:b1');
  open({ kind: 'browser', id: 'b1', url: 'http://localhost:3000/' });
  open({ kind: 'browser', id: 'b1', url: 'http://localhost:3000/other' });
  const tabs = () => getLayout().tabs.filter(t => t.content.kind === 'browser');
  assert.equal(tabs().length, 1, 'opening the same id again focuses the tab, never a duplicate');
  updateBrowserTab('b1', { url: 'http://localhost:3000/next', title: 'Next' });
  assert.deepEqual(tabs()[0].content, { kind: 'browser', id: 'b1', url: 'http://localhost:3000/next', title: 'Next' });
  open({ kind: 'browser', id: 'b2', url: 'http://localhost:5173/', agentId: 'ada' });
  pruneTabs(new Set(['someone-else']), new Set());
  assert.deepEqual(tabs().map(t => (t.content as { id: string }).id), ['b1'], "the agent's tab goes with the agent; the user's stays");
  closeTab(tabs()[0].id);
  assert.equal(tabs().length, 0);
});
