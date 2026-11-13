import { useState, type KeyboardEvent } from 'react';
import type { IssueStatus, SuperIssue } from '../../shared/types.ts';
import { ChevronLeft, ChevronRight, Search, X } from '../mono/icons.tsx';
import { Popover, type PopoverAnchor } from '../mono/Popover.tsx';
import { Segmented, Toggle } from '../mono/settings.tsx';
import { ChipButton, cx, MenuDivider, MenuRow } from '../ui/common.tsx';
import { menuKeyTarget } from '../ui/menuFocus.ts';
import { ISSUE_ICON, MenuPage } from './issueParts.tsx';
import {
  activeFilters, chipText, clearFilter, filterOptions, GROUPINGS, ISSUE_PROPERTIES, ORDERINGS, ROW_PROPERTIES, toggleFilter,
  type IssueFilters, type IssueNames, type IssueProperty, type IssuesDisplay, type IssuesGrouping, type IssuesOrdering,
} from './issuesView.ts';

/** Arrow keys, Home and End move between a popover's rows; from its search field, down goes to the first value. */
function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled), [role="menuitem"]:not(:disabled)')];
  const fromField = (e.target as HTMLElement).tagName === 'INPUT';
  if (fromField && e.key !== 'ArrowDown') return;
  // Down from the search field goes to the first value, not back up to the Back row above the field.
  const firstValue = rows.findIndex(r => r.getAttribute('role') === 'option');
  const target = fromField ? (firstValue < 0 ? null : firstValue) : menuKeyTarget(rows.length, rows.indexOf(document.activeElement as HTMLElement), e.key);
  if (target === null) return;
  e.preventDefault();
  e.stopPropagation();
  rows[target].focus();
}

/**
 * The Filter menu (F): the properties first; picking one shows its values in place, with a search
 * field, a count beside each and a way back. Values are checked on and off without closing, so
 * several can be chosen. (ACH-D43 gap 3 asks whether these open as flyouts instead.)
 */
export function FilterMenu({ anchor, issues, filters, onChange, names, today, onClose, start }: {
  anchor: PopoverAnchor;
  issues: readonly SuperIssue[];
  filters: IssueFilters;
  onChange: (filters: IssueFilters) => void;
  names: IssueNames;
  today: string;
  onClose: () => void;
  /** Opens straight on one property's values (a chip's click). */
  start?: IssueProperty;
}) {
  const [property, setProperty] = useState<IssueProperty | null>(start ?? null);
  const [query, setQuery] = useState('');
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const options = property ? filterOptions(issues, property, filters, today, names).filter(o => words.every(w => o.label.toLowerCase().includes(w))) : [];
  const chosen = property ? filters[property] ?? [] : [];
  const label = property ? ISSUE_PROPERTIES.find(p => p.property === property)!.label : 'Filter';
  return (
    <Popover anchor={anchor} side="bottom" align="start" width={248} onDismiss={onClose} ignore="[data-issues-filter]" role="dialog" aria-label={property ? `Filter by ${label.toLowerCase()}` : 'Filter'} onKeyDown={moveFocus} className="p-1.5 font-sans">
      <MenuPage page={property ?? 'properties'}>
        {property === null ? (
          <div role="menu" aria-label="Filter by">
            {ISSUE_PROPERTIES.map(p => (
              <MenuRow
                key={p.property}
                role="menuitem"
                title={(
                  <span className="flex items-center justify-between gap-2">
                    {p.label}
                    <span className="flex items-center gap-1 text-[11px] font-normal text-content/45">
                      {filters[p.property]?.length ? <span className="tabular-nums">{filters[p.property]!.length}</span> : null}
                      <ChevronRight aria-hidden className="size-3" strokeWidth={1.75} />
                    </span>
                  </span>
                )}
                onSelect={() => { setQuery(''); setProperty(p.property); }}
              />
            ))}
          </div>
        ) : (
          <>
            <MenuRow role="menuitem" icon={ChevronLeft} title={label} onSelect={() => { setQuery(''); setProperty(null); }} />
            <label className="mx-1 mb-1 flex h-[26px] items-center gap-1.5 rounded-[7px] bg-content/5 px-2 text-[12px] text-content/40 focus-within:text-content">
              <Search aria-hidden className="size-[13px] shrink-0" strokeWidth={1.75} />
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                placeholder={`Search ${label.toLowerCase()}`}
                aria-label={`Search ${label.toLowerCase()}`}
                className="min-w-0 flex-1 bg-transparent text-content outline-none placeholder:text-content/40"
              />
            </label>
            <div role="listbox" aria-multiselectable aria-label={label} className="max-h-72 overflow-y-auto">
              {options.map(o => (
                <MenuRow
                  key={o.value}
                  role="option"
                  icon={property === 'status' ? ISSUE_ICON[o.value as IssueStatus].icon : undefined}
                  checked={chosen.includes(o.value)}
                  title={<span className="flex items-center justify-between gap-2"><span className="truncate">{o.label}</span><span className="text-[11px] font-normal tabular-nums text-content/40">{o.count}</span></span>}
                  onSelect={() => onChange(toggleFilter(filters, property, o.value))}
                />
              ))}
              {!options.length ? <p className="px-2 py-2 text-[12px] text-content/45">No matches.</p> : null}
            </div>
            {chosen.length ? (
              <>
                <MenuDivider />
                <MenuRow role="menuitem" icon={X} title={`Clear ${label.toLowerCase()}`} onSelect={() => onChange(clearFilter(filters, property))} />
              </>
            ) : null}
          </>
        )}
      </MenuPage>
    </Popover>
  );
}

