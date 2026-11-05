import { DIST_DIR, HOST, PORT, detectEngine } from './config.ts';
import { createServer } from './app.ts';
import { Hub } from './hub.ts';
import { AgentManager } from './manager.ts';
import { Store } from './store.ts';
import { Terminals } from './terminals.ts';

const [claude, codex] = await Promise.all([detectEngine('claude'), detectEngine('codex')]);
const store = new Store();
store.load();
const hub = new Hub();
const manager = new AgentManager(store, hub, { claude, codex });
manager.init();
void manager.refreshModels(); // fills in the model pickers a few seconds after start

const terminals = new Terminals(id => manager.project(id));
const server = createServer(manager, hub, { distDir: DIST_DIR, terminals });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Is AgentsCode already running? Set PORT=... to use another port.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const engines = [
    `Claude Code ${claude.available ? `v${claude.version}` : 'not found'}`,
    `Codex ${codex.available ? `v${codex.version}` : 'not found'}`,
  ].join(', ');
  console.log(`AgentsCode is open at http://localhost:${PORT}  (${engines})`);
});

async function shutdown(): Promise<void> {
  terminals.closeAll();
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
