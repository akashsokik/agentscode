import { useState } from 'react';
import { ENGINE_LABELS, ENGINES, type Settings } from '../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, useApp } from '../store.ts';
import { setTheme, useTheme, type ThemePreference } from '../theme.ts';
import { setAvatarStyle, useAvatarStyle, type AvatarStyle } from '../avatarStyle.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { INPUT } from '../ui/common.tsx';
import { RefreshCw } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Segmented, Toggle } from '../mono/settings.tsx';
import { AboutGroup } from '../dialogs/AboutGroup.tsx';
import { AutonomySettings } from '../dialogs/AutonomySettings.tsx';
import { APP_SECTIONS, type AppSettingsSection } from '../settingsSections.ts';
import { createCapText } from '../../shared/autonomy.ts';

function save(change: Partial<Settings>) {
  return attempt(() => api.updateSettings(change));
}

/**
 * Settings as a full-window page (ACH-D71, ACH-D77): the groups the Settings modal used to stack, one
 * section at a time. The navigation column lists the sections (Sidebar.tsx NavRail) and App lays the
 * page over the hidden tabs and panels. MonoCode's SettingsView: a breadcrumb header, then the page.
 */
export function SettingsPage({ section }: { section: AppSettingsSection }) {
  const settings = useApp(s => s.snapshot?.settings);
  const engines = useApp(s => s.snapshot?.engines);
  const models = useApp(s => s.snapshot?.models);
  const theme = useTheme();
  const avatars = useAvatarStyle();
  const [limit, setLimit] = useState(String(settings?.messageLimit ?? 12));
  const [wakes, setWakes] = useState(String(settings?.superMaxWakesPerHour ?? 6));
  const [budget, setBudget] = useState(String(settings?.superDailyBudgetUsd ?? 10));
  const [creates, setCreates] = useState(String(settings?.superMaxCreatesPerDay ?? 25));
  const [refreshing, setRefreshing] = useState(false);
  if (!settings) return null;
  const label = APP_SECTIONS.find(s => s.id === section)?.label ?? 'Settings';
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col font-sans">
      <header data-window-drag className="flex h-10 shrink-0 items-center gap-1.5 border-b border-stroke px-4 text-[13px]">
        <span className="text-content/45">Settings</span>
        <span aria-hidden className="text-content/30">/</span>
        <h1 className="min-w-0 truncate font-medium text-content">{label}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-none">
      <div className="mx-auto w-full max-w-[720px] px-8 py-8">
        {section === 'appearance' ? <Group title="Appearance">
          <Row label="Theme">
            <Segmented<ThemePreference> label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
          </Row>
          <Row label="Avatars" description="Colour gives every agent its own colour. Ink draws them all, the SuperAgent included, in the theme's text colour.">
            <Segmented<AvatarStyle> label="Avatars" value={avatars} onChange={setAvatarStyle} options={[{ value: 'colour', label: 'Colour' }, { value: 'ink', label: 'Ink' }]} />
          </Row>
        </Group> : null}

        {section === 'comms' ? <Group title="Agent communication" description="How agents see and message each other.">
          <Row label="Who can agents message?" description="Replies to messages they received always go through, and channel members can always reach each other in their channel.">
            <Segmented<Settings['awareness']>
              label="Who can agents message?"
              value={settings.awareness}
              onChange={awareness => void save({ awareness })}
              options={[{ value: 'off', label: 'Nobody' }, { value: 'project', label: 'Same project' }, { value: 'all', label: 'All projects' }]}
            />
          </Row>
          <Row label="Message budget" description="Messages per collaboration, replies and hand-offs included. 0 means unlimited.">
            <input
              type="number"
              min={0}
              value={limit}
              onChange={e => setLimit(e.target.value)}
              onBlur={() => { const value = Number(limit); if (Number.isInteger(value) && value >= 0 && value !== settings.messageLimit) void save({ messageLimit: value }); }}
              className={`${INPUT} w-20`}
            />
          </Row>
          <Row label="Share current tasks" description="list_agents includes each agent's task summary and activity.">
            <Toggle label="Share current tasks" on={settings.shareActivity} onChange={shareActivity => void save({ shareActivity })} />
          </Row>
          <Row label="Start tasks with a team snapshot" description="Agents see who is working on what before they begin.">
            <Toggle label="Start tasks with a team snapshot" on={settings.autoTeamContext} onChange={autoTeamContext => void save({ autoTeamContext })} />
          </Row>
          <Row label="Browser scripts" description="Let agents run their own JavaScript in their browser tabs (browser_eval). Plan-only agents never can.">
            <Toggle label="Browser scripts" on={settings.browserEval} onChange={browserEval => void save({ browserEval })} />
          </Row>
        </Group> : null}

        {section === 'super' ? <Group id="settings-super" title="SuperAgent" description="It runs your team across every project. It never edits code; agents do the work. The limits below stop only what it starts on its own: your own messages to it, and the work you asked it for, always go.">
          <AutonomySettings settings={settings} save={save} />
          <Row label="Wake it when agents finish, fail or get stuck" description="Updates are batched into one turn, and only sent while it is idle.">
            <Toggle label="Wake the SuperAgent" on={settings.superWake} onChange={superWake => void save({ superWake })} />
          </Row>
          <Row label="Wake-ups an hour" description="Past this, updates wait for the next hour.">
            <input
              type="number"
              min={0}
              max={60}
              value={wakes}
              onChange={e => setWakes(e.target.value)}
              onBlur={() => { const value = Number(wakes); if (Number.isInteger(value) && value >= 0 && value !== settings.superMaxWakesPerHour) void save({ superMaxWakesPerHour: value }); }}
              className={`${INPUT} w-20`}
            />
          </Row>
          <Row label="Daily budget" description="Dollars a day it may spend on wake-ups; then they wait for tomorrow. 0 means no cap. Your own messages always go.">
            <input
              type="number"
              min={0}
              step={1}
              value={budget}
              onChange={e => setBudget(e.target.value)}
              onBlur={() => { const value = Number(budget); if (Number.isFinite(value) && value >= 0 && value !== settings.superDailyBudgetUsd) void save({ superDailyBudgetUsd: value }); }}
              className={`${INPUT} w-20`}
            />
          </Row>
          <Row label="Agents it may create a day" description={createCapText(settings.superAutonomy)}>
            <input
              type="number"
              min={0}
              max={200}
              disabled={settings.superAutonomy === 'full'}
              title={settings.superAutonomy === 'full' ? 'Not used on Full' : undefined}
              value={creates}
              onChange={e => setCreates(e.target.value)}
              onBlur={() => { const value = Number(creates); if (Number.isInteger(value) && value >= 0 && value <= 200 && value !== settings.superMaxCreatesPerDay) void save({ superMaxCreatesPerDay: value }); }}
              className={`${INPUT} w-20 ${settings.superAutonomy === 'full' ? 'text-content/35' : ''}`}
            />
          </Row>
          <Row label="Quiet hours" description="No wake-ups and no notifications between these times. The same time twice turns them off.">
            <input type="time" aria-label="Quiet from" value={settings.superQuietFrom} onChange={e => void save({ superQuietFrom: e.target.value })} className={`${INPUT} w-24`} />
            <span className="text-[12px] text-content/45">to</span>
            <input type="time" aria-label="Quiet to" value={settings.superQuietTo} onChange={e => void save({ superQuietTo: e.target.value })} className={`${INPUT} w-24`} />
          </Row>
          <Row label="Notify me when it asks something" description="A desktop notification while you are in another app or window.">
            <Toggle label="SuperAgent notifications" on={settings.superNotify} onChange={superNotify => void save({ superNotify })} />
          </Row>
        </Group> : null}

        {section === 'engines' ? <Group
          title="Engines"
          action={
            <SecondaryButton disabled={refreshing} onClick={async () => { setRefreshing(true); await attempt(() => api.refreshModels()); setRefreshing(false); }}>
              <RefreshCw className="size-3.5" strokeWidth={1.75} /> {refreshing ? 'Asking the CLIs…' : 'Refresh models'}
            </SecondaryButton>
          }
        >
          {ENGINES.map(kind => (
            <Row
              key={kind}
              label={<span className="flex items-center gap-2"><EngineIcon engine={kind} className="size-4" />{ENGINE_LABELS[kind]}</span>}
              description={engines?.[kind].available ? `v${engines[kind].version} at ${engines[kind].path}` : 'Not found on PATH.'}
            >
              <span className="text-[12px] text-content/45">{models?.[kind].discovered ? `${models[kind].models.length} models` : ''}</span>
            </Row>
          ))}
        </Group> : null}

        {section === 'about' ? <AboutGroup /> : null}
      </div>
      </div>
    </div>
  );
}
