/**
 * The composer's model picker, after MonoCode's ModelPicker (https://github.com/hardbeat920/monocode,
 * src/features/sessions/ui/ModelPicker.tsx and ModelPicker.css, MIT License): the trigger pill opens
 * a menu with Reasoning, Service Tier and Model rows, and each opens its own submenu beside it. The
 * rows, sizes, keyboard handling and the Max and Ultra tiles are MonoCode's. An agent's engine is
 * fixed, so the provider rail lists the engine's own providers (OrcaCode's), and only when it has
 * several; favorites and recent models are left out. Default and a custom model id stay.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import type { Agent, AgentPatch, EngineModels } from '../../shared/types.ts';
import { effortLabel, modelLabel } from '../format.ts';
import { EngineIcon, ENGINE_NAMES } from '../ui/EngineIcon.tsx';
import { Check, ChevronDown, ChevronRight, Search } from '../mono/icons.tsx';
import { LAYER } from '../mono/layers.ts';
import { Popover } from '../mono/Popover.tsx';
import { useLockOverscroll } from '../mono/useLockOverscroll.ts';
import { notSetUp } from '../format.ts';
import { ProviderIcon } from '../ui/ProviderIcon.tsx';
import { currentModelRow, effectiveEffort, effortRowLabel, effortRows, initialGroup, menuEntries, modelGroups, modelRowValue, modelRows, tierName, tierRows, type Entry, type ModelGroup, type ModelRow } from './modelMenu.ts';

const MENU_WIDTH = 250;
const MODEL_MENU_WIDTH = 310;
/** The provider rail's column, MonoCode's 32px tabs with padding. */
const RAIL_WIDTH = 48;
const MODEL_MENU_HEIGHT = 340;
const SETTING_MENU_WIDTH = 210;
const SUBMENU_OVERLAP = -4;
/** Everything that belongs to the picker: a pointer landing on any of it is not outside. */
const SELF = '[data-model-picker]';


/** MonoCode's row classes: the highlighted row is literally bg-selection, which the tiles key on. */
function rowClass(highlighted: boolean, height = 'h-9'): string {
  return `flex ${height} w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] ${highlighted ? 'bg-selection text-content' : 'text-content hover:bg-content/5'}`;
}

const EFFORT_TILE_COLUMNS = 32;
const EFFORT_TILE_ROWS = 5;

/** The tiles that ripple across the Max and Ultra rows while highlighted (styles.css). */
function EffortTileShimmer() {
  return (
    <span className="codex-effort-tiles" aria-hidden="true">
      {Array.from({ length: EFFORT_TILE_COLUMNS * EFFORT_TILE_ROWS }, (_, index) => {
        const column = index % EFFORT_TILE_COLUMNS;
        const row = Math.floor(index / EFFORT_TILE_COLUMNS);
        const centerColumn = (EFFORT_TILE_COLUMNS - 1) / 2;
        const centerRow = (EFFORT_TILE_ROWS - 1) / 2;
        const distance = Math.hypot((column - centerColumn) / centerColumn, (row - centerRow) / centerRow);
        const filled = (index * 73 + index * index * 19 + 23) % 101 < 65;
        return (
          <span
            key={index}
            className={`codex-effort-tile${filled ? ' codex-effort-tile--filled' : ''}`}
            style={{ '--tile-distance': distance } as CSSProperties}
          />
        );
      })}
    </span>
  );
}

function effortTone(value: string): 'max' | 'ultra' | undefined {
  return value === 'ultra' ? 'ultra' : value === 'max' ? 'max' : undefined;
}

