// Stdio MCP server started by each agent process. It forwards every tool call to the
// IDE over localhost HTTP; the bearer token tells the IDE which agent is calling.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCommsMcpServer } from './tools.ts';

const token = process.env.AGENTSCODE_TOKEN;
const endpoint = process.env.AGENTSCODE_TOOLS_URL;
if (!token || !endpoint) throw new Error('Podcode comms credentials are missing.');

const executive = process.env.AGENTSCODE_EXECUTIVE === '1';
const eyes = process.env.AGENTSCODE_EYES === '1';

const server = createCommsMcpServer(async (tool, args) => {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
    // Browser ops wait on page loads (up to 45s on the server), and creating an agent may build a
    // git worktree: a short timeout there would make the model retry a command that went through.
    // run_check waits on git (20s) or a test run (5 minutes) on the server; the client waits longer.
    signal: AbortSignal.timeout(tool === 'run_check' ? 330_000 : tool.startsWith('browser_') || tool.startsWith('gh_') || tool === 'app_screenshot' || tool === 'create_agent' ? 50_000 : 10_000),
  });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Podcode request failed (${response.status}).`);
  return result;
}, { executive, eyes });
await server.connect(new StdioServerTransport());
