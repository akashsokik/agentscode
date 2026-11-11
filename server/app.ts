import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { Hub } from './hub.ts';
import type { WorktreeCleanup } from '../shared/types.ts';
import { DEV_WEB_PORT, IN_DESKTOP_APP, PORT } from './config.ts';
import { HttpError } from './errors.ts';
import { BRIDGE_HEADER, bridgeTokenMatches } from './browserBridge.ts';
import type { AgentManager } from './manager.ts';
import { listProjectFiles } from './fileList.ts';
import { listDirs, normalizeDir } from './projects.ts';
import { Terminals } from './terminals.ts';
import { UsageTracker } from './usage.ts';
import { gitDiff, gitStatus, listTree, readFile } from './workspace.ts';

// ---- local-only guard ------------------------------------------------------
// This server starts coding agents with access to your files, so it only answers
// requests addressed to localhost (blocks DNS rebinding) and only accepts writes
// and sockets from localhost pages (blocks cross-site requests).

export function isLocalHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/** Ports whose pages are AgentsCode's own: this server, and the Vite dev page outside the desktop app. */
const APP_PORTS: readonly number[] = IN_DESKTOP_APP ? [PORT] : [PORT, DEV_WEB_PORT];

/**
 * Whether a request's Origin may write or open a socket: AgentsCode's own page (this server's port on
 * a loopback name) or, outside the desktop app, the Vite dev page. Any other local page, such as a
 * dev server open in the user's browser or in AgentsCode's own browser tab, cannot drive the API.
 */
export function isLocalOrigin(origin: string | undefined, ports: readonly number[] = APP_PORTS): boolean {
  if (!origin) return true; // same-origin navigations and non-browser clients
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !isLocalHost(url.host)) return false;
    return ports.includes(Number(url.port || 80));
  } catch {
    return false;
  }
}

function localOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isLocalHost(req.headers.host)) {
    res.status(403).json({ error: 'AgentsCode only answers on localhost.' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !isLocalOrigin(req.headers.origin)) {
    res.status(403).json({ error: 'Cross-origin request refused.' });
    return;
  }
  next();
}

/**
 * Sends an image the server stored itself. The data folder is ~/.agentscode, and Express refuses
 * any path with a dot folder in it unless told; the path is built from a checked attachment id
 * (server/attachments.ts), never from the request, so allowing it is safe. Stored names are never
 * reused, so the image can be cached for good, and the type comes from the bytes. The headers go
 * out with the file only: an error must not be cached for a year or labelled as an image.
 */
function sendStoredImage(res: Response, file: { path: string; mediaType: string }): void {
  res.sendFile(file.path, {
    dotfiles: 'allow',
    headers: { 'Content-Type': file.mediaType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' },
  });
}

/** The REST API. Static files and the WebSockets are attached by createServer. */
export function createApp(
  manager: AgentManager,
  terminals = new Terminals(id => manager.project(id)),
  usage = new UsageTracker(() => manager.engineInfo()),
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly);
  app.use(express.json({ limit: '2mb' }));

  const param = (req: Request, name: string): string => String(req.params[name]);
  const query = (req: Request, name: string): string => (typeof req.query[name] === 'string' ? String(req.query[name]) : '');

  app.get('/api/state', (_req, res) => {
    res.json(manager.snapshot());
  });

  // Agent processes reach this through the comms MCP server; the bearer token identifies them.
  app.post('/api/comms', async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    res.json(await manager.commsTool(token, req.body?.tool, req.body?.args));
  });

  app.post('/api/agents', async (req, res) => {
    res.status(201).json(await manager.create(req.body ?? {}));
  });
  app.patch('/api/agents/:id', async (req, res) => {
    res.json(await manager.update(param(req, 'id'), req.body ?? {}));
  });
  app.delete('/api/agents/:id', async (req, res) => {
    const cleanup = query(req, 'worktree') || 'keep';
    if (!['keep', 'remove', 'discard'].includes(cleanup)) throw new HttpError(400, 'Unknown worktree option.');
    await manager.remove(param(req, 'id'), cleanup as WorktreeCleanup);
    res.status(204).end();
  });
  // Removed agents' archived homes (read only).
  app.get('/api/archive/agents', (_req, res) => {
    res.json(manager.archivedAgents());
  });
  app.get('/api/agents/:id/entries', (req, res) => {
    res.json(manager.entries(param(req, 'id')));
  });
  app.post('/api/agents/:id/messages', (req, res) => {
    manager.send(param(req, 'id'), req.body?.text, req.body?.images, req.body?.mentionHints);
    res.status(202).json({ ok: true });
  });
  // An image pasted or attached in the composer: raw bytes in, an attachment the next message can name out.
  app.post('/api/agents/:id/attachments', express.raw({ type: () => true, limit: '4mb' }), (req, res) => {
    res.status(201).json(manager.saveAttachment(param(req, 'id'), req.body, req.headers['x-file-name']));
  });
  app.get('/api/agents/:id/attachments/:file', (req, res) => {
    sendStoredImage(res, manager.attachmentFile(param(req, 'id'), param(req, 'file')));
  });
  app.get('/api/agents/:id/browser-shots/:file', (req, res) => {
    sendStoredImage(res, manager.browserShot(param(req, 'id'), param(req, 'file')));
  });
  app.get('/api/agents/:id/walkthroughs', (req, res) => {
    res.json(manager.walkthroughs(param(req, 'id')));
  });
  app.get('/api/agents/:id/walkthroughs/:wid', (req, res) => {
    res.json(manager.walkthrough(param(req, 'id'), param(req, 'wid')));
  });
  app.get('/api/agents/:id/walkthroughs/:wid/markdown', (req, res) => {
    res.type('text/markdown').send(manager.walkthroughMarkdown(param(req, 'id'), param(req, 'wid')));
  });
  app.get('/api/agents/:id/walkthroughs/:wid/images/:file', (req, res) => {
    sendStoredImage(res, manager.walkthroughImage(param(req, 'id'), param(req, 'wid'), param(req, 'file')));
  });
  app.delete('/api/agents/:id/walkthroughs/:wid', (req, res) => {
    manager.deleteWalkthrough(param(req, 'id'), param(req, 'wid'));
    res.status(204).end();
  });
  app.post('/api/agents/:id/stop', async (req, res) => {
    await manager.stop(param(req, 'id'));
    res.json({ ok: true });
  });
  app.post('/api/agents/:id/seen', (req, res) => {
    manager.seen(param(req, 'id'));
    res.json({ ok: true });
  });
  app.post('/api/agents/:id/new-session', async (req, res) => {
    await manager.newSession(param(req, 'id'));
    res.json({ ok: true });
  });
  // What the agent remembered (home/memory.md). Agents add entries with the remember tool; the app edits and deletes them.
  app.get('/api/agents/:id/memory', (req, res) => {
    res.json(manager.memory(param(req, 'id')));
  });
  app.patch('/api/agents/:id/memory/:entryId', (req, res) => {
    res.json(manager.updateMemory(param(req, 'id'), param(req, 'entryId'), req.body ?? {}));
  });
  app.delete('/api/agents/:id/memory/:entryId', (req, res) => {
    manager.forgetMemory(param(req, 'id'), param(req, 'entryId'));
    res.status(204).end();
  });
  // Dreaming: the agent's dreams and stats, Dream now, undo, and the soul proposal.
  app.get('/api/agents/:id/dreams', (req, res) => {
    res.json(manager.dreams(param(req, 'id')));
  });
  app.post('/api/agents/:id/dream', (req, res) => {
    // 409 comes back at once; a dream that starts reports through `dream` events.
    manager.dreamNow(param(req, 'id')).catch(err => console.error('[dream] Dream now failed:', (err as Error).message));
    res.status(202).json({ ok: true });
  });
  app.post('/api/agents/:id/dreams/:dreamId/undo', (req, res) => {
    res.json(manager.undoDream(param(req, 'id'), param(req, 'dreamId')));
  });
  app.post('/api/agents/:id/soul-proposal', (req, res) => {
    manager.decideSoul(param(req, 'id'), req.body?.action);
    res.json({ ok: true });
  });
  // The user profile (dataDir/user.md), shared by every agent: entries and the proposals waiting for approval.
  app.get('/api/profile', (_req, res) => {
    res.json(manager.profileView());
  });
  app.post('/api/profile', (req, res) => {
    res.json(manager.addProfile(req.body ?? {}));
  });
  app.patch('/api/profile/:entryId', (req, res) => {
    res.json(manager.updateProfile(param(req, 'entryId'), req.body ?? {}));
  });
  app.delete('/api/profile/:entryId', (req, res) => {
    res.json(manager.forgetProfile(param(req, 'entryId')));
  });
  app.post('/api/profile/proposals/:proposalId', (req, res) => {
    res.json(manager.decideProfile(param(req, 'proposalId'), req.body?.action));
  });
  // The SuperAgent: set it up, answer its questions, undo its decisions.
  app.get('/api/super', (_req, res) => {
    res.json(manager.superView());
  });
  app.post('/api/super', async (req, res) => {
    res.json(await manager.createSuper(req.body ?? {}));
  });
  app.post('/api/super/asks/:askId', (req, res) => {
    res.json(manager.answerSuper(param(req, 'askId'), req.body ?? {}));
  });
  // The goals backlog: the user adds, edits, reorders and removes goals.
  app.post('/api/super/goals', (req, res) => {
    res.json(manager.addGoal(req.body ?? {}));
  });
  app.patch('/api/super/goals/:goalId', (req, res) => {
    res.json(manager.updateGoal(param(req, 'goalId'), req.body ?? {}));
  });
  app.delete('/api/super/goals/:goalId', (req, res) => {
    res.json(manager.removeGoal(param(req, 'goalId')));
  });
  app.post('/api/super/goals/:goalId/move', (req, res) => {
    res.json(manager.moveGoal(param(req, 'goalId'), req.body?.to));
  });
  // Scheduled routines: the user adds, changes, confirms, turns on or off, and removes them.
  app.post('/api/super/routines', (req, res) => {
    res.json(manager.addRoutine(req.body ?? {}));
  });
  app.patch('/api/super/routines/:routineId', (req, res) => {
    res.json(manager.updateRoutine(param(req, 'routineId'), req.body ?? {}));
  });
  app.delete('/api/super/routines/:routineId', (req, res) => {
    res.json(manager.removeRoutine(param(req, 'routineId')));
  });
  app.post('/api/super/log/:actionId/undo', async (req, res) => {
    res.json(await manager.undoSuper(param(req, 'actionId')));
  });
  // Project notes and decisions, read only: the Notes tab and the id chips.
  app.get('/api/refs', (_req, res) => {
    res.json(manager.notes.index());
  });
  app.get('/api/refs/search', (req, res) => {
    res.json({ hits: manager.notes.search(query(req, 'q'), query(req, 'code') || undefined) });
  });
  app.get('/api/refs/:id', (req, res) => {
    res.json(manager.notes.get(param(req, 'id')));
  });
  app.get('/api/dream-stats', (_req, res) => {
    res.json(manager.dreamStats());
  });
  // The composer's `/` picker: the skills and commands the agent's engine can run.
  app.get('/api/agents/:id/commands', async (req, res) => {
    res.json(await manager.commands(param(req, 'id')));
  });

  app.post('/api/approvals/:id', (req, res) => {
    manager.resolveApproval(param(req, 'id'), req.body ?? {});
    res.json({ ok: true });
  });

  app.post('/api/conversations/:id/stop', (req, res) => {
    res.json(manager.stopConversation(param(req, 'id')));
  });

  app.post('/api/channels', (req, res) => {
    res.status(201).json(manager.createChannel(req.body ?? {}));
  });
  app.patch('/api/channels/:id', (req, res) => {
    res.json(manager.updateChannel(param(req, 'id'), req.body ?? {}));
  });
  app.delete('/api/channels/:id', (req, res) => {
    manager.removeChannel(param(req, 'id'));
    res.status(204).end();
  });
  app.get('/api/channels/:id/posts', (req, res) => {
    res.json(manager.channelPosts(param(req, 'id')));
  });
  app.post('/api/channels/:id/posts', (req, res) => {
    res.status(201).json(manager.postToChannel(param(req, 'id'), req.body?.text, req.body?.mentions, req.body?.threadId, req.body?.images, req.body?.mentionHints));
  });
  // An image pasted or attached in a channel composer, for the user's next post there.
  app.post('/api/channels/:id/attachments', express.raw({ type: () => true, limit: '4mb' }), (req, res) => {
    res.status(201).json(manager.saveChannelAttachment(param(req, 'id'), req.body, req.headers['x-file-name']));
  });
  app.get('/api/channels/:id/attachments/:file', (req, res) => {
    sendStoredImage(res, manager.channelAttachmentFile(param(req, 'id'), param(req, 'file')));
  });
  app.post('/api/channels/:id/seen', (req, res) => {
    manager.channelSeen(param(req, 'id'));
    res.json({ ok: true });
  });

  app.post('/api/projects', (req, res) => {
    res.status(201).json(manager.addProject(req.body ?? {}));
  });
  app.patch('/api/projects/:id', (req, res) => {
    res.json(manager.renameProject(param(req, 'id'), req.body ?? {}));
  });
  app.delete('/api/projects/:id', (req, res) => {
    manager.removeProject(param(req, 'id'));
    terminals.closeProject(param(req, 'id'));
    res.status(204).end();
  });

  // Shells for the terminal panel, one project folder each. Their bytes go over /ws/terminal/<id>.
  app.get('/api/terminals', (_req, res) => {
    res.json(terminals.list());
  });
  app.post('/api/terminals', (req, res) => {
    const from = typeof req.body?.from === 'string' ? req.body.from : undefined;
    res.status(201).json(terminals.create(String(req.body?.projectId ?? ''), { cols: req.body?.cols, rows: req.body?.rows }, from));
  });
  // Which of these terminals run a program (not just the shell), so closing them asks first.
  app.get('/api/terminals/busy', (req, res) => {
    res.json(terminals.busy(query(req, 'ids').split(',').filter(Boolean).slice(0, 64)));
  });
  app.delete('/api/terminals/:id', (req, res) => {
    terminals.close(param(req, 'id'));
    res.status(204).end();
  });

  // Files and git for an agent's workspace (its worktree, or its project), or a project folder.
  const rootOf = (req: Request): { root: string; baseCommit?: string } => {
    const agent = query(req, 'agent');
    if (agent) return manager.workspaceOf(agent);
    const project = query(req, 'project');
    if (project) return { root: manager.project(project).path };
    throw new HttpError(400, 'Choose an agent or a project.');
  };
  app.get('/api/files/tree', (req, res) => {
    res.json(listTree(rootOf(req).root, query(req, 'path')));
  });
  app.get('/api/files/read', (req, res) => {
    res.json(readFile(rootOf(req).root, query(req, 'path')));
  });
  // The composer's `@` picker: every file in the workspace.
  app.get('/api/files/list', async (req, res) => {
    res.json(await listProjectFiles(rootOf(req).root));
  });
  app.get('/api/git/status', async (req, res) => {
    const { root, baseCommit } = rootOf(req);
    res.json(await gitStatus(root, baseCommit));
  });
  app.get('/api/git/diff', async (req, res) => {
    res.json(await gitDiff(rootOf(req).root, query(req, 'path')));
  });

  // Folder picker for adding projects.
  app.get('/api/fs', (req, res) => {
    try {
      res.json(listDirs(query(req, 'path'), query(req, 'hidden') === '1'));
    } catch (err) {
      throw new HttpError(400, `Cannot open that folder: ${(err as Error).message}`);
    }
  });
  app.post('/api/fs/mkdir', (req, res) => {
    if (!req.body?.path) throw new HttpError(400, 'Folder path is empty.');
    const dir = normalizeDir(String(req.body.path));
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new HttpError(400, `Cannot create ${dir}: ${(err as Error).message}`);
    }
    res.status(201).json({ path: dir });
  });

  app.post('/api/models/refresh', async (_req, res) => {
    res.json(await manager.refreshModels());
  });

  // Subscription usage for the footer: windows and errors only, never the credentials it was read with.
  const usageEngine = (req: Request): Parameters<UsageTracker['usage']>[0] => {
    const engine = param(req, 'engine');
    if (!usage.has(engine)) throw new HttpError(404, 'No usage for that engine.');
    return engine;
  };
  app.get('/api/usage/:engine', async (req, res) => {
    res.json(await usage.usage(usageEngine(req)));
  });
  app.post('/api/usage/:engine/refresh', async (req, res) => {
    res.json(await usage.usage(usageEngine(req), true));
  });
  app.patch('/api/settings', (req, res) => {
    res.json(manager.updateSettings(req.body ?? {}));
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err instanceof HttpError ? err.status : err.type === 'entity.parse.failed' ? 400 : (err.status ?? 500);
    if (status >= 500) console.error('[server]', err);
    const message = err.type === 'entity.too.large' ? 'That upload is too large.' : err.message || 'Server error.';
    res.status(status).json({ error: message });
  });

  return app;
}