export function ModelPicker({ agent, models, onChange, onClose }: {
  agent: Agent;
  models: EngineModels | undefined;
  onChange: (change: AgentPatch) => void;
  /** Called when the picker closes by a choice or Escape, to hand focus back to the message box. */
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [submenu, setSubmenu] = useState<Entry | null>(null);
  const [activeRow, setActiveRow] = useState<HTMLButtonElement | null>(null);
  const [activeEffort, setActiveEffort] = useState(0);
  const [activeModel, setActiveModel] = useState(0);
  const [activeTier, setActiveTier] = useState(0);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Keyed on the fields, not the agent: it is a new object on every update while it works, and
  // that must not move the keyboard highlight.
  const { model: agentModel, effort: agentEffort, serviceTier: agentTier = '' } = agent;
  const entries = useMemo<Entry[]>(() => menuEntries({ model: agentModel, effort: agentEffort, serviceTier: agentTier }, models), [agentModel, agentEffort, agentTier, models]);
  const efforts = useMemo(() => effortRows({ model: agentModel, effort: agentEffort }, models), [agentModel, agentEffort, models]);
  const tiers = useMemo(() => tierRows({ model: agentModel, serviceTier: agentTier }, models), [agentModel, agentTier, models]);
  const groups = useMemo(() => modelGroups(models), [models]);
  const rows = useMemo(() => modelRows({ model: agentModel }, models, query, groups.length > 1 ? group : null), [agentModel, models, query, groups, group]);
  const tierShown = agentTier ? tierName({ model: agentModel, serviceTier: agentTier }, models) : '';
  const effort = effectiveEffort(agent, models);
  const effortShown = entries.includes('effort') && effort ? effortLabel(effort, null) : '';
  const name = modelLabel(agent, models);
  const switching = agent.engine === 'claude' ? 'Switches immediately.' : 'Applies from the next turn.';

  const dismiss = (restore: boolean) => {
    setOpen(false);
    setSubmenu(null);
    if (restore) onCloseRef.current?.();
  };

  useEffect(() => {
    if (!open) return;
    setActive(0);
    setSubmenu(null);
    setQuery('');
    setGroup(initialGroup({ model: agentModel }, groups));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (submenu !== 'tier') return;
    const index = tiers.findIndex(row => row.value === agentTier);
    setActiveTier(index >= 0 ? index : 0);
  }, [submenu, tiers, agentTier]);

  useEffect(() => {
    if (submenu !== 'effort') return;
    const index = efforts.findIndex(row => row.value === agentEffort);
    setActiveEffort(index >= 0 ? index : 0);
  }, [submenu, efforts, agentEffort]);

  useEffect(() => {
    if (submenu !== 'model') return;
    setActiveModel(currentModelRow(rows, { model: agentModel }));
  }, [submenu, rows, agentModel]);

  // The model flyout takes focus for its search; leaving it hands the keys back to the menu.
  useEffect(() => {
    if (open && submenu !== 'model' && !menu.current?.contains(document.activeElement)) menu.current?.focus({ preventScroll: true });
  }, [open, submenu]);

  const showEntry = (entry: Entry) => setSubmenu(entry);

  const moveEntry = (direction: 1 | -1) => {
    setSubmenu(null);
    setActive(index => (index + direction + entries.length) % entries.length);
  };

  const pickEffort = (value: string) => {
    onChange({ effort: value });
    dismiss(true);
  };

  const pickTier = (value: string) => {
    onChange({ serviceTier: value });
    dismiss(true);
  };

  const pickModel = (row: ModelRow | undefined) => {
    if (!row) return;
    onChange({ model: modelRowValue(row) });
    dismiss(true);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      if (submenu === 'effort') setActiveEffort(index => Math.min(efforts.length - 1, Math.max(0, index + step)));
      else if (submenu === 'tier') setActiveTier(index => Math.min(tiers.length - 1, Math.max(0, index + step)));
      else if (submenu === 'model') setActiveModel(index => Math.min(rows.length - 1, Math.max(0, index + step)));
      else moveEntry(step);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const entry = entries[active];
      if (entry) showEntry(entry);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSubmenu(null);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (submenu === 'effort') {
      const row = efforts[activeEffort];
      if (row) pickEffort(row.value);
      return;
    }
    if (submenu === 'tier') {
      const row = tiers[activeTier];
      if (row) pickTier(row.value);
      return;
    }
    if (submenu === 'model') {
      pickModel(rows[activeModel]);
      return;
    }
    const entry = entries[active];
    if (entry) showEntry(entry);
  };

  const showSubmenu = open && submenu !== null && activeRow !== null && activeRow.dataset.modelControlIndex === String(active);

  return (
    <div data-model-picker className="relative min-w-0">
      <button
        ref={button}
        type="button"
        data-model-picker-trigger
        title={[ENGINE_NAMES[agent.engine], name, effortShown].filter(Boolean).join(' · ')}
        aria-label={`${ENGINE_NAMES[agent.engine]} ${name}${effortShown ? `, ${effortRowLabel(agent.engine).toLowerCase()} ${effortShown}` : ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onMouseDown={event => event.preventDefault()}
        onClick={() => (open ? dismiss(true) : setOpen(true))}
        className={`flex h-6.5 min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 transition-colors duration-150 ${open ? 'bg-selection text-content' : 'bg-selection text-content hover:bg-selection-hover'}`}
      >
        <EngineIcon engine={agent.engine} className="size-4 shrink-0" />
        <span className="min-w-0 truncate whitespace-nowrap text-[11px]">{name}</span>
        {effortShown ? <span className="shrink-0 text-[11px] text-content/50">{effortShown}</span> : null}
        {tierShown ? <span className="shrink-0 text-[11px] text-content/50">{tierShown}</span> : null}
        <ChevronDown className={`size-3 shrink-0 text-content/50 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} strokeWidth={1.75} />
      </button>

      {open ? (
        <>
          <Popover
            ref={menu}
            anchor={button}
            side="top"
            width={MENU_WIDTH}
            autoFocus
            ignore={SELF}
            onDismiss={reason => dismiss(reason === 'escape')}
            role="menu"
            aria-label="Model and settings"
            tabIndex={-1}
            onKeyDown={onMenuKey}
            data-model-picker
            className="p-1 font-sans"
          >
            {entries.map((entry, index) => {
              const highlighted = index === active;
              const shared = {
                ref: highlighted ? setActiveRow : undefined,
                'data-model-control-index': index,
                type: 'button' as const,
                role: 'menuitem',
                'aria-haspopup': 'menu' as const,
                'aria-expanded': highlighted && showSubmenu,
                onMouseDown: (event: ReactMouseEvent) => event.preventDefault(),
                onMouseEnter: () => { setActive(index); showEntry(entry); },
                onClick: () => showEntry(entry),
                className: rowClass(highlighted),
              };
              if (entry === 'effort') {
                return (
                  <button key="effort" {...shared}>
                    <span className="min-w-0 flex-1">{effortRowLabel(agent.engine)}</span>
                    <span className="min-w-0 max-w-28 truncate text-content/55">{effort ? effortLabel(effort, null) : 'Default'}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
                  </button>
                );
              }
              if (entry === 'tier') {
                return (
                  <button key="tier" {...shared}>
                    <span className="min-w-0 flex-1">Service Tier</span>
                    <span className="min-w-0 max-w-28 truncate text-content/55">{tierName({ model: agentModel, serviceTier: agentTier }, models)}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
                  </button>
                );
              }
              return (
                <button key="model" {...shared} title={switching}>
                  <span className="min-w-0 flex-1">Model</span>
                  <span className="flex min-w-0 max-w-36 items-center gap-1 text-content/55">
                    <EngineIcon engine={agent.engine} className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{name}</span>
                  </span>
                  <ChevronRight className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
                </button>
              );
            })}
          </Popover>

          {showSubmenu && submenu === 'effort' ? (
            <Popover
              anchor={activeRow}
              side="right"
              gap={SUBMENU_OVERLAP}
              width={SETTING_MENU_WIDTH}
              layer={LAYER.submenu}
              role="menu"
              aria-label={effortRowLabel(agent.engine)}
              data-model-picker
              className="p-1 font-sans"
            >
              {efforts.map((row, index) => {
                const selected = row.value === agentEffort;
                const tone = effortTone(row.value);
                return (
                  <button
                    key={row.value || 'default'}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    onMouseDown={event => event.preventDefault()}
                    onMouseEnter={() => setActiveEffort(index)}
                    onClick={() => pickEffort(row.value)}
                    className={`${rowClass(index === activeEffort, 'h-8')} ${tone ? 'codex-effort-option' : ''}`}
                    data-effort-tone={tone}
                  >
                    {tone ? <EffortTileShimmer /> : null}
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {row.hint ? <span className="shrink-0 text-[12px] text-content/45">{row.hint}</span> : null}
                    {selected ? <Check className="size-3.5 shrink-0 text-content/50" strokeWidth={2} /> : null}
                  </button>
                );
              })}
            </Popover>
          ) : null}

          {showSubmenu && submenu === 'tier' ? (
            <Popover
              anchor={activeRow}
              side="right"
              gap={SUBMENU_OVERLAP}
              width={SETTING_MENU_WIDTH}
              layer={LAYER.submenu}
              role="menu"
              aria-label="Service Tier"
              data-model-picker
              className="p-1 font-sans"
            >
              {tiers.map((row, index) => {
                const selected = row.value === agentTier;
                return (
                  <button
                    key={row.value || 'standard'}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    title={row.hint}
                    onMouseDown={event => event.preventDefault()}
                    onMouseEnter={() => setActiveTier(index)}
                    onClick={() => pickTier(row.value)}
                    className={rowClass(index === activeTier, 'h-8')}
                  >
                    <span className="min-w-0 flex-1 truncate">{row.label}</span>
                    {selected ? <Check className="size-3.5 shrink-0 text-content/50" strokeWidth={2} /> : null}
                  </button>
                );
              })}
            </Popover>
          ) : null}

          {showSubmenu && submenu === 'model' ? (
            <ModelFlyout
              anchor={activeRow}
              agent={agent}
              models={models}
              rows={rows}
              active={activeModel}
              query={query}
              searchRef={search}
              onQuery={setQuery}
              onActive={setActiveModel}
              onPick={pickModel}
              groups={groups.length > 1 ? groups : []}
              group={group}
              onGroup={(next) => { setGroup(next); setQuery(''); setActiveModel(0); }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * MonoCode's ModelFlyout: a provider rail (when the engine has several providers) beside a search
 * over the models. A search covers every provider and names each result's provider.
 */
function ModelFlyout({ anchor, agent, models, rows, active, query, searchRef, onQuery, onActive, onPick, groups, group, onGroup }: {
  anchor: HTMLButtonElement;
  agent: Agent;
  models: EngineModels | undefined;
  rows: ModelRow[];
  active: number;
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery: (query: string) => void;
  onActive: (index: number) => void;
  onPick: (row: ModelRow | undefined) => void;
  groups: ModelGroup[];
  group: string | null;
  onGroup: (group: string) => void;
}) {
  const rail = groups.length > 1;
  const searching = Boolean(query.trim());
  const setupHint = notSetUp(models);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  // The popover starts hidden until it has measured its anchor, and a hidden element drops focus().
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [searchRef]);
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      onActive(Math.min(rows.length - 1, Math.max(0, active + (event.key === 'ArrowDown' ? 1 : -1))));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      onPick(rows[active]);
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation();
  };
  return (
    <Popover
      anchor={anchor}
      side="right"
      gap={SUBMENU_OVERLAP}
      width={MODEL_MENU_WIDTH + (rail ? RAIL_WIDTH : 0)}
      maxHeight={rail ? MODEL_MENU_HEIGHT + 80 : MODEL_MENU_HEIGHT}
      layer={LAYER.submenu}
      role="dialog"
      aria-label="Models"
      data-model-picker
      className="flex min-h-0 flex-row overflow-hidden font-sans"
    >
      {rail ? (
        <div role="tablist" aria-label="Providers" aria-orientation="vertical" className="flex shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-stroke py-1.5" style={{ width: RAIL_WIDTH }}>
          {groups.map(g => {
            const selected = !searching && g.id === group;
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={g.label}
                title={g.label}
                onMouseDown={event => event.preventDefault()}
                onClick={() => onGroup(g.id)}
                className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors duration-100 ${selected ? 'bg-selection text-content' : 'text-content/70 hover:bg-content/5 hover:text-content'}`}
              >
                <ProviderIcon provider={g.id} label={g.label} className="size-4" />
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <label className="flex shrink-0 items-center gap-2 border-b border-stroke px-3 py-2.5 text-content/50">
        <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input
          ref={searchRef}
          type="text"
          value={query}
          placeholder="Search or type a model id"
          aria-label="Search models"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-content outline-none placeholder:text-content/40"
          onChange={event => onQuery(event.target.value)}
          onKeyDown={onSearchKey}
        />
      </label>
      <div ref={lockOverscroll} role="listbox" aria-label="Models" className="min-h-0 flex-1 overflow-y-auto overscroll-none p-1">
        {rows.map((row, index) => {
          const value = modelRowValue(row);
          const selected = row.kind !== 'custom' && value === agent.model;
          const highlighted = index === active;
          const label = row.kind === 'default' ? row.label : row.kind === 'model' ? row.model.label : `Use “${row.value}”`;
          const hint = row.kind === 'default' ? row.hint : row.kind === 'model' ? row.model.description : 'Custom model id';
          return (
            <div
              key={`${row.kind}:${value}`}
              className={`flex h-8 items-center rounded-lg px-1 ${highlighted ? 'bg-selection text-content' : 'text-content hover:bg-content/5'}`}
              onMouseEnter={() => onActive(index)}
            >
              <button
                ref={highlighted ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={selected}
                title={hint || undefined}
                onMouseDown={event => event.preventDefault()}
                onClick={() => onPick(row)}
                className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-left text-[13px]"
              >
                <span className={`min-w-0 flex-1 truncate ${row.kind === 'custom' ? 'text-content/75' : ''}`}>{label}</span>
                {rail && searching && row.kind === 'model' && row.model.group ? <span className="max-w-24 shrink-0 truncate text-[11px] text-content/40">{row.model.group}</span> : hint ? <span className="max-w-28 shrink-0 truncate text-[11px] text-content/40">{hint}</span> : null}
              </button>
              <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center">
                {selected ? <Check className="size-3.5 text-content/55" strokeWidth={2} /> : null}
              </span>
            </div>
          );
        })}
        {!models?.discovered ? <p className="px-2 py-2 text-[12px] text-content/50">Asking the CLI for its models…</p> : null}
        {setupHint ? <p className="px-2 py-2 text-[11px] leading-4 text-content/45">{setupHint}</p> : null}
      </div>
      </div>
    </Popover>
  );
}
