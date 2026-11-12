// The server's first import (server/index.ts): before any module opens the data folder, move
// ~/.agentscode to ~/.podcode once (server/dataDir.ts). Only the real server start runs this;
// tests and scripts import config.ts directly and never migrate.
import { migrateDataDir } from './dataDir.ts';
import { scrubScriptOverrides } from './envHygiene.ts';

// Before anything starts a process: no agent, terminal or check may inherit the restart and install
// scripts' path overrides (server/envHygiene.ts).
const dropped = scrubScriptOverrides();
if (dropped.length) console.log(`[env] not passing ${dropped.join(', ')} on to agents and terminals.`);

try {
  migrateDataDir();
} catch (err) {
  // A failed move leaves everything where it was; config.ts then keeps using the old folder.
  console.error('[data] could not move the data folder; using it where it is:', (err as Error).message);
}
