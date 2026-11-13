// First: move the data folder to ~/.podcode if this is the first PodCode start (server/boot.ts).
import './boot.ts';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEV_WEB_PORT, DIST_DIR, HOST, PORT, detectEngine } from './config.ts';
import { attachParentPort, writeBridgeToken } from './browserBridge.ts';
import { createServer } from './app.ts';
import { Hub } from './hub.ts';
import { AgentManager } from './manager.ts';
import { Store } from './store.ts';
import { Terminals } from './terminals.ts';
import { USER_TOKEN_MESSAGE, UserKey } from './userAuth.ts';

const [claude, codex, orcacode] = await Promise.all([detectEngine('claude'), detectEngine('codex'), detectEngine('orcacode')]);
const store = new Store();
store.load();
const hub = new Hub();
const manager = new AgentManager(store, hub, { claude, codex, orcacode });
manager.init();
void manager.refreshModels(); // fills in the model pickers a few seconds after start

// The desktop app's browser: through the utility process's parentPort when the app started this
// server, else through /browser-bridge with this token (main reads it from the data folder).
attachParentPort(manager.browser);
const bridgeToken = writeBridgeToken(DATA_DIR);

// The user's key to the API (server/userAuth.ts): to the desktop app's main process over
// parentPort, which adds it to its windows' requests; never to a file or the agents' env. Main
// can ask again (after a reload, say). Without the desktop app, a one-time sign-in link instead.
const userKey = new UserKey();
const parentPort = (process as unknown as { parentPort?: { postMessage(message: unknown): void; on(event: 'message', listener: (event: { data?: { type?: string } }) => void): void } }).parentPort;
if (parentPort) {
  const sendKey = () => parentPort.postMessage({ type: USER_TOKEN_MESSAGE, token: userKey.token });
  sendKey();
  parentPort.on('message', event => { if (event?.data?.type === `${USER_TOKEN_MESSAGE}?`) sendKey(); });
}

const terminals = new Terminals(id => manager.project(id));
const server = createServer(manager, hub, { distDir: DIST_DIR, terminals, bridgeToken, auth: userKey });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Is PodCode already running? Set PORT=... to use another port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const engines = [
    `Claude Code ${claude.available ? `v${claude.version}` : 'not found'}`,
    `Codex ${codex.available ? `v${codex.version}` : 'not found'}`,
    `OrcaCode ${orcacode.available ? `v${orcacode.version}` : 'not found'}`,
  ].join(', ');
  console.log(`PodCode is open at http://localhost:${PORT}  (${engines})`);
  if (!parentPort) {
    // No desktop app to hold the key: a browser signs in with a one-time link only this terminal
    // shows; each use prints the next, for another browser. The cookie is sent to every 127.0.0.1
    // port (cookies ignore ports), so another local server the browser visits receives it too:
    // prefer the desktop app (Rhea L2).
    const page = DIST_DIR && fs.existsSync(path.join(DIST_DIR, 'index.html')) ? PORT : DEV_WEB_PORT;
    const printLink = () => console.log(`Sign in a browser (one use, lasts 12 h; the desktop app needs none): http://127.0.0.1:${page}/login?code=${userKey.newLoginCode()}`);
    userKey.onLoginUsed = printLink;
    printLink();
  }
});

async function shutdown(): Promise<void> {
  terminals.closeAll();
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