/**
 * The full server: REST API, the built web app when dist/ exists, the WebSocket that sends a
 * snapshot on connect and live events after, and one socket per terminal. The caller decides
 * where to listen. Closing the server ends its terminals.
 */
export function createServer(manager: AgentManager, hub: Hub, options: { distDir?: string; terminals?: Terminals; bridgeToken?: string } = {}): http.Server {
  const terminals = options.terminals ?? new Terminals(id => manager.project(id));
  terminals.onChange(list => hub.broadcast({ type: 'terminals', terminals: list }));
  const app = createApp(manager, terminals);
  const dist = options.distDir;
  if (dist && fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false }));
    // Client-side routes all load the app shell.
    app.use((req, res, next) => {
      if (req.method === 'GET') res.sendFile('index.html', { root: dist });
      else next();
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text').send('AgentsCode API is running. Run `npm run dev` for the Vite dev server, or `npm start` to build and serve the app here.');
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  // A terminal socket carries keystrokes into a shell, so it gets the same localhost guard.
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  // The desktop app's main process, when it attached to a server it did not start (server/browserBridge.ts).
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/browser-bridge') {
      // Main sends no Origin; a web page always does, so one with an Origin is never the bridge.
      if (!options.bridgeToken || !isLocalHost(req.headers.host) || req.headers.origin !== undefined || !bridgeTokenMatches(options.bridgeToken, req.headers[BRIDGE_HEADER])) {
        socket.destroy();
        return;
      }
      bridgeWss.handleUpgrade(req, socket, head, ws => {
        const transport = { send: (message: object) => ws.send(JSON.stringify(message)) };
        const detach = manager.browser.connect(transport);
        transport.send({ type: 'browser:ping' }); // main says hello on open too; this covers a race
        ws.on('message', data => {
          try { manager.browser.receive(JSON.parse(String(data)), transport); } catch { /* not JSON: ignore */ }
        });
        ws.on('close', detach);
      });
      return;
    }
    const terminalId = /^\/ws\/terminal\/([\w-]{1,64})$/.exec(pathname)?.[1];
    if ((pathname !== '/ws' && !terminalId) || !isLocalHost(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
      socket.destroy();
      return;
    }
    if (terminalId) {
      terminalWss.handleUpgrade(req, socket, head, ws => terminals.attach(terminalId, ws));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.add(ws);
      hub.send(ws, { type: 'snapshot', data: manager.snapshot() });
      hub.send(ws, { type: 'terminals', terminals: terminals.list() });
    });
  });
  // Keep idle sockets from being dropped by proxies and sleeping laptops.
  const ping = setInterval(() => {
    for (const ws of [...wss.clients, ...terminalWss.clients]) ws.ping();
  }, 30_000);
  ping.unref();
  server.on('close', () => {
    clearInterval(ping);
    terminals.closeAll();
    for (const ws of [...wss.clients, ...terminalWss.clients, ...bridgeWss.clients]) ws.terminate();
    wss.close();
    terminalWss.close();
    bridgeWss.close();
  });
  return server;
}
