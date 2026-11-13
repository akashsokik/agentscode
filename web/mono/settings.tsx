/**
 * Settings controls vendored from MonoCode (features/settings/ui/SettingsView.tsx):
 * Toggle, Select, Segmented, Group and Row. Changes: no sound cue on Toggle, no
 * settings-search highlight.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown } from "./icons.tsx";
import { MenuRow, MenuRowRole } from "../ui/common.tsx";
import { Popover } from "./Popover.tsx";
import { filterOptions } from "./filter.ts";

export { filterOptions };

export function Toggle({
  label,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      disabled={disabled}
      onClick={() => {
        onChange(!on);
      }}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-accent" : "bg-content/20 hover:bg-content/25"
      }`}
    >
      <span
        className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          on ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

/** Theme-aware dropdown for a Settings row: a trigger button opening a Popover listbox. */
export type SelectOption = {
  value: string;
  label: string;
  icon?: ReactNode;
  /** Options with a group are listed under its heading, in the order the groups first appear. */
  group?: string;
  disabled?: boolean;
};

export function Select({
  label,
  value,
  options,
  onChange,
  onOpen,
  searchable = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  onOpen?: () => void;
  /** A search box over the list, for long ones such as OrcaCode's models. */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = searchable ? filterOptions(options, query) : options;
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      shown.findIndex((option) => option.value === value),
    ),
  );
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const activeId =
    shown[active] != null ? `${listId}-opt-${active}` : undefined;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    // The popover takes focus as it opens; the search box takes it back.
    if (searchable) requestAnimationFrame(() => search.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && searchable) setActive(0);
  }, [query, open, searchable]);

  useEffect(() => {
    if (open) onOpen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(shown.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Home" && !typing) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End" && !typing) {
      e.preventDefault();
      setActive(shown.length - 1);
      return;
    }
    if (e.key === "Tab") {
      const option = shown[active];
      if (option && !option.disabled && option.value !== value) onChange(option.value);
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const option = shown[active];
      if (option && !option.disabled) pick(option.value);
    }
  };

  return (
    <div ref={root} className="relative max-w-52">
      <button
        type="button"
        ref={trigger}
        aria-label={`${label}: ${selected?.label ?? value}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex w-full items-center justify-between gap-2 rounded-md border bg-content/5 px-2 py-1 text-left text-[12px] text-content transition-colors duration-150 hover:border-content/20 ${open ? "border-content/20" : "border-content/10"}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {selected?.icon ? (
            <span className="grid size-4 shrink-0 place-items-center">
              {selected.icon}
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {selected ? selected.label : value}
          </span>
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-content/50 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          width={searchable ? 320 : 280}
          maxHeight={searchable ? 400 : 320}
          autoFocus
          onDismiss={(reason) => {
            setOpen(false);
            if (reason === "escape") trigger.current?.focus();
          }}
          role="listbox"
          aria-label={label}
          aria-activedescendant={activeId}
          tabIndex={-1}
          onKeyDown={onMenuKey}
          className="overflow-y-auto overscroll-contain p-1"
        >
          {searchable ? (
            <div className="sticky top-0 z-10 px-1 pb-1 pt-0.5 backdrop-blur-md">
              <input
                ref={search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${options.length} ${label.toLowerCase()}s`}
                aria-label={`Search ${label.toLowerCase()}`}
                className="w-full rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content outline-none placeholder:text-content/35"
              />
            </div>
          ) : null}
          {searchable && !shown.length ? (
            <p className="px-2 py-1.5 text-[12px] text-content/50">No match</p>
          ) : null}
          <MenuRowRole.Provider value="option">
          {shown.map((option, index) => {
            const isSelected = option.value === value;
            const highlighted = index === active;
            const heading = option.group && option.group !== shown[index - 1]?.group ? option.group : null;
            return (
              <div key={option.value}>
                {heading ? (
                  <p className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">{heading}</p>
                ) : null}
                <MenuRow
                  ref={highlighted ? activeOption : undefined}
                  id={`${listId}-opt-${index}`}
                  tabIndex={-1}
                  selected={isSelected}
                  highlighted={highlighted}
                  aria-disabled={option.disabled || undefined}
                  disabled={option.disabled}
                  onMouseEnter={() => setActive(index)}
                  onSelect={() => pick(option.value)}
                  density="compact"
                  leading={option.icon}
                  title={option.label}
                />
              </div>
            );
          })}
          </MenuRowRole.Provider>
        </Popover>
      ) : null}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  optionIdPrefix,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  optionIdPrefix?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-grid max-w-full shrink-0 gap-0.5 rounded-md border border-content/10 p-0.5 text-[12px]"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map((option) => (
        <button
          id={
            optionIdPrefix
              ? `${optionIdPrefix}-${option.value.toLowerCase()}`
              : undefined
          }
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={`min-w-0 rounded-[5px] px-2.5 py-1 transition-colors duration-150 ${
            value === option.value
              ? "segmented-active bg-selection text-content"
              : "text-content/50 hover:bg-content/5 hover:text-content"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A titled card of related settings. */
export function Group({
  id,
  title,
  description,
  action,
  children,
}: {
  /** Matches a `SETTINGS_INDEX` id when the whole card is the search target. */
  id?: string;
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const flash = false;

  return (
    <section
      id={id}
      data-setting-id={id}
      className="pt-8 first:pt-0"
    >
      <div className="flex items-end gap-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-content">{title}</h2>
          {description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0 pb-0.5">{action}</div> : null}
      </div>
      <div
        className={`overflow-hidden rounded-xl border bg-content/3 transition-colors ${
          flash ? "border-accent/60" : "border-content/10"
        }`}
      >
        {children}
      </div>
    </section>
  );
}

export function Row({
  id,
  label,
  description,
  children,
}: {
  /** Matches a `SETTINGS_INDEX` id so search can scroll here. */
  id?: string;
  label: ReactNode;
  description?: string;
  children?: ReactNode;
}) {
  const flash = false;

  return (
    <div
      id={id}
      data-setting-id={id}
      className={`settings-row flex items-start gap-6 border-b border-content/5 px-4 py-3.5 transition-colors last:border-b-0 ${
        flash ? "bg-accent/10" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-content">{label}</div>
        {description ? (
          <p className="mt-1 text-[12px] leading-relaxed text-content/45">
            {description}
          </p>
        ) : null}
      </div>
      <div className="settings-row-control flex min-w-0 max-w-[60%] shrink-0 flex-wrap items-center justify-end gap-2">
        {children}
      </div>
    </div>
  );
}
