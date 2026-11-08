import { useState } from 'react';
import { ENGINE_LABELS, ENGINES, type Settings } from '../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, useApp } from '../store.ts';
import { setTheme, useTheme, type ThemePreference } from '../theme.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { INPUT } from '../ui/common.tsx';
import { RefreshCw } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Segmented, Toggle } from '../mono/settings.tsx';

function save(change: Partial<Settings>) {
  return attempt(() => api.updateSettings(change));
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useApp(s => s.snapshot?.settings);
  const engines = useApp(s => s.snapshot?.engines);
  const models = useApp(s => s.snapshot?.models);
  const theme = useTheme();
  const [limit, setLimit] = useState(String(settings?.messageLimit ?? 12));
  const [refreshing, setRefreshing] = useState(false);
  if (!settings) return null;
  return (
    <Modal title="Settings" size="md" fitViewport onClose={onClose}>
      <div className="px-4 pb-4 pt-4">
        <Group title="Appearance">
          <Row label="Theme">
            <Segmented<ThemePreference> label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} />
          </Row>
        </Group>

        <Group title="Agent communication" description="How agents see and message each other.">
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
        </Group>

        <Group
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
        </Group>
      </div>
    </Modal>
  );
}
