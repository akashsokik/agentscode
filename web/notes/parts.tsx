import type { ReactNode } from 'react';
import type { RefState, RefSummary } from '../../shared/refs.ts';
import { useApp } from '../store.ts';
import { AgentAvatar } from '../ui/Avatar.tsx';

// Small pieces the Notes tab and the id chips share: the kind glyphs, who with their avatar, the
// date as the app writes it, the status pill and highlighted search words.

export function DecisionGlyph({ className }: { className?: string }) {
  return <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} className={className}><path d="m3.5 8.5 3 3 6-7" /></svg>;
}

export function NoteGlyph({ className }: { className?: string }) {
  return <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} className={className}><path d="M4 2.5h6l2.5 2.5v8.5H4Z" /><path d="M6.2 7.5h4M6.2 10h3" /></svg>;
}

export function kindWord(kind: 'D' | 'N'): string {
  return kind === 'D' ? 'Decision' : 'Note';
}

/** The chip's look: its kind, and quiet when replaced. */
export function chipClass(summary: Pick<RefSummary, 'kind' | 'state'> | undefined, id: string, small = false): string {
  const note = summary ? summary.kind === 'N' : /-N\d+$/.test(id);
  return ['ref-chip', note ? 'ref-note' : '', summary?.state === 'replaced' ? 'ref-old' : '', small ? 'ref-small' : ''].filter(Boolean).join(' ');
}

/** A chip that only shows (a row in the list): no hover, no button. */
export function StaticChip({ summary, small = true, glyph = true }: { summary: RefSummary; small?: boolean; /** List rows drop the glyph: the section already says the kind (ACH-D37 amends ACH-D13). */ glyph?: boolean }) {
  return (
    <span className={chipClass(summary, summary.id, small)}>
      {glyph ? summary.kind === 'D' ? <DecisionGlyph /> : <NoteGlyph /> : null}
      {summary.id}
    </span>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-11-09 as "9 Nov", with the year when it is not this one; anything else as written. */
export function shortDate(date: string, now = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return date;
  const day = `${Number(match[3])} ${month}`;
  return Number(match[1]) === now.getFullYear() ? day : `${day} ${match[1]}`;
}

/** A citation's time: the time today, else the short date. */
export function citeTime(ts: number, now = new Date()): string {
  const at = new Date(ts);
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameYear = at.getFullYear() === now.getFullYear();
  return `${at.getDate()} ${MONTHS[at.getMonth()]}${sameYear ? '' : ` ${at.getFullYear()}`}`;
}

/** Someone's avatar by name: an agent's own, or a quiet initial for you and anyone not an agent. */
export function WhoAvatar({ name, agentId, className = 'size-4' }: { name: string; agentId?: string; className?: string }) {
  const agent = useApp(s => s.snapshot?.agents.find(a => (agentId ? a.id === agentId : a.name.toLowerCase() === name.trim().toLowerCase())));
  if (agent || agentId) return <AgentAvatar agent={agent ?? { id: agentId! }} animate={false} className={`${className} shrink-0`} />;
  const initial = /^you$/i.test(name.trim()) ? 'Y' : (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span aria-hidden className={`${className} grid shrink-0 place-items-center rounded-full bg-content/10 text-[9px] font-semibold leading-none text-content/60`}>
      {initial}
    </span>
  );
}

const PILL: Record<RefState, string> = {
  active: 'text-success',
  replaced: 'text-content/55',
  note: 'text-content/55',
};

/** "In force", "Replaced", or a hand-written status; notes have none. */
export function statusWords(summary: Pick<RefSummary, 'state' | 'status'>): string | null {
  if (summary.state === 'note') return null;
  if (summary.state === 'active') return 'In force';
  if (/^outdated by /i.test(summary.status)) return 'Outdated';
  return /^replaced by /i.test(summary.status) || !summary.status ? 'Replaced' : summary.status;
}

export function StatusPill({ summary, className = '' }: { summary: Pick<RefSummary, 'state' | 'status'>; className?: string }) {
  const words = statusWords(summary);
  if (!words) return null;
  return <span className={`rounded-full bg-content/7 px-2 py-0.5 text-[11px] font-medium leading-4 ${PILL[summary.state]} ${className}`}>{words}</span>;
}

/** `text` with every query word marked. Built as nodes, never as HTML. */
export function Highlight({ text, words }: { text: string; words: readonly string[] }): ReactNode {
  if (!words.length) return text;
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of words) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) ranges.push([at, at + word.length]);
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (end <= last) continue;
    const from = Math.max(start, last);
    if (from > last) parts.push(text.slice(last, from));
    parts.push(<mark key={from} className="ref-mark">{text.slice(from, end)}</mark>);
    last = end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
