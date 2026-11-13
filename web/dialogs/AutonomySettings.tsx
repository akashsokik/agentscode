/**
 * Settings, SuperAgent, Autonomy (ALL-D9): how much it does without asking, the four things that
 * cannot be undone (ask me first), what holds at every level, Pause, and the soul.md line the user
 * may change by hand (only they edit it), with a copy button.
 */
import { useState } from 'react';
import { ALWAYS_SAFE, ASK_FIRST_KEYS, FULL_ACTIONS, SOUL_LINE_FROM, SOUL_LINE_TO, type AskFirst, type SuperAutonomy } from '../../shared/autonomy.ts';
import type { Settings } from '../../shared/types.ts';
import { Check, Copy } from '../mono/icons.tsx';
import { Row, Segmented, Toggle } from '../mono/settings.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';

const ASK_FIRST_ROWS: Record<keyof AskFirst, { label: string; description: string }> = {
  deleteData: { label: 'Delete files or data', description: 'Unmerged branches, folders with uncommitted work, an agent\'s files, a backup.' },
  outsideAccounts: { label: 'Change outside accounts', description: 'Railway, Vercel, GitHub settings, anything with billing or other people.' },
  removeUserAgents: { label: 'Remove agents you made', description: 'Agents it created itself it may remove; yours stay yours.' },
  forcePush: { label: 'Force-push a new branch', description: 'Only a branch never pushed. Main and pushed branches are never force-pushed, at any level.' },
};

const LEVEL_TEXT: Record<SuperAutonomy, string> = {
  ask: 'It asks you before every merge, restart, push, release, deploy and cleanup.',
  standard: 'Your standing approvals (ALL-D1): it merges reviewed branches locally, restarts and deletes merged branches; it asks before the rest.',
  full: 'It does these without asking, each in Decisions with why and how to undo it:',
};

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
      {items.map(item => (
        <li key={item} className="flex items-start gap-1.5 text-[12px] leading-snug text-content/70">
          <Check aria-hidden className="mt-px size-3 shrink-0 text-success" strokeWidth={2} />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function AutonomySettings({ settings, save }: { settings: Settings; save: (change: Partial<Settings>) => unknown }) {
  const [copied, setCopied] = useState(false);
  const level = settings.superAutonomy;
  const copy = () => {
    void navigator.clipboard?.writeText(SOUL_LINE_TO).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <>
      <Row id="super-autonomy" label="Autonomy" description="How much it does without asking you. Everything it does is in Decisions, with Undo wherever the step can be undone.">
        <Segmented<SuperAutonomy> label="Autonomy" value={level} onChange={superAutonomy => void save({ superAutonomy })} options={[{ value: 'ask', label: 'Ask' }, { value: 'standard', label: 'Standard' }, { value: 'full', label: 'Full' }]} />
      </Row>
      <div className="border-b border-content/5 px-4 pb-3.5 font-sans">
        <p className="text-[12px] leading-relaxed text-content/55">{LEVEL_TEXT[level]}</p>
        {level === 'full' ? <Bullets items={[...FULL_ACTIONS.map(a => a.label), 'Create, stop and restart agents']} /> : null}
      </div>
      <p className="px-4 pb-1 pt-3.5 font-sans text-[11px] font-medium text-content/50">Can't be undone: ask me first</p>
      {ASK_FIRST_KEYS.map(key => (
        <Row key={key} label={ASK_FIRST_ROWS[key].label} description={ASK_FIRST_ROWS[key].description}>
          <Toggle label={`Ask first: ${ASK_FIRST_ROWS[key].label}`} on={settings.superAskFirst[key]} onChange={on => void save({ superAskFirst: { ...settings.superAskFirst, [key]: on } })} />
        </Row>
      ))}
      <div className="border-b border-content/5 px-4 py-3.5 font-sans">
        <p className="text-[11px] font-medium text-content/50">Always, at every level</p>
        <Bullets items={ALWAYS_SAFE} />
      </div>
      <Row id="super-pause" label={settings.superPaused ? 'Paused' : 'Pause the SuperAgent'} description={settings.superPaused ? 'It starts nothing on its own until you resume. Your messages still reach it.' : 'It starts nothing on its own until you resume. Your messages, and the work you asked for, still go.'}>
        <SecondaryButton onClick={() => void save({ superPaused: !settings.superPaused })}>{settings.superPaused ? 'Resume' : 'Pause'}</SecondaryButton>
      </Row>
      <div className="border-b border-content/5 px-4 py-3.5 font-sans" data-soul-suggestion>
        <p className="text-[11px] font-medium text-content/50">Its standing instructions (soul.md, only you edit them)</p>
        <p className="mt-1 text-[12px] leading-relaxed text-content/60">To match Full, change the end of its first line from <span className="text-content/80">"{SOUL_LINE_FROM}"</span> to:</p>
        <div className="mt-1.5 flex items-start gap-2 rounded-md border border-content/10 px-2.5 py-2">
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-content/85">{SOUL_LINE_TO}</p>
          <button type="button" onClick={copy} aria-label="Copy the suggested line" title="Copy the suggested line" className="grid size-6 shrink-0 place-items-center rounded text-content/50 transition-colors hover:bg-content/7 hover:text-content">
            {copied ? <Check className="size-3.5 text-success" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
          </button>
        </div>
      </div>
    </>
  );
}
