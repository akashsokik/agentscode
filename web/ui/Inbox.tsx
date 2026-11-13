/**
 * The inbox list/detail layout (ACH-D52, ACH-D54), lifted out of CommsPane, which is PodCode's port
 * of MonoCode's Inbox (src/features/inbox/ui/InboxView.tsx: the InboxView rail, InboxCard,
 * InboxDetail's header and InboxDetailTab, and the activity TimelineStop). Comms, Pull requests
 * and Issues all use it, so the three read and behave alike:
 *
 *   <InboxLayout toolbar={...} list={<InboxList>{cards}</InboxList>} detail={...} detailOpen={...} />
 *
 * Below 40rem of pane width it shows one side at a time: the list, or the item picked (with a way
 * back in its InboxBar). Flat: no shadows, theme tones only.
 */
import { useRef, type KeyboardEvent, type ReactNode, type RefObject, type UIEvent } from 'react';
import { ArrowLeft, Search, X } from '../mono/icons.tsx';
import { cx, HeaderButton } from './common.tsx';

/** MonoCode's action buttons (InboxView ACTION_*): the solid one, an outlined one, and a quiet one. */
const ACTION = 'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 font-sans text-[12px] transition-[color,background-color,transform] duration-150 active:scale-[0.97] motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-40';
export const ACTION_FILLED = `${ACTION} h-6.5 bg-content text-background-base hover:bg-content/80`;
export const ACTION_OUTLINE = `${ACTION} h-7 border border-content/15 text-content/80 hover:bg-content/5`;
export const ACTION_GHOST = `${ACTION} h-7 text-content/70 hover:bg-content/10 hover:text-content`;

/** The split: the list rail on the left, the selected item's detail on the right. */
export function InboxLayout({ toolbar, list, detail, detailOpen }: {
  /** Above the list: InboxFilterTabs and InboxSearch, or a page's own filter controls. */
  toolbar: ReactNode;
  list: ReactNode;
  /** The selected item's InboxDetail; null when nothing is selected. */
  detail: ReactNode | null;
  /** An item was picked on purpose: in a narrow pane, show it instead of the list. */
  detailOpen: boolean;
}) {
  return (
    <div className="@container/inbox flex min-h-0 flex-1">
      <div className={cx('flex w-full shrink-0 flex-col border-stroke @min-[40rem]/inbox:w-[min(19rem,42%)] @min-[40rem]/inbox:border-r', detailOpen && '@max-[40rem]/inbox:hidden')}>
        {toolbar}
        {list}
      </div>
      {detail ? (
        <div className={cx('flex min-w-0 flex-1', !detailOpen && '@max-[40rem]/inbox:hidden')}>{detail}</div>
      ) : <div className="flex-1" />}
    </div>
  );
}

export interface InboxFilterOption<T extends string> {
  value: T;
  label: string;
  /** A count beside the label (left out when zero). */
  count?: number;
  /** The count in the warning tone: items that need you. */
  attention?: boolean;
}

