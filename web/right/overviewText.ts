// Words for the right panel's Overview. Pure, so it is tested directly.

/**
 * The sections with nothing in them yet, as words for one line: "memories or walkthroughs". Empty
 * when every section has something, or while one is still loading (undefined).
 */
export function emptySections(counts: { handoffs: number; peers: number; walkthroughs: number | undefined; memories: number | undefined }): string {
  if (counts.walkthroughs === undefined || counts.memories === undefined) return '';
  const names = [
    counts.handoffs ? '' : 'handoffs',
    counts.peers ? '' : 'teammates',
    counts.memories ? '' : 'memories',
    counts.walkthroughs ? '' : 'walkthroughs',
  ].filter(Boolean);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] ?? '';
}
