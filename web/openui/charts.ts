// Pure helpers for the OpenUI components, tested directly.

type Cell = string | number | boolean | null;

/** Mermaid xychart source for a Chart component, so charts draw in the same theme greys as diagrams. */
export function chartSource({ kind, title, labels, series, yLabel }: {
  kind: 'bar' | 'line';
  title?: string;
  labels: string[];
  series: { name: string; values: number[] }[];
  yLabel?: string;
}): string {
  const quote = (text: string) => `"${text.replace(/"/g, "'").replace(/\s+/g, ' ').trim()}"`;
  const lines = ['xychart-beta'];
  if (title) lines.push(`  title ${quote(title)}`);
  lines.push(`  x-axis [${labels.map(quote).join(', ')}]`);
  const rows = series.map(one => labels.map((_, i) => (Number.isFinite(one.values[i]) ? one.values[i] : 0)));
  const all = rows.flat();
  // Bars start at zero, so their heights compare honestly; negative values extend the axis down.
  const low = Math.min(0, ...all);
  const high = Math.max(low + 1, ...all);
  lines.push(`  y-axis ${yLabel ? `${quote(yLabel)} ` : ''}${low} --> ${high}`);
  for (const values of rows) lines.push(`  ${kind} [${values.join(', ')}]`);
  return lines.join('\n');
}

/** Rows sorted by one column: numbers as numbers, the rest as text; empty cells last. */
export function sortRows(rows: Cell[][], column: number, descending: boolean): Cell[][] {
  const empty = (v: Cell | undefined) => v === null || v === undefined || v === '';
  return [...rows].sort((a, b) => {
    const x = a[column];
    const y = b[column];
    if (empty(x) || empty(y)) return empty(x) === empty(y) ? 0 : empty(x) ? 1 : -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return descending ? -order : order;
  });
}

/** What a click in an OpenUI block does: send the agent a message, open a link, or nothing. */
export function clickOutcome(event: { type: string; params?: Record<string, unknown>; humanFriendlyMessage?: string }):
  { kind: 'send'; text: string } | { kind: 'open'; url: string } | null {
  if (event.type === 'open_url') {
    const url = typeof event.params?.url === 'string' ? event.params.url : '';
    return /^https?:\/\//i.test(url) ? { kind: 'open', url } : null;
  }
  if (event.type !== 'continue_conversation') return null;
  const message = (event.humanFriendlyMessage ?? '').trim();
  if (!message) return null;
  const context = event.params?.context;
  const extra = context === undefined || context === null || context === '' ? '' : `\n\nContext: ${typeof context === 'string' ? context : JSON.stringify(context)}`;
  return { kind: 'send', text: `${message}${extra}` };
}
