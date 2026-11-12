/**
 * The shared list of the SuperAgent's right-panel tabs (ACH-D37): one toolbar (search, a segmented
 * filter with counts, + for adding), sentence-case section headers, a one-line row and one empty
 * state, used alike by Decisions, Goals, Routines and Notes. Rows follow Work's WorkRow (30px,
 * 12px text, quiet meta at the right); a row opens in place on click or ⏎, its actions show on
 * hover and in the shared right-click menu (ACH-D27), which ⇧F10 or the menu key also opens.
 * Flat, theme colours only (ACH-D7, ACH-D14).
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, Plus, Search, X } from '../mono/icons.tsx';
import { isMenuKey } from '../panelList.ts';
import { ContextMenu, openContextMenu, type MenuAnchor } from './ContextMenu.tsx';
import { useElementWidth } from './useElementWidth.ts';

type Icon = typeof Plus;

/** Below this toolbar width the filter drops its counts, so search keeps its room. */
const COUNTS_FROM = 360;

export interface FilterOption<T extends string> { value: T; label: string; count?: number }

export function PanelToolbar<T extends string>({ query, onQuery, searchLabel, filter, onAdd, addLabel, children }: {
  query: string;
  onQuery: (query: string) => void;
  searchLabel: string;
  filter?: { options: FilterOption<T>[]; value: T; onChange: (value: T) => void; label: string };
  onAdd?: () => void;
  addLabel?: string;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const width = useElementWidth(box);
  const counts = width !== null && width >= COUNTS_FROM;
  return (
    <div ref={box} data-panel-toolbar className="flex h-9 shrink-0 items-center gap-1.5 px-2.5 font-sans">
      <label className="flex h-[26px] min-w-[72px] flex-1 items-center gap-1.5 rounded-[7px] bg-content/5 px-2 text-[12px] text-content/40 focus-within:text-content">
        <Search aria-hidden className="size-[13px] shrink-0" strokeWidth={1.75} />
        <input
          ref={input}
          value={query}
          onChange={e => onQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); onQuery(''); } }}
          placeholder="Search"
          aria-label={searchLabel}
          className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40"
        />
        {query ? (
          <button type="button" aria-label="Clear the search" onClick={() => { onQuery(''); input.current?.focus(); }} className="grid size-4 shrink-0 place-items-center rounded text-content/40 hover:text-content">
            <X className="size-3" strokeWidth={1.75} />
          </button>
        ) : null}
      </label>
      {filter ? (
        <div role="group" aria-label={filter.label} className="inline-flex shrink-0 gap-0.5 rounded-[7px] bg-content/5 p-0.5 text-[12px]">
          {filter.options.map(o => (
            <button
              key={o.value}
              type="button"
              aria-pressed={filter.value === o.value}
              onClick={() => filter.onChange(o.value)}
              className={`inline-flex h-[22px] items-center gap-1 whitespace-nowrap rounded-[5px] px-[7px] transition-colors ${filter.value === o.value ? 'bg-content/10 text-content' : 'text-content/55 hover:text-content/80'}`}
            >
              {o.label}
              {counts && o.count !== undefined ? <span className="tabular-nums text-content/35">{o.count}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {children}
      {onAdd ? (
        <button type="button" aria-label={addLabel} title={addLabel} onClick={onAdd} className="grid size-[26px] shrink-0 place-items-center rounded-[7px] text-content/50 transition-colors hover:bg-content/5 hover:text-content">
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}

/** A section's header: sentence case, the count at the right; a folding one has a chevron. */
export function PanelSection({ label, count, folded, onToggle }: { label: string; count?: number; folded?: boolean; onToggle?: () => void }) {
  const body = (
    <>
      <span className="inline-flex items-center gap-1">
        {onToggle ? <ChevronDown aria-hidden className={`size-3 transition-transform ${folded ? '-rotate-90' : ''}`} strokeWidth={2} /> : null}
        {label}
      </span>
      {count !== undefined ? <span className="font-normal tabular-nums">{count}</span> : null}
    </>
  );
  const cls = 'flex h-7 w-full items-end justify-between px-1.5 pb-1 font-sans text-[11px] font-medium text-content/50';
  return onToggle
    ? <button type="button" aria-expanded={!folded} onClick={onToggle} className={`${cls} text-left hover:text-content/80`}>{body}</button>
    : <h4 className={cls}>{body}</h4>;
}

/**
 * One item, one line: a 16px mark, the title (it gets the room), quiet meta at the right. Hover or
 * focus swaps the meta for the row's quick actions. Click or ⏎ calls onOpen (expand in place, or
 * open a page); ↑ and ↓ move between rows; right-click, ⇧F10 or the menu key open the menu.
 */
export function PanelRow({ id, lead, title, label, meta, actions, dim = false, selected = false, expanded, onOpen, menu, menuLabel, children }: {
  id: string;
  /** The 16px mark before the title; left out, the title starts at the edge (Notes: the chip leads). */
  lead?: ReactNode;
  title: ReactNode;
  /** The whole item in words: the row's accessible name and its tooltip (the full text on hover). */
  label: string;
  meta?: ReactNode;
  /** Quick actions shown on hover or focus, in place of the meta. */
  actions?: ReactNode;
  dim?: boolean;
  selected?: boolean;
  /** Undefined for a row that opens elsewhere instead of expanding. */
  expanded?: boolean;
  onOpen: () => void;
  menu?: (close: () => void) => ReactNode;
  menuLabel?: string;
  /** What shows under the row while it is expanded. */
  children?: ReactNode;
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (menu && isMenuKey(e)) { e.preventDefault(); setAnchor(e.currentTarget); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(e.currentTarget.closest('[data-panel-list]')?.querySelectorAll<HTMLButtonElement>('[data-panel-row-main]') ?? [])];
    const next = rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  };
  return (
    <div data-panel-row={id} onContextMenu={menu ? e => openContextMenu(e, setAnchor) : undefined}>
      <div className={`group/row relative flex h-[30px] items-center rounded-[7px] transition-colors ${selected || expanded || anchor ? 'bg-selection' : 'hover:bg-content/5'}`}>
        <button
          type="button"
          data-panel-row-main
          aria-expanded={expanded}
          aria-label={label}
          title={label}
          onClick={onOpen}
          onKeyDown={onKeyDown}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[7px] px-1.5 text-left font-sans text-[12px] outline-none focus-visible:bg-content/7"
        >
          {lead !== undefined ? <span aria-hidden className="grid w-4 shrink-0 place-items-center text-content/45">{lead}</span> : null}
          <span className={`min-w-0 flex-1 truncate ${dim ? 'text-content/45' : 'text-content/85'}`}>{title}</span>
          {meta ? <span className={`flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-content/45 ${actions ? 'group-hover/row:invisible group-focus-within/row:invisible' : ''}`}>{meta}</span> : null}
        </button>
        {actions ? (
          <span className="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">{actions}</span>
        ) : null}
      </div>
      {expanded && children ? <div className="pb-2 pl-[30px] pr-2 pt-0.5 font-sans text-[12px] leading-relaxed text-content/75">{children}</div> : null}
      {anchor && menu ? <ContextMenu anchor={anchor} onClose={() => setAnchor(null)} label={menuLabel ?? label}>{menu(() => setAnchor(null))}</ContextMenu> : null}
    </div>
  );
}

/** A quick action on a row (shown on hover): a quiet text button. */
export function RowAction({ children, onClick, label, disabled }: { children: ReactNode; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="h-[22px] rounded-[5px] bg-content/7 px-1.5 font-sans text-[11.5px] text-content/75 transition-colors hover:bg-content/12 hover:text-content disabled:opacity-40">
      {children}
    </button>
  );
}

/** An icon-only quick action on a row. */
export function RowIcon({ icon: IconC, label, onClick, disabled }: { icon: Icon; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid size-[22px] place-items-center rounded-[5px] text-content/45 transition-colors hover:bg-content/7 hover:text-content disabled:pointer-events-none disabled:opacity-30">
      <IconC className="size-3" strokeWidth={1.75} />
    </button>
  );
}

/** A button inside an expanded row: a quiet outlined one. */
export function DetailButton({ children, onClick, disabled, danger = false, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; label?: string }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={`h-6 rounded-md border border-content/12 px-2 font-sans text-[11.5px] transition-colors hover:bg-content/5 disabled:opacity-40 ${danger ? 'text-danger' : 'text-content/75 hover:text-content'}`}>
      {children}
    </button>
  );
}

/** The one empty state: a quiet icon, a title, one line, and at most one action. Also "No matches". */
export function PanelEmpty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-7 pb-6 pt-10 text-center font-sans">
      <span aria-hidden className="grid size-5 place-items-center text-content/25 [&>svg]:size-5">{icon}</span>
      <p className="mt-2.5 text-[13px] text-content/60">{title}</p>
      {children ? <p className="mt-1 text-[12px] leading-relaxed text-content/45">{children}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** The scrolling list under the toolbar; rows inside move focus with ↑ and ↓. */
export function PanelList({ label, children }: { label: string; children: ReactNode }) {
  return <div data-panel-list aria-label={label} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-6">{children}</div>;
}
