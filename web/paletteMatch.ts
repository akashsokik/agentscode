/**
 * Matching and ranking for the command palette. No DOM or app imports, so tests can load it.
 * Ranking is decided by score, then by a command's priority, then by recency, so a query
 * that matches several commands equally well never puts a costly one (New session, Stop)
 * first just because of where it sits in the list.
 */

export interface Matchable {
  title: string;
  /** Extra text that can match, ranked below a title match: a project, a role, a topic. */
  keywords?: string;
  /** Breaks ties between equal matches. Higher first; destructive commands should stay low. */
  priority?: number;
  /** Breaks remaining ties, most recent first (a timestamp). */
  recency?: number;
}

const WORD_BREAK = /[\s#/_.,:()-]+/;

/** How well `query` matches `text`: higher is better, null when it does not match. */
export function matchScore(query: string, text: string, fuzzy = true): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  const words = t.split(WORD_BREAK).filter(Boolean);
  if (words.some(word => word.startsWith(q))) return 600;
  const index = t.indexOf(q);
  if (index >= 0) return Math.max(300, 400 - index);
  // "set ada" finds "Ada settings": every word of the query starts a word of the text.
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every(token => words.some(word => word.startsWith(token)))) return 200;
  if (!fuzzy) return null;
  // Letters in order, as "nwag" finds "New agent"; tighter runs score higher.
  let at = -1;
  let gaps = 0;
  for (const char of q.replace(/\s+/g, '')) {
    const next = t.indexOf(char, at + 1);
    if (next < 0) return null;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 100 - gaps);
}

/** A command's score for a query: its title, or its keywords at a discount; null when neither matches. */
export function commandScore(query: string, item: Matchable): number | null {
  const title = matchScore(query, item.title);
  const keywords = item.keywords ? matchScore(query, item.keywords, false) : null;
  if (title === null && keywords === null) return null;
  return Math.max(title ?? 0, keywords === null ? 0 : keywords * 0.4);
}

/** The items that match `query`, best first. An empty query keeps every item in its order. */
export function rankCommands<T extends Matchable>(items: readonly T[], query: string): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((item, index) => ({ item, index, score: commandScore(query, item) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) =>
      b.score - a.score
      || (b.item.priority ?? 0) - (a.item.priority ?? 0)
      || (b.item.recency ?? 0) - (a.item.recency ?? 0)
      || a.index - b.index)
    .map(entry => entry.item);
}
