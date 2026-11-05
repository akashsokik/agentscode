import { useMemo, type ReactNode } from 'react';
import { useApp } from '../store.ts';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Plain text with @mentions of known agents, and @all, @channel and @here, set in the
 * mention colour. Matching follows mentions.ts: case-insensitive, not inside a word.
 * The caller's whitespace style keeps line breaks.
 */
export function MentionText({ text }: { text: string }) {
  const agents = useApp(s => s.snapshot?.agents);
  const pattern = useMemo(() => {
    // Longest names first, so "@Ada Lovelace" wins over "@Ada".
    const names = (agents ?? []).map(a => a.name).filter(Boolean).sort((a, b) => b.length - a.length).map(escape);
    return new RegExp(`(^|[^\\w@])(@(?:all|channel|here${names.length ? `|${names.join('|')}` : ''}))(?![\\w-])`, 'gi');
  }, [agents]);

  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[1].length;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<span key={start} className="rounded bg-mention/10 px-0.5 font-medium text-mention">{match[2]}</span>);
    last = start + match[2].length;
  }
  if (!parts.length) return <>{text}</>;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
