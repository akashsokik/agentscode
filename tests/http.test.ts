import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { resolveInside } from '../server/workspace.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir } from './helpers.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';

/** fetch() ignores a custom Host header, so DNS-rebinding checks need a raw request. */
function statusWithHost(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: host } }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve() {
  const h = harness();
  const root = projectDir(h.dir, 'site');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(h.dir, 'secret.txt'), 'top secret');
  const project = h.manager.addProject({ path: root });
  const server = createApp(h.manager, undefined, undefined, OPEN_AUTH).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  return { h, project, server, url, port };
}

test('the API refuses foreign hosts and cross-origin writes', async () => {
  const { server, url, port } = await serve();
  try {
    assert.equal(await statusWithHost(port, 'evil.example'), 403);
    assert.equal(await statusWithHost(port, `localhost:${port}`), 200);
    const crossOrigin = await fetch(url('/api/settings'), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ messageLimit: 0 }),
    });
    assert.equal(crossOrigin.status, 403);
    const local = await fetch(url('/api/state'));
    assert.equal(local.status, 200);
  } finally {
    server.close();
  }
});

test('the comms endpoint rejects calls without a valid token', async () => {
  const { server, url } = await serve();
  try {
    const response = await fetch(url('/api/comms'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: JSON.stringify({ tool: 'list_agents', args: {} }),
    });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test('the file API reads inside the project and nowhere else', async () => {
  const { server, url, project } = await serve();
  try {
    const ok = await fetch(url(`/api/files/read?project=${project.id}&path=index.ts`));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as { text: string }).text, 'export const x = 1;\n');
    const escape = await fetch(url(`/api/files/read?project=${project.id}&path=${encodeURIComponent('../secret.txt')}`));
    assert.equal(escape.status, 403);
    const tree = await (await fetch(url(`/api/files/tree?project=${project.id}`))).json() as { entries: { name: string }[] };
    assert.deepEqual(tree.entries.map(e => e.name), ['index.ts']);
  } finally {
    server.close();
  }
});

test('symlinks cannot reach outside the workspace', () => {
  const { dir } = harness();
  const root = projectDir(dir, 'ws');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'x');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(root, 'link.txt'));
  assert.throws(() => resolveInside(root, 'link.txt'), e => e instanceof HttpError && e.status === 403);
  assert.throws(() => resolveInside(root, '../outside.txt'), e => e instanceof HttpError && e.status === 403);
  assert.equal(resolveInside(root, ''), fs.realpathSync(root));
});

test('the stdio comms MCP server reaches the IDE as the calling agent', async () => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { commsMcpConfig } = await import('../server/comms/tools.ts');
  const { server, port, h, project } = await serve();
  try {
    const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
    const bo = await h.manager.create({ name: 'Bo', engine: 'codex', projectId: project.id });
    h.manager.send(ada.id, 'Talk to Bo');
    const token = h.runner(ada.id).ctx.commsToken!;
    const config = commsMcpConfig(token);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...config.env, PODCODE_TOOLS_URL: `http://127.0.0.1:${port}/api/comms`, PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'agent', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.callTool({ name: 'list_agents', arguments: {} });
      const roster = JSON.parse((listed.content as { text: string }[])[0].text) as { id: string }[];
      assert.deepEqual(roster.map(r => r.id), [bo.id]);
      const sent = await client.callTool({ name: 'send_message', arguments: { to_agent_id: bo.id, text: 'Hello from Ada' } });
      assert.equal(sent.isError, undefined);
      assert.equal(h.store.messages.at(-1)?.fromAgentId, ada.id);
      assert.equal(h.store.messages.at(-1)?.text, 'Hello from Ada');
    } finally {
      await client.close();
    }
  } finally {
    server.close();
  }
});

test('images upload as raw bytes and come back typed by their content, to their own agent only', async () => {
  const { h, project, server, url } = await serve();
  try {
    const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
    const bo = await h.manager.create({ name: 'Bo', engine: 'claude', projectId: project.id });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const upload = (agentId: string, body: Buffer) => fetch(url(`/api/agents/${agentId}/attachments`), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'shot.png' }, body,
    });
    const created = await upload(ada.id, png);
    assert.equal(created.status, 201);
    const image = await created.json() as { id: string; name: string };
    assert.equal(image.name, 'shot.png');

    const served = await fetch(url(`/api/agents/${ada.id}/attachments/${image.id}`));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('cache-control') ?? '', /immutable/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    assert.equal((await fetch(url(`/api/agents/${bo.id}/attachments/${image.id}`))).status, 404);
    // A miss must not be cached for a year or labelled as an image: that is what left screenshots broken for good.
    const missing = await fetch(url(`/api/agents/${bo.id}/attachments/${image.id}`));
    assert.doesNotMatch(missing.headers.get('cache-control') ?? '', /immutable/);
    assert.doesNotMatch(missing.headers.get('content-type') ?? '', /^image\//);

    const svg = await upload(ada.id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    assert.equal(svg.status, 415);
    const huge = await upload(ada.id, Buffer.concat([png, Buffer.alloc(5_000_000)]));
    assert.equal(huge.status, 413);
    assert.match((await huge.json() as { error: string }).error, /too large/);

    const sent = await fetch(url(`/api/agents/${ada.id}/messages`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '', images: [{ id: image.id, name: image.name }] }),
    });
    assert.equal(sent.status, 202);
  } finally {
    server.close();
  }
});

test('channel images upload as raw bytes, post with the message, and are served from that channel only', async () => {
  const { h, project, server, url } = await serve();
  try {
    const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
    const channel = h.manager.createChannel({ name: 'design', memberIds: [ada.id] });
    const other = h.manager.createChannel({ name: 'other', memberIds: [] });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);
    const created = await fetch(url(`/api/channels/${channel.id}/attachments`), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'mock.png' }, body: png,
    });
    assert.equal(created.status, 201);
    const image = await created.json() as { id: string; name: string };

    const served = await fetch(url(`/api/channels/${channel.id}/attachments/${image.id}`));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
    assert.equal((await fetch(url(`/api/channels/${other.id}/attachments/${image.id}`))).status, 404);
    assert.equal((await fetch(url(`/api/channels/nope/attachments/${image.id}`))).status, 404);

    const posted = await fetch(url(`/api/channels/${channel.id}/posts`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '', mentions: [ada.id], images: [{ id: image.id, name: image.name }] }),
    });
    assert.equal(posted.status, 201);
    const post = await posted.json() as { images?: { id: string }[] };
    assert.deepEqual(post.images?.map(i => i.id), [image.id]);
  } finally {
    server.close();
  }
});
