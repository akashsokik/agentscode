import type { Express } from 'express';
import { HttpError } from './errors.ts';
import { cleanupStorage, emptyStorageBackups, listStorageCleanupCandidates, type StorageCleanupDeps } from './storageCleanup.ts';

export interface StorageCleanupRouteDeps extends StorageCleanupDeps {
  /** Invalidate the cached storage scan after a cleanup response, including backup changes. */
  onChange?: () => void;
}

/** Register after createApp's localhost/auth/JSON middleware, before its error handler. */
export function registerStorageCleanupRoutes(app: Express, deps: StorageCleanupRouteDeps): void {
  const changed = () => {
    try { deps.onChange?.(); } catch (error) {
      // The filesystem operation has already finished; do not hide its result with a cache error.
      console.error('[storage-cleanup] Could not invalidate the storage scan.', error);
    }
  };
  app.get('/api/storage/cleanup/candidates', async (_req, res) => {
    res.json({ candidates: await listStorageCleanupCandidates(deps) });
  });
  app.post('/api/storage/cleanup', async (req, res) => {
    if (!req.body || !Array.isArray(req.body.ids)) throw new HttpError(400, 'Choose candidate ids.');
    const result = await cleanupStorage(req.body.ids, deps);
    changed();
    res.json(result);
  });
  app.post('/api/storage/backups/empty', async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, 'Confirm before permanently emptying storage-cleanup backups.');
    const result = await emptyStorageBackups(deps);
    changed();
    res.json(result);
  });
}
