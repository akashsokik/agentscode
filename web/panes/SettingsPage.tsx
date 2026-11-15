import { Fragment, useState, type ReactNode } from 'react';
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
import { ExternalLink, RefreshCw } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Select, Toggle } from '../mono/settings.tsx';
import { InstallCommandRow, UpdatesRow } from '../dialogs/AboutGroup.tsx';
import { AlwaysSafe, LevelActions, SoulSuggestion } from '../dialogs/AutonomySettings.tsx';
import { APP_SECTIONS, type AppSettingsSection } from '../settingsSections.ts';
import { searchSettings, sectionRows, type SettingEntry } from '../settingsIndex.ts';

function save(change: Partial<Settings>) {
  return attempt(() => api.updateSettings(change));
}

/** A Select at the width the reference gives them, right-aligned in its row. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return <div className="w-40"><Select label={label} value={value} options={options} onChange={next => onChange(next as T)} /></div>;
}

/**
 * Settings as a full-window page (ACH-D71, ACH-D77, ACH-D82), after the user's reference: a centred
 * column with the section's title, then small headings over flat rounded cards of rows, each with a
 * title and one line on the left and its control on the right. The rows and their words come from
 * web/settingsIndex.ts; this page adds the controls. With a query from "Search settings" (the
 * navigation column, Sidebar.tsx), it shows the matching rows of every section instead, each still
 * working. No shortcut hints (ACH-D81).
 */
export function SettingsPage({ section, query = '' }: { section: AppSettingsSection; query?: string }) {
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
    theme: <Choice<ThemePreference> label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />,
    avatars: <Choice<AvatarStyle> label="Avatars" value={avatars} onChange={setAvatarStyle} options={[{ value: 'colour', label: 'Colour' }, { value: 'ink', label: 'Ink' }]} />,
    awareness: <Choice<Settings['awareness']> label="Agents can message" value={settings.awareness} onChange={awareness => void save({ awareness })} options={[{ value: 'off', label: 'Nobody' }, { value: 'project', label: 'Same project' }, { value: 'all', label: 'All projects' }]} />,
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
    autonomy: <Choice<SuperAutonomy> label="Autonomy" value={level} onChange={superAutonomy => void save({ superAutonomy })} options={[{ value: 'ask', label: 'Ask' }, { value: 'standard', label: 'Standard' }, { value: 'full', label: 'Full' }]} />,
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
    if (e.id === 'updates' && update) return <UpdatesRow key={e.id} snapshot={update} oneLine />;
    return (
      <Fragment key={e.id}>
        <Row id={e.id} oneLine label={titles[e.id] ?? e.title} description={descriptions[e.id] ?? e.description}>{controls[e.id]}</Row>
        {shown[e.id] ? panels[e.id] : null}
      </Fragment>
    );
  };

  const searching = query.trim().length > 0;
  const groups = searching
    ? searchSettings(query).map(hit => ({ heading: hit.label, rows: hit.rows.filter(present) }))
    : sectionRows(section).map(g => ({ heading: g.group, rows: g.rows.filter(present) }));
  const shownGroups = groups.filter(g => g.rows.length);
  const title = searching ? 'Search' : APP_SECTIONS.find(s => s.id === section)?.label ?? 'Settings';
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col font-sans">
      {/* The window's drag strip in the desktop app, level with the navigation column's header. */}
      <div data-window-drag className="h-10 shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
        <div className="mx-auto w-full max-w-[664px] px-8 pb-16 pt-2">
          <h1 className="pb-6 text-[20px] font-semibold tracking-[-0.01em] text-content">{title}</h1>
          <div>
            {shownGroups.map(g => <Group key={g.heading} title={g.heading}>{g.rows.map(row)}</Group>)}
          </div>
          {searching && !shownGroups.length ? <p className="text-[13px] text-content/45">Nothing matches "{query.trim()}".</p> : null}
        </div>
      </div>
    </div>
  );
}
