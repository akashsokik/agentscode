/** ACH-65 / ACH-D90: selection is explicit; moving build outputs frees no space yet. */
export interface StorageCleanupCandidate {
  id: string;
  agentId: string | null;
  kind: 'worktree' | 'build-output';
  label: string;
  relPath: string;
  bytes: number;
  reason: string;
}

export interface StorageCleanupResult {
  backupDir: string | null;
  removed: { id: string; bytes: number }[];
  skipped: { id: string; reason: string }[];
  /** Logical bytes removed from worktrees. Build outputs remain in backups and contribute zero. */
  freedBytes: number;
}
