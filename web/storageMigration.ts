// PodCode was AgentsCode (ALL-D4, ALL-D5). Its settings in localStorage (layout, theme, drafts,
// what was seen) were keyed "agentscode:..." and "agentscode....". This copies each to its
// "podcode" name when that is missing, before any module reads them, so nothing is lost. The old
// keys are kept, so an older build opened again still finds its own. Imported first by the pages.

export function migrateStorage(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>): number {
  let copied = 0;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && /^agentscode[:.]/.test(key)) keys.push(key);
  }
  for (const key of keys) {
    const next = `podcode${key.slice('agentscode'.length)}`;
    if (storage.getItem(next) !== null) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    try { storage.setItem(next, value); copied++; } catch { /* full or private: the old value still works for this session */ }
  }
  return copied;
}

try {
  if (typeof localStorage !== 'undefined') migrateStorage(localStorage);
} catch {
  // storage unavailable: nothing to carry over
}
