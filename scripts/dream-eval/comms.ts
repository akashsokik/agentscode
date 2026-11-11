import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentManager } from '../../server/manager.ts';

export interface CommsEndpoint {
  port: number;
  /** The manager the next calls go to; arms run one at a time. */
  use(manager: AgentManager | null): void;
  close(): Promise<void>;
}

/**
 * The one route agent processes call back on: the comms MCP server (remember, forget, and the team
 * tools) posts to http://127.0.0.1:$PORT/api/comms. This answers only that route, on a random local
 * port, so a real-engine run never reaches a PodCode app the user has open. It is not the
 * PodCode server: no UI, no REST API, no websocket.
 */
export async function startCommsEndpoint(): Promise<CommsEndpoint> {
  let manager: AgentManager | null = null;
  const server = http.createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/api/comms') return reply(404, { error: 'Not found.' });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        if (!manager) return reply(503, { error: 'No agent is running.' });
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { tool?: unknown; args?: unknown };
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        reply(200, await manager.commsTool(token, body.tool, body.args));
      } catch (err) {
        const error = err as Error & { status?: number };
        reply(typeof error.status === 'number' ? error.status : 500, { error: error.message || 'Server error.' });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    use: next => { manager = next; },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
