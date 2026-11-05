import type { WebSocket } from 'ws';
import type { ServerEvent } from '../shared/types.ts';

export interface Broadcaster {
  broadcast(event: ServerEvent): void;
}

/** Fan-out of server events to every connected browser tab. */
export class Hub implements Broadcaster {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    // An unhandled 'error' (e.g. a malformed frame) would crash the server.
    ws.on('error', () => ws.terminate());
  }

  send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}