/** The active filters as chips under the toolbar: click one to change it, × to drop it. */
export function FilterChips({ filters, names, onEdit, onChange }: { filters: IssueFilters; names: IssueNames; onEdit: (property: IssueProperty, el: HTMLElement) => void; onChange: (filters: IssueFilters) => void }) {
  const active = activeFilters(filters);
  if (!active.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5 font-sans">
      {active.map(({ property, values }) => {
        const text = chipText(property, values, names);
        return (
          <span key={property} className="inline-flex items-center">
            <ChipButton className="rounded-r-none pr-1.5" aria-label={`${text}. Change`} onClick={e => onEdit(property, e.currentTarget)}>{text}</ChipButton>
            <ChipButton className="rounded-l-none border-l border-background-base/40 px-1.5" aria-label={`Remove the filter ${text}`} onClick={() => onChange(clearFilter(filters, property))}>
              <X aria-hidden className="size-3" strokeWidth={1.75} />
            </ChipButton>
          </span>
        );
      })}
      {active.length > 1 ? <button type="button" onClick={() => onChange({})} className="h-6 rounded-md px-1.5 text-[11px] text-content/50 hover:text-content">Clear all</button> : null}
    </div>
  );
}

/** Display (⇧V): grouping and order, what the list includes, and which properties rows show. */
export function DisplayMenu({ anchor, display, onChange, onClose }: { anchor: PopoverAnchor; display: IssuesDisplay; onChange: (display: IssuesDisplay) => void; onClose: () => void }) {
  const set = (patch: Partial<IssuesDisplay>) => onChange({ ...display, ...patch });
  const toggles: { key: 'showSubIssues' | 'showEmptyGroups' | 'showClosed'; label: string }[] = [
    { key: 'showSubIssues', label: 'Sub-issues' },
    { key: 'showEmptyGroups', label: 'Empty groups' },
    { key: 'showClosed', label: 'Done and Canceled' },
  ];
  return (
    <Popover anchor={anchor} side="bottom" align="end" width={328} onDismiss={onClose} ignore="[data-issues-display]" role="dialog" aria-label="Display options" className="flex flex-col gap-3 p-3 font-sans text-[12px]">
      {/* Segmented, not Select: a Select's own popover would float under this one and count as a click outside it. */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-content/45">Grouping</span>
        <Segmented label="Grouping" value={display.groupBy} options={GROUPINGS.map(g => ({ value: g.value, label: g.short }))} onChange={(v: IssuesGrouping) => set({ groupBy: v })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-content/45">Ordering</span>
        <Segmented label="Ordering" value={display.orderBy} options={ORDERINGS.map(o => ({ value: o.value, label: o.short }))} onChange={(v: IssuesOrdering) => set({ orderBy: v })} />
      </div>
      <div className="h-px bg-content/8" />
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-content/45">Show</span>
        {toggles.map(t => (
          <div key={t.key} className="flex items-center justify-between gap-3">
            <span className="text-content/75">{t.label}</span>
            <Toggle label={t.label} on={display[t.key]} onChange={on => set({ [t.key]: on })} />
          </div>
        ))}
      </div>
      <div className="h-px bg-content/8" />
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-content/45">Properties on rows</span>
        <div className="flex flex-wrap gap-1">
          {ROW_PROPERTIES.map(p => {
            const on = display.properties.includes(p.value);
            return (
              <button
                key={p.value}
                type="button"
                aria-pressed={on}
                onClick={() => set({ properties: ROW_PROPERTIES.map(r => r.value).filter(v => (v === p.value ? !on : display.properties.includes(v))) })}
                className={cx('h-6 rounded-md px-2 text-[11px] transition-colors', on ? 'bg-content/10 text-content' : 'text-content/45 hover:bg-content/5 hover:text-content/75')}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </Popover>
  );
}

