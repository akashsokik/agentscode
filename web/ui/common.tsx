/**
 * Small pieces of MonoCode markup used across AgentsCode, lifted as-is from the
 * components named beside each one so every surface shares MonoCode's look.
 */
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Check, type IconComponent } from '../mono/icons.tsx';
import { Shimmer } from '../mono/Shimmer.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Text fields: QuestionForm's custom-answer input. */
export const INPUT = 'w-full rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content outline-none placeholder:text-content/35';
export const TEXTAREA = `${INPUT} resize-y leading-5`;

/** Solid primary action: the composer submit treatment (see `.primary-action`). */
export const PRIMARY = 'primary-action flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-[transform,background-color] duration-150 active:scale-[0.97] disabled:cursor-default';

/** Icon-only header control: Modal's close button. `active` marks a toggle that is on. */
export function HeaderButton({ icon: Icon, label, active = false, className = '', ...props }: ComponentPropsWithoutRef<'button'> & { icon: IconComponent; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...props}
      className={cx(
        'grid size-7 shrink-0 place-items-center rounded-md transition-[color,background-color,opacity] duration-150 hover:bg-content/8 hover:text-content disabled:pointer-events-none disabled:opacity-40',
        active ? 'text-content/80' : 'text-content/45',
        className,
      )}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

/** A quiet text action: "Open all", "Show more", "Refresh". */
export function TextButton({ className = '', type = 'button', ...props }: ComponentPropsWithoutRef<'button'>) {
  return (
    <button
      type={type}
      {...props}
      className={cx('rounded px-1 py-0.5 font-sans text-xs text-content/55 transition-colors duration-150 hover:bg-content/8 hover:text-content disabled:pointer-events-none disabled:opacity-40', className)}
    />
  );
}

/** A compact inline action, for approvals and "Answer in" prompts. `primary` is the solid one. */
export function ChipButton({ primary = false, className = '', type = 'button', ...props }: ComponentPropsWithoutRef<'button'> & { primary?: boolean }) {
  return (
    <button
      type={type}
      {...props}
      className={cx(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2.5 font-sans text-[11px] font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
        primary ? 'bg-content text-background-base hover:bg-content/85' : 'bg-content/10 text-content/75 hover:bg-content/20 hover:text-content',
        className,
      )}
    />
  );
}

/**
 * MonoCode's icon tab (MonoOverview's TabButton): an icon that, while selected, opens out into
 * its name and count, and folds back into the icon when not. `dot` marks a folded tab that
 * holds something new.
 */
export function IconTab({ icon: Icon, label, selected, count, dot = false, className = '', ...props }: Omit<ComponentPropsWithoutRef<'button'>, 'children'> & {
  icon: IconComponent;
  label: string;
  selected: boolean;
  count?: number;
  dot?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...props}
      className={cx(
        'flex h-6 shrink-0 items-center rounded-md px-2 font-sans text-[12px] transition-colors duration-200',
        selected ? 'bg-content/8 text-content' : 'text-content/45 hover:bg-content/5 hover:text-content/80',
        className,
      )}
    >
      {dot ? (
        <span className="relative grid shrink-0">
          <Icon className="size-3.5" strokeWidth={1.75} />
          <span aria-hidden className="absolute -top-0.5 left-2.5 size-1.5 rounded-full bg-accent" />
        </span>
      ) : <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />}
      <span
        aria-hidden={!selected}
        className={cx('grid transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none', selected ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0')}
      >
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
          <span className="pl-1.5">{label}</span>
          {count ? <span className="min-w-4 rounded bg-accent px-1 text-center text-[10px] font-medium leading-4 tabular-nums text-white">{count}</span> : null}
        </span>
      </span>
    </button>
  );
}

export type Tone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger' | 'info';

const DOT: Record<Tone, string> = {
  neutral: 'bg-content/40',
  muted: 'bg-content/25',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
};

/** Only the states that need you colour their words; the rest carry their hue in the dot. */
const WORDS: Record<Tone, string> = {
  neutral: 'text-content/50',
  muted: 'text-content/35',
  success: 'text-content/50',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-content/50',
};

/**
 * A status word with a tone dot, or MonoCode's terminal spinner while something runs.
 * `quiet` drops the words to the faintest ink and leaves the colour to the dot. Pass it
 * rather than a text colour in `className`, which would compete with the tone's.
 */
export function StatusLabel({ tone = 'neutral', busy = false, quiet = false, shrink = false, title, className = '', children }: {
  tone?: Tone;
  busy?: boolean;
  quiet?: boolean;
  /** May shrink below its text (the text truncates) instead of overflowing a narrow row. */
  shrink?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1.5 font-sans', shrink ? 'min-w-0 max-w-full' : 'shrink-0', quiet ? 'text-content/35' : WORDS[tone], className)}>
      {busy ? <TerminalSpinner /> : <span aria-hidden className={cx('size-1.5 shrink-0 rounded-full', DOT[tone])} />}
      {children}
    </span>
  );
}

/** The shimmering "Loading…" line every async surface shows while it waits. */
export function Loading({ className = 'px-4 py-8 text-center', label = 'Loading…' }: { className?: string; label?: string }) {
  return (
    <div role="status" className={cx('font-sans text-sm text-content/40', className)}>
      <Shimmer duration={1.6}>{label}</Shimmer>
    </div>
  );
}

/** Section label inside a popover: the composer's "Add to message" heading. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-content/40">{children}</p>;
}

/** A hairline between groups of popover rows. */
export function MenuDivider() {
  return <div role="separator" className="mx-2 my-1 h-px bg-content/8" />;
}

/** A popover row with icon, title and hint: the composer's mode rows and AccessPicker options. */
export function MenuRow({ icon: Icon, title, hint, selected, checked, highlighted, onSelect, disabled, danger }: {
  icon?: IconComponent;
  title: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  /** Multi-select: a check mark without the selected fill, so the keyboard highlight stays readable. */
  checked?: boolean;
  highlighted?: boolean;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive actions read red, like SecondaryButton's danger variant. */
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected ?? checked}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 ${
        danger ? 'text-danger hover:bg-danger/10' : highlighted || selected ? 'bg-selection text-content' : 'text-content hover:bg-content/5'
      }`}
    >
      {Icon ? <Icon className={`mt-0.5 size-3.5 shrink-0 ${danger ? '' : 'text-content/70'}`} strokeWidth={1.75} /> : null}
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium leading-5">{title}</span>
        {hint ? <span className="mt-0.5 block text-[11px] leading-4 text-content/50">{hint}</span> : null}
      </span>
      {selected || checked ? <Check className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} /> : null}
    </button>
  );
}

/** A quiet empty state in MonoCode's muted type, with an optional icon tile above the title. */
export function Empty({ icon: Icon, title, children, action }: { icon?: IconComponent; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid h-full min-h-0 flex-1 place-items-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center font-sans">
        {Icon ? (
          <span aria-hidden className="mb-3 grid size-9 place-items-center rounded-xl border border-content/8 bg-content/5 text-content/45">
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
        ) : null}
        <p className="text-[13px] font-medium text-content/70">{title}</p>
        {children ? <div className="mt-1 text-[12px] leading-relaxed text-content/45">{children}</div> : null}
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}
