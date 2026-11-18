import { StorageSettings } from './StorageSettings.tsx';
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ENGINES, type EngineKind, type Settings } from '../../shared/types.ts';
import { buildLabel, channelLabel } from '../../shared/buildInfo.ts';
import { releaseNotesUrl } from '../../shared/updates.ts';
import { ASK_FIRST_KEYS, createCapText, type AskFirst, type SuperAutonomy } from '../../shared/autonomy.ts';
import { api } from '../api.ts';
import { BUILD } from '../buildInfo.ts';
import { IS_MAC } from '../platform.ts';
import { attempt, useApp } from '../store.ts';
import { setTheme, useTheme, type ThemePreference } from '../theme.ts';
import { setAvatarStyle, useAvatarStyle, type AvatarStyle } from '../avatarStyle.ts';
import { useDesktopUpdate } from '../sidebar/SidebarUpdate.tsx';
import { INPUT } from '../ui/common.tsx';
import { ExternalLink, RefreshCw, Search, X } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, RevealedSetting, Row, Segmented, Toggle } from '../mono/settings.tsx';
import { InstallCommandRow, UpdatesRow } from '../dialogs/AboutGroup.tsx';
import { AlwaysSafe, LevelActions, SoulSuggestion } from '../dialogs/AutonomySettings.tsx';
import { APP_SECTIONS, type AppSettingsSection } from '../settingsSections.ts';
import { setSettingsSection } from '../layout.ts';
import { searchSettings, sectionRows, type SettingEntry, type SettingsSearchResult } from '../settingsIndex.ts';

function save(change: Partial<Settings>) {
  return attempt(() => api.updateSettings(change));
}

/** MonoCode's PageHeader (SettingsView.tsx): the section's title and its line. */
function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="pb-4">
      <h1 className="text-[20px] font-semibold leading-tight text-content">{title}</h1>
      {description ? <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-content/45">{description}</p> : null}
    </header>
  );
}

/**
 * MonoCode's SettingsSearch, at the end of the header bar: a field whose results list under it;
 * picking one opens its section and reveals the row. Esc in the list clears the field.
 */
