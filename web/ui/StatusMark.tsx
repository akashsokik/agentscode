import type { ReactNode } from 'react';
import { AlertCircle, CheckCircle, CircleDashed, CircleHelp, CircleX, LoaderCircle, Minus, type IconComponent } from '../mono/icons.tsx';
import { cx } from './common.tsx';
import { STATUS_MARKS, statusTone, statusWordsTone, type StatusGlyph, type StatusState } from './statusMarks.ts';

// One status mark for every pass, fail and pending result in the app (ACH-D45, replacing ACH-D44):
// CI checks, reviews, report outcomes, tool calls and toasts, in MonoCode's style (statusMarks.ts).
// Menu selection ticks, checkboxes and close buttons are not statuses and keep their own glyphs.

export { statusWord, type StatusState } from './statusMarks.ts';

const GLYPH: Record<StatusGlyph, IconComponent> = { CheckCircle, CircleX, LoaderCircle, Minus, CircleDashed, CircleHelp, AlertCircle };

/**
 * The mark alone. `quiet` keeps the glyph but drops the colour, for a result that needs nothing
 * from you (a handled conversation, a finished turn). With `label` it is an image with that name;
 * otherwise it is decoration beside words that say the same.
 */
export function StatusMark({ state, className = 'size-4', quiet = false, label }: { state: StatusState; className?: string; quiet?: boolean; label?: string }) {
  const Icon = GLYPH[STATUS_MARKS[state].glyph];
  return (
    <Icon
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={cx('shrink-0', className, statusTone(state, quiet))}
      strokeWidth={1.75}
    />
  );
}

/** The mark, then words: a check summary, a review's verdict, an outcome. */
export function StatusText({ state, quiet = false, className = '', title, children }: { state: StatusState; quiet?: boolean; className?: string; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={cx('inline-flex shrink-0 items-center gap-1.5 font-sans', statusWordsTone(state, quiet), className)}>
      <StatusMark state={state} quiet={quiet} className="size-3.5" />
      {children}
    </span>
  );
}
