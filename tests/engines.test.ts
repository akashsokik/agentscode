import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Agent } from '../shared/types.ts';
import { codexArgs } from '../server/agents/codex.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { COMMS_TOOLS, codexCommsConfig, commsMcpConfig, createCommsMcpServer } from '../server/comms/tools.ts';

const base: Agent = {
  id: 'a1', name: 'Ada', engine: 'codex', projectIds: ['p1'], worktree: null, home: '/tmp/agentscode-test/agents/a1', dreaming: true, model: '', effort: '',
  autonomy: 'edits', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
  currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
  costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
};

test('codex args map autonomy to a sandbox and read the prompt from stdin', () => {
  assert.deepEqual(codexArgs(base), ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-']);
  assert.ok(codexArgs({ ...base, autonomy: 'readonly' }).includes('sandbox_mode="read-only"'));
  assert.ok(codexArgs({ ...base, autonomy: 'full' }).includes('sandbox_mode="danger-full-access"'));
});

test('codex resume puts the thread id before the stdin marker', () => {
  const args = codexArgs({ ...base, sessionId: 'thread-1', model: 'gpt-5', effort: 'high' });
  assert.deepEqual(args.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(args.slice(-2), ['thread-1', '-']);
  assert.ok(args.includes('-m') && args.includes('gpt-5'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
});

test('codex gets the comms server per process, with the worktree git dir writable', () => {
  const worktree = { path: '/w', cwd: '/w', branch: 'agent/ada', base: 'main', baseCommit: 'abc', repoRoot: '/r', gitDir: '/r/.git' };
  const args = codexArgs({ ...base, worktree }, 'secret-token');
  const config = args.find(a => a.startsWith(`mcp_servers.${COMMS_SERVER}=`));
  assert.ok(config, 'the MCP override uses the shared server name');
  assert.match(config!, /AGENTSCODE_TOKEN="secret-token"/);
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/r/.git"]'));
  assert.equal(codexCommsConfig('t'), config!.replace('secret-token', 't'));
});

test('the comms MCP launch config passes the token and endpoint by env only', () => {
  const config = commsMcpConfig('tok');
  assert.equal(config.env.AGENTSCODE_TOKEN, 'tok');
  assert.match(config.env.AGENTSCODE_TOOLS_URL, /^http:\/\/127\.0\.0\.1:\d+\/api\/comms$/);
  assert.ok(config.args[0].endsWith('mcp.ts'));
});

test('the MCP server registers exactly the comms tools and forwards calls', async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const server = createCommsMcpServer(async (tool, args) => { calls.push([tool, args]); return { ok: true, tool }; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), [...COMMS_TOOLS].sort());
  const result = await client.callTool({ name: 'send_message', arguments: { to_agent_id: 'b', text: 'hi' } });
  assert.equal(calls[0][0], 'send_message');
  assert.equal(calls[0][1].expects_reply, true, 'expects_reply defaults to true');
  assert.match(JSON.stringify(result.content), /send_message/);
  await client.close();
});