function SettingsSearch({ onReveal }: { onReveal: (result: SettingsSearchResult) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = useMemo(() => searchSettings(query), [query]);
  const open = query.trim().length > 0;
  useEffect(() => setActive(0), [query]);
  const go = (result: SettingsSearchResult | undefined) => {
    if (!result) return;
    onReveal(result);
    setQuery('');
    input.current?.blur();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(i => Math.min(results.length - 1, i + 1)); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActive(i => Math.max(0, i - 1)); return; }
    if (event.key === 'Enter') { event.preventDefault(); go(results[active]); }
  };
  return (
    <div ref={root} className="relative shrink-0">
      <label className="flex h-7 w-48 items-center gap-2 rounded-md border border-content/10 px-2 text-content/45 focus-within:border-content/20">
        <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
        <input
          ref={input}
          role="combobox"
          data-settings-search
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search settings"
          aria-label="Search settings"
          aria-expanded={open}
          aria-controls={listId}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear settings search"
            onMouseDown={event => event.preventDefault()}
            onClick={() => { setQuery(''); input.current?.focus(); }}
            className="grid size-4 shrink-0 place-items-center rounded text-content/45 hover:text-content"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        ) : null}
      </label>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          width={300}
          maxHeight={320}
          onDismiss={reason => { setQuery(''); if (reason === 'escape') input.current?.focus(); }}
          id={listId}
          role="listbox"
          aria-label="Settings search results"
          className="overflow-y-auto overscroll-contain p-1"
        >
          {results.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-content/45">No matching settings</p>
          ) : (
            results.map((result, index) => (
              <button
                key={`${result.section}:${result.settingId ?? '*'}`}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(result)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] ${index === active ? 'bg-selection text-content' : 'text-content hover:bg-content/5'}`}
              >
                <span className="min-w-0 flex-1 truncate">{result.label}</span>
                <span className="shrink-0 text-[11px] text-content/40">{result.settingId ? result.sectionLabel : 'Page'}</span>
              </button>
            ))
          )}
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * Settings as a full-window page (ACH-D71, ACH-D77), in MonoCode's settings UI (SettingsView.tsx,
 * ACH-D83): a 40px header bar with the breadcrumb and Search settings, then a max-w-5xl body with
 * the PageHeader and the section's Groups of Rows. The rows and their words come from
 * web/settingsIndex.ts; this page adds the controls. A search result opens its section and flashes
 * its row (RevealedSetting). No shortcut hints (ACH-D81).
 */
export function SettingsPage({ section }: { section: AppSettingsSection }) {
  const settings = useApp(s => s.snapshot?.settings);
  const engines = useApp(s => s.snapshot?.engines);
  const models = useApp(s => s.snapshot?.models);
  const update = useDesktopUpdate();
  const theme = useTheme();
  const avatars = useAvatarStyle();
  const [limit, setLimit] = useState(String(settings?.messageLimit ?? 12));
  const [wakes, setWakes] = useState(String(settings?.superMaxWakesPerHour ?? 6));
  const [budget, setBudget] = useState(String(settings?.superDailyBudgetUsd ?? 10));
  const [creates, setCreates] = useState(String(settings?.superMaxCreatesPerDay ?? 25));
  const [refreshing, setRefreshing] = useState(false);
  // Rows that open a longer text under themselves (Autonomy's lists and the soul.md line).
  const [shown, setShown] = useState<Record<string, boolean>>({});
  // MonoCode's reveal: scroll the row a search picked to the middle, flash it, then let go.
  // The section is a dependency so a result on another page scrolls once that page has the row.
  const [revealed, setRevealed] = useState<string | null>(null);
  useEffect(() => {
    if (!revealed) return;
    document.getElementById(revealed)?.scrollIntoView?.({ block: 'center' });
    const timer = window.setTimeout(() => setRevealed(null), 1800);
    return () => window.clearTimeout(timer);
  }, [revealed, section]);
  const onReveal = (result: SettingsSearchResult) => {
    if (result.section !== section) setSettingsSection(result.section);
    setRevealed(result.settingId);
  };
  if (!settings) return null;
  const level = settings.superAutonomy;
  const version = update?.currentVersion || BUILD.version;
  const toggleShown = (id: string) => setShown(s => ({ ...s, [id]: !s[id] }));
  const showButton = (id: string) => <SecondaryButton aria-expanded={Boolean(shown[id])} onClick={() => toggleShown(id)}>{shown[id] ? 'Hide' : 'Show'}</SecondaryButton>;
  // INPUT is full width; a wrapper gives the field the reference's narrow size.
  const number = (value: string, set: (v: string) => void, commit: (v: number) => void, opts: { min?: number; max?: number; step?: number; disabled?: boolean; title?: string; valid: (v: number) => boolean }) => (
    <div className="w-20"><input
      type="number"
      min={opts.min}
      max={opts.max}
      step={opts.step}
      disabled={opts.disabled}
      title={opts.title}
      value={value}
      onChange={e => set(e.target.value)}
      onBlur={() => { const v = Number(value); if (opts.valid(v)) commit(v); }}
      className={`${INPUT} ${opts.disabled ? 'text-content/35' : ''}`}
    /></div>
  );
  const engineRow = (kind: EngineKind) => (engines?.[kind].available ? `v${engines[kind].version} at ${engines[kind].path}` : 'Not found on PATH');

  const askFirst = Object.fromEntries(ASK_FIRST_KEYS.map(key => [`ask-${key}`, (
    <Toggle label={`Ask first: ${key}`} on={settings.superAskFirst[key]} onChange={on => void save({ superAskFirst: { ...settings.superAskFirst, [key]: on } as AskFirst })} />
  )]));
  const controls: Record<string, ReactNode> = {
    theme: <Segmented<ThemePreference> label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />,
    avatars: <Segmented<AvatarStyle> label="Avatars" value={avatars} onChange={setAvatarStyle} options={[{ value: 'colour', label: 'Colour' }, { value: 'ink', label: 'Ink' }]} />,
    awareness: <Segmented<Settings['awareness']> label="Who can agents message?" value={settings.awareness} onChange={awareness => void save({ awareness })} options={[{ value: 'off', label: 'Nobody' }, { value: 'project', label: 'Same project' }, { value: 'all', label: 'All projects' }]} />,
    'message-budget': number(limit, setLimit, messageLimit => void save({ messageLimit }), { min: 0, valid: v => Number.isInteger(v) && v >= 0 && v !== settings.messageLimit }),
    'share-activity': <Toggle label="Share current tasks" on={settings.shareActivity} onChange={shareActivity => void save({ shareActivity })} />,
    'team-snapshot': <Toggle label="Start with a team snapshot" on={settings.autoTeamContext} onChange={autoTeamContext => void save({ autoTeamContext })} />,
    'browser-eval': <Toggle label="Browser scripts" on={settings.browserEval} onChange={browserEval => void save({ browserEval })} />,
    ...Object.fromEntries(ENGINES.map(kind => [`engine-${kind}`, <span className="text-[12px] text-content/45">{models?.[kind].discovered ? `${models[kind].models.length} models` : ''}</span>])),
    'refresh-models': (
      <SecondaryButton disabled={refreshing} onClick={async () => { setRefreshing(true); await attempt(() => api.refreshModels()); setRefreshing(false); }}>
        <RefreshCw className="size-3.5" strokeWidth={1.75} /> {refreshing ? 'Asking the CLIs…' : 'Refresh'}
      </SecondaryButton>
    ),
    autonomy: <Segmented<SuperAutonomy> label="Autonomy" value={level} onChange={superAutonomy => void save({ superAutonomy })} options={[{ value: 'ask', label: 'Ask' }, { value: 'standard', label: 'Standard' }, { value: 'full', label: 'Full' }]} />,
    'autonomy-actions': showButton('autonomy-actions'),
    ...askFirst,
    'always-safe': showButton('always-safe'),
    pause: <SecondaryButton onClick={() => void save({ superPaused: !settings.superPaused })}>{settings.superPaused ? 'Resume' : 'Pause'}</SecondaryButton>,
    'soul-line': showButton('soul-line'),
    'super-wake': <Toggle label="Wake the SuperAgent" on={settings.superWake} onChange={superWake => void save({ superWake })} />,
    'wakes-per-hour': number(wakes, setWakes, superMaxWakesPerHour => void save({ superMaxWakesPerHour }), { min: 0, max: 60, valid: v => Number.isInteger(v) && v >= 0 && v !== settings.superMaxWakesPerHour }),
    'super-notify': <Toggle label="SuperAgent notifications" on={settings.superNotify} onChange={superNotify => void save({ superNotify })} />,
    'daily-budget': number(budget, setBudget, superDailyBudgetUsd => void save({ superDailyBudgetUsd }), { min: 0, step: 1, valid: v => Number.isFinite(v) && v >= 0 && v !== settings.superDailyBudgetUsd }),
    'creates-per-day': number(creates, setCreates, superMaxCreatesPerDay => void save({ superMaxCreatesPerDay }), { min: 0, max: 200, disabled: level === 'full', title: level === 'full' ? 'Not used on Full' : undefined, valid: v => Number.isInteger(v) && v >= 0 && v <= 200 && v !== settings.superMaxCreatesPerDay }),
    'quiet-hours': (
      <>
        <div className="w-24"><input type="time" aria-label="Quiet from" value={settings.superQuietFrom} onChange={e => void save({ superQuietFrom: e.target.value })} className={INPUT} /></div>
        <span className="text-[12px] text-content/45">to</span>
        <div className="w-24"><input type="time" aria-label="Quiet to" value={settings.superQuietTo} onChange={e => void save({ superQuietTo: e.target.value })} className={INPUT} /></div>
      </>
    ),
    version: <span className="text-[12px] text-content/45">{channelLabel(version)}</span>,
    'release-notes': (
      <SecondaryButton onClick={() => window.open(releaseNotesUrl(version), '_blank')}>
        <ExternalLink className="size-3.5" strokeWidth={1.75} /> Open
      </SecondaryButton>
    ),
  };
  // Live words in place of the index's, where the row reports a state.
  const descriptions: Record<string, string> = {
    ...Object.fromEntries(ENGINES.map(kind => [`engine-${kind}`, engineRow(kind)])),
    pause: settings.superPaused ? 'Paused: it starts nothing on its own until you resume' : 'It starts nothing on its own until you resume',
    'creates-per-day': createCapText(level),
    version: buildLabel(BUILD),
    'release-notes': `What changed in ${version}`,
  };
  const titles: Record<string, string> = { pause: settings.superPaused ? 'Paused' : 'Pause the SuperAgent', version: `PodCode ${version}`.trim() };
  const panels: Record<string, ReactNode> = { 'autonomy-actions': <LevelActions level={level} />, 'always-safe': <AlwaysSafe />, 'soul-line': <SoulSuggestion /> };
  // Rows this machine has nothing for: the install command is only for an unsigned Mac build, the
  // release notes only with a version.
  const present = (e: SettingEntry) => {
    if (e.id === 'install-command') return Boolean(update && IS_MAC && !update.canInstall);
    if (e.id === 'release-notes') return Boolean(version);
    return true;
  };

  const row = (e: SettingEntry) => {
    if (e.id === 'install-command') return <InstallCommandRow key={e.id} />;
    if (e.id === 'updates' && update) return <UpdatesRow key={e.id} snapshot={update} />;
    return (
      <Fragment key={e.id}>
        <Row id={e.id} label={titles[e.id] ?? e.title} description={descriptions[e.id] ?? e.description}>{controls[e.id]}</Row>
        {shown[e.id] ? panels[e.id] : null}
      </Fragment>
    );
  };

  const groups = (section === 'storage' ? [] : sectionRows(section)).map(g => ({ heading: g.group, rows: g.rows.filter(present) })).filter(g => g.rows.length);
  const info = APP_SECTIONS.find(s => s.id === section);
  return (
    <div role="region" aria-label="Settings" className="flex min-h-0 min-w-0 flex-1 flex-col text-content">
      {/* MonoCode's header bar: the breadcrumb, then Search settings at its end. It drags the window. */}
      <div data-window-drag className="flex h-10 shrink-0 select-none items-center border-b border-stroke">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <span className="shrink-0 text-content/45">Settings</span>
          <span aria-hidden className="shrink-0 text-content/25">/</span>
          <span className="min-w-0 truncate text-content">{info?.label ?? 'Settings'}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pr-2">
          <SettingsSearch onReveal={onReveal} />
        </div>
      </div>
      <RevealedSetting.Provider value={revealed}>
        <div className="@container/settings min-h-0 flex-1 overflow-y-auto overscroll-none">
          <div className="mx-auto w-full max-w-5xl px-5 py-6 pb-16 @min-[560px]/settings:px-8 @min-[560px]/settings:py-8">
            <PageHeader title={info?.label ?? 'Settings'} description={info?.description ?? ''} />
            <div>
              {section === 'storage' ? <StorageSettings /> : null}
              {groups.map(g => <Group key={g.heading} title={g.heading}>{g.rows.map(row)}</Group>)}
            </div>
          </div>
        </div>
      </RevealedSetting.Provider>
    </div>
  );
}
