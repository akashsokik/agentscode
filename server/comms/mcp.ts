// Stdio MCP server started by each agent process. It forwards every tool call to the
// IDE over localhost HTTP; the bearer token tells the IDE which agent is calling.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCommsMcpServer } from './tools.ts';

const token = process.env.AGENTSCODE_TOKEN;
const endpoint = process.env.AGENTSCODE_TOOLS_URL;
if (!token || !endpoint) throw new Error('AgentsCode comms credentials are missing.');

const server = createCommsMcpServer(async (tool, args) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
    // Browser ops wait on page loads (up to 45s on the server); everything else answers quickly.
    signal: AbortSignal.timeout(tool.startsWith('browser_') ? 50_000 : 10_000),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `AgentsCode request failed (${response.status}).`);
  return result;
});
await server.connect(new StdioServerTransport());
