/** Allocated bytes, counted once across managed PodCode folders. */
export interface StorageAgent {
  id: string;
  name: string;
  color: string;
  home: number;
  workspace: number;
  worktrees: number;
  total: number;
}
export type StorageCategory = 'transcripts' | 'channels' | 'attachments' | 'archive' | 'projects' | 'state' | 'backups' | 'other' | 'unassignedAgents' | 'unassignedWorktrees';
export interface StorageSnapshot {
  measuredAt: string;
  startedAt: string;
  status: 'complete' | 'partial' | 'error';
  errors: number;
  total: number;
  agents: StorageAgent[];
  shared: Record<StorageCategory, number>;
}
export function storageSize(bytes: number): string {
  if (!bytes) return '0 B';
  for (const [name, scale] of [['GiB', 2 ** 30], ['MiB', 2 ** 20], ['KiB', 1024]] as const) {
    if (bytes >= scale) return `${(bytes / scale).toLocaleString(undefined, { maximumFractionDigits: name === 'GiB' ? 2 : 1 })} ${name}`;
  }
  return `${bytes} B`;
}
