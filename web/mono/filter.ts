/** Case-insensitive match on every word of the query against an option's label, value and group. */
export function filterOptions<T extends { label: string; value: string; group?: string }>(options: T[], query: string, match: 'words' | 'phrase' = 'words'): T[] {
  // Quick pickers historically match one whole phrase; other selects match every word.
  const words = (match === 'phrase' ? [query.trim().toLowerCase()] : query.toLowerCase().split(/\s+/)).filter(Boolean);
  if (!words.length) return options;
  return options.filter((option) => {
    const text = `${option.label} ${option.value} ${option.group ?? ""}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
