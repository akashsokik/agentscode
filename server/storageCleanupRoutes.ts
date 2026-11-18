import type { Express } from 'express';
import { HttpError } from './errors.ts';
import { cleanupStorage, emptyStorageBackups, listStorageCleanupCandidates, type StorageCleanupDeps } from './storageCleanup.ts';

/** Register after createApp's localhost/auth/JSON middleware, before its error handler. */
export function registerStorageCleanupRoutes(app: Express, deps: StorageCleanupDeps): void {
  app.get('/api/storage/cleanup/candidates', async (_req, res) => {
    res.json({ candidates: await listStorageCleanupCandidates(deps) });
  });
  app.post('/api/storage/cleanup', async (req, res) => {
    if (!req.body || !Array.isArray(req.body.ids)) throw new HttpError(400, 'Choose candidate ids.');
    res.json(await cleanupStorage(req.body.ids, deps));
  });
  app.post('/api/storage/backups/empty', async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm before permanently emptying storage-cleanup backups.');
    res.json(await emptyStorageBackups(deps));
  });
}