/** The rail's filter tabs (MonoCode's InboxSourceTab row), each with its count. */
export function InboxFilterTabs<T extends string>({ label = 'Show', options, value, onChange, fit = false }: {
  label?: string; options: InboxFilterOption<T>[]; value: T; onChange: (value: T) => void;
  /** Each tab as wide as its label and count, for four or more tabs; otherwise equal widths. */
  fit?: boolean;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex h-9 shrink-0 items-center gap-px border-b border-stroke px-2">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'flex h-6 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 font-sans text-[12px] leading-none transition-colors duration-150',
            fit ? 'flex-auto' : 'flex-1',
            value === option.value ? 'bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content',
          )}
        >
          <span className="truncate">{option.label}</span>
          {option.count ? (
            <span className={cx('rounded-full px-1.5 py-0.5 text-[10px] tabular-nums', option.attention ? 'bg-warning/15 text-warning' : 'bg-content/10 text-content/60')}>{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** The rail's search box; Escape clears it first. */
export function InboxSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
      <div className="relative flex h-7 min-w-0 flex-1 items-center">
        <Search aria-hidden className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" strokeWidth={1.75} />
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange(''); } }}
          placeholder={placeholder}
          aria-label={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="h-7 w-full rounded-md bg-transparent pl-7 pr-2 font-sans text-[12px] text-content outline-none placeholder:text-content/40"
        />
      </div>
      {value ? (
        <button type="button" aria-label="Clear filter" title="Clear filter" onClick={() => onChange('')} className="grid size-6 shrink-0 place-items-center rounded-md text-content/45 transition-colors duration-150 hover:bg-content/10 hover:text-content">
          <X className="size-3" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The scrolling list of cards. `onMove(-1 | 1)` runs on ArrowUp/ArrowDown and returns the id of
 * the card to focus (its data-inbox-id), so the keyboard walks the list as the selection moves.
 */
export function InboxList({ label, onMove, empty, children, footer }: {
  label: string;
  onMove?: (step: -1 | 1) => string | undefined;
  /** Pass only when there are no cards: shown instead of the list. */
  empty?: ReactNode;
  children?: ReactNode;
  /** Quiet lines under the list (what was left out, and why). */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (!onMove || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    const id = onMove(e.key === 'ArrowDown' ? 1 : -1);
    if (id) ref.current?.querySelector<HTMLElement>(`[data-inbox-id="${CSS.escape(id)}"]`)?.focus();
  };
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
      {empty ? <p className="px-3 py-3 font-sans text-[12px] text-content/50">{empty}</p> : (
        <ul ref={ref} onKeyDown={onKey} aria-label={label} className="flex flex-col gap-0.5 p-1.5">{children}</ul>
      )}
      {footer ? <div className="px-3 pb-3 font-sans text-[11px] leading-relaxed text-content/40">{footer}</div> : null}
    </div>
  );
}

/** A quiet group label between cards ("Merged recently"). */
export function InboxGroup({ label, count }: { label: string; count?: number }) {
  return (
    <li role="presentation" className="flex items-center gap-2 px-2.5 pb-1 pt-3 font-sans text-[11px] text-content/45">
      <span>{label}</span>
      {count !== undefined ? <span className="tabular-nums text-content/35">{count}</span> : null}
    </li>
  );
}

/**
 * MonoCode's InboxCard: three lines, the source and when, the title, then where it stands.
 * `id` is matched by InboxList's keyboard walk.
 */
export function InboxCard({ id, active, unseen = false, onSelect, label, title, top, meta }: {
  id: string;
  active: boolean;
  unseen?: boolean;
  onSelect: () => void;
  /** The accessible name: the title and what the lines say. */
  label: string;
  title: string;
  /** First line: who or where, then counts and when (right). */
  top: ReactNode;
  /** Third line: the state mark and words, then a gist. */
  meta: ReactNode;
}) {
  return (
    <button
      type="button"
      data-inbox-id={id}
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      aria-label={label}
      title={title}
      className={cx(
        'flex w-full flex-col rounded-md px-2.5 py-2 text-left font-sans transition-colors duration-100',
        active ? 'bg-selection text-content' : 'text-content/80 hover:bg-content/5 hover:text-content',
      )}
    >
      <span className="flex items-center gap-2">{top}</span>
      <span className={cx('mt-1 line-clamp-1 text-[13px] leading-snug text-content', unseen ? 'font-semibold' : 'font-medium')}>{title}</span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-content/45">{meta}</span>
    </button>
  );
}

/** The detail side: an InboxBar on top, then the scrolling body (hero, tabs, activity). */
export function InboxDetail({ bar, children, rootRef, scrollRef, onScroll, overlay }: {
  bar: ReactNode;
  children: ReactNode;
  rootRef?: RefObject<HTMLDivElement | null>;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  /** Floats over the body (a "new messages" button). */
  overlay?: ReactNode;
}) {
  return (
    <div ref={rootRef} className="@container/detail flex min-w-0 flex-1 flex-col">
      {bar}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="agent-transcript min-h-0 flex-1 overflow-y-auto">{children}</div>
        {overlay}
      </div>
    </div>
  );
}

/** The detail's identity bar (h-9): a way back when the list is hidden, then what the item is and where it stands. */
export function InboxBar({ backLabel, onBack, children }: { backLabel: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke pl-2 pr-2 font-sans text-[12px] text-content/50 @min-[40rem]/inbox:pl-4">
      {/* Only when the list is hidden beside it. */}
      <HeaderButton icon={ArrowLeft} label={backLabel} className="-mr-1 @min-[40rem]/inbox:hidden" onClick={onBack} />
      {children}
    </div>
  );
}

/** MonoCode's detail header: the title, then whatever follows it (people, a meta line, actions), and tabs below. */
export function InboxHero({ title, children, tabs }: { title: string; children?: ReactNode; tabs?: ReactNode }) {
  return (
    <header className="border-b border-stroke">
      <div className={cx('mx-auto flex w-full max-w-3xl flex-col gap-2.5 px-4 pt-5 @min-[40rem]/inbox:px-6', tabs ? '' : 'pb-4')}>
        <h1 title={title} className="line-clamp-2 font-sans text-[18px] font-semibold leading-tight text-content">{title}</h1>
        {children}
        {tabs}
      </div>
    </header>
  );
}

/** MonoCode's InboxDetailTab row: the item's sections (Summary, Code, Checks). */
export function InboxTabs<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: { value: T; label: string; count?: number; mark?: ReactNode }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div role="tablist" aria-label={label} className="flex h-9 items-stretch gap-4">
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cx('relative flex h-9 items-center gap-1.5 font-sans text-[12px] leading-none', value === tab.value ? 'text-content' : 'text-content/50 hover:text-content')}
        >
          {tab.mark}
          {tab.label}
          {tab.count ? <span className="rounded-full bg-content/10 px-1.5 py-0.5 text-[10px] tabular-nums text-content/60">{tab.count}</span> : null}
          {value === tab.value ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-content" /> : null}
        </button>
      ))}
    </div>
  );
}

/** A section of the detail body ("Activity · 4 messages"), at the reading width. */
export function InboxSection({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-3xl px-4 pb-8 pt-5 @min-[40rem]/inbox:px-6">
      <div className="mb-3 flex items-center gap-2 font-sans text-[12px] text-content/50">
        <h2 className="text-content/70">{title}</h2>
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * MonoCode's TimelineStop: a rail column with the stop's node, and its content beside it. The
 * lead segment centres a card's node on the card header, and an event's on its 20px row.
 */
export function TimelineStop({ node, first, last, card = false, fresh = false, children }: {
  node: ReactNode;
  first: boolean;
  last: boolean;
  card?: boolean;
  /** Arrived while the item was open: grows in. */
  fresh?: boolean;
  children: ReactNode;
}) {
  return (
    <li className={fresh ? 'reveal-height-in' : undefined}>
      <div className="flex gap-3">
        <div aria-hidden className="flex w-5 shrink-0 flex-col items-center">
          <span className={cx('w-px shrink-0', card ? 'h-2' : 'h-0', !first && 'bg-content/10')} />
          <div className="flex size-5 shrink-0 items-center justify-center">{node}</div>
          {last ? null : <span className="w-px flex-1 bg-content/10" />}
        </div>
        <div className={cx('min-w-0 flex-1', !last && 'pb-3')}>{children}</div>
      </div>
    </li>
  );
}
