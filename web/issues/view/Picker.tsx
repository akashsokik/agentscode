/**
 * A property picker: a search field over its options, the current one shown by its fill only,
 * never a check (ACH-D46 option B). ↑ ↓ move, ⏎ picks, ⎋ closes. MenuRow's `active` and
 * `current` draw the keyboard row and the value in force (ACH-D49).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Popover } from '../../mono/Popover.tsx';
import { MenuRow, MenuRowRole } from '../../ui/common.tsx';
import { matchesQuery } from './issueViewModel.ts';

export interface Option { value: string; label: string; icon?: ReactNode }

/** A picker: a search field over its options, the current one filled. */
export function Picker({ anchor, label, options, current, onPick, onClose, header, width = 240 }: { anchor: HTMLElement; label: string; options: Option[]; current: string; onPick: (value: string) => void; onClose: () => void; header?: ReactNode; width?: number }) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => options.filter(o => matchesQuery(o.label, query)), [options, query]);
  const [at, setAt] = useState(() => Math.max(0, options.findIndex(o => o.value === current)));
  useEffect(() => setAt(i => Math.min(i, Math.max(0, shown.length - 1))), [shown.length]);
  return (
    <Popover anchor={anchor} side="bottom" align="start" width={width} onDismiss={onClose} className="p-1.5">
      {header}
      <input
        autoFocus
        aria-label={`Find a ${label.toLowerCase()}`}
        placeholder={`${label}…`}
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setAt(i => (i + 1) % Math.max(1, shown.length)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setAt(i => (i - 1 + shown.length) % Math.max(1, shown.length)); }
          if (e.key === 'Enter' && shown[at]) { e.preventDefault(); onPick(shown[at].value); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
        }}
        className="mb-1 h-7 w-full rounded-md bg-content/5 px-2 font-sans text-[12px] text-content outline-none placeholder:text-content/40"
      />
      <div role="listbox" aria-label={label} className="max-h-[320px] overflow-y-auto">
        <MenuRowRole.Provider value="option">
          {shown.map((o, i) => (
            <MenuRow
              key={o.value}
              title={<span className="flex items-center gap-2">{o.icon}<span className="truncate">{o.label}</span></span>}
              // The keyboard row by MonoCode's focus fill, the value in force by the quiet one, no
              // check (ACH-D49, ACH-D46 B); `current` also sets aria-selected.
              active={i === at}
              current={o.value === current}
              onSelect={() => onPick(o.value)}
            />
          ))}
          {!shown.length ? <p className="px-2 py-2 font-sans text-[12px] text-content/45">No matches</p> : null}
        </MenuRowRole.Provider>
      </div>
    </Popover>
  );
}

