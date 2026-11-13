/**
 * Status and priority marks for the issue view, as approved (ACH-D46): part-filled rings for In
 * progress (half) and In review (three quarters), the dashed circle for Backlog, an empty ring for
 * Todo, a clock for Waiting, a circled alert for Needs you; Done and Canceled as the shared
 * StatusMark's circled check and minus (ACH-D45). Priority option A: signal bars with the unlit
 * ones dimmed, a "no signal" mark for none, an alert square for urgent.
 *
 * Stand-ins: these move to web/mono/icons (Fen, phase 3) and StatusMark (Cy, feat/pr-page). The
 * view imports only from here, so the swap is one file. Same 16px grid and 1.75 stroke as the
 * hugeicons set.
 */
import type { SVGProps } from 'react';
import type { IssuePriority, IssueStatus } from '../../../shared/types.ts';

type GlyphProps = { className?: string; title?: string };
const base = (className = 'size-3.5', title?: string): SVGProps<SVGSVGElement> => ({
  viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
  className: `shrink-0 ${className}`, 'aria-hidden': title ? undefined : true, role: title ? 'img' : undefined, 'aria-label': title,
});

/** The colour of a status, from the theme's status hues (proposal section 3). */
export const STATUS_TONE: Record<IssueStatus, string> = {
  needs_you: 'text-warning', in_review: 'text-info', in_progress: 'text-accent', waiting: 'text-content/50',
  todo: 'text-content/55', backlog: 'text-content/40', done: 'text-success', canceled: 'text-content/40',
};

export function StatusGlyph({ status, className, title }: GlyphProps & { status: IssueStatus }) {
  const tone = STATUS_TONE[status];
  const props = base(`${tone} ${className ?? 'size-3.5'}`, title);
  switch (status) {
    case 'backlog': return <svg {...props}><circle cx="8" cy="8" r="5.6" strokeDasharray="2.1 2.1" /></svg>;
    case 'todo': return <svg {...props}><circle cx="8" cy="8" r="5.6" /></svg>;
    case 'in_progress': return <svg {...props}><circle cx="8" cy="8" r="5.6" /><path d="M8 4.4a3.6 3.6 0 0 1 0 7.2Z" fill="currentColor" stroke="none" /></svg>;
    case 'in_review': return <svg {...props}><circle cx="8" cy="8" r="5.6" /><path d="M8 4.4A3.6 3.6 0 1 1 4.4 8H8Z" fill="currentColor" stroke="none" /></svg>;
    case 'waiting': return <svg {...props}><circle cx="8" cy="8" r="5.6" /><path d="M8 5.3V8l1.8 1.2" /></svg>;
    case 'needs_you': return <svg {...props}><circle cx="8" cy="8" r="5.6" /><path d="M8 5.2v3.3M8 10.7v.1" /></svg>;
    case 'done': return <svg {...props}><circle cx="8" cy="8" r="5.6" /><path d="m5.6 8.2 1.7 1.7 3.2-3.4" /></svg>;
    case 'canceled': return <svg {...props}><circle cx="8" cy="8" r="5.6" /><path d="M5.6 8h4.8" /></svg>;
  }
}

/** Priority option A: bars lit up to the level, the rest dimmed; none and urgent their own marks. */
export function PriorityGlyph({ priority, className, title }: GlyphProps & { priority: IssuePriority }) {
  if (priority === 'urgent') {
    return <svg {...base(`text-warning ${className ?? 'size-3.5'}`, title)}><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M8 5.2v3.3M8 10.7v.1" /></svg>;
  }
  if (priority === 'none') {
    return <svg {...base(`text-content/40 ${className ?? 'size-3.5'}`, title)}><path d="M3.5 8h1.5M7.25 8h1.5M11 8h1.5" /></svg>;
  }
  const lit = priority === 'high' ? 3 : priority === 'normal' ? 2 : 1;
  const bars = [{ x: 3.5, h: 4 }, { x: 7.25, h: 7 }, { x: 11, h: 10 }];
  return (
    <svg {...base(`text-content/75 ${className ?? 'size-3.5'}`, title)} fill="currentColor" stroke="none">
      {bars.map((b, i) => <rect key={b.x} x={b.x} y={13 - b.h} width="2" height={b.h} rx="0.6" opacity={i < lit ? 1 : 0.28} />)}
    </svg>
  );
}
