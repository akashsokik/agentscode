/**
 * Settings > Autonomy's longer texts (ALL-D9), shown under their rows on the Settings page
 * (web/panes/SettingsPage.tsx) when opened: what each level does without asking, what holds at every
 * level, and the soul.md line the user may change by hand (only they edit it), with a copy button.
 */
import { useState, type ReactNode } from 'react';
import { ALWAYS_SAFE, FULL_ACTIONS, SOUL_LINE_FROM, SOUL_LINE_TO, type SuperAutonomy } from '../../shared/autonomy.ts';
import { Check, Copy } from '../mono/icons.tsx';

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

/** The panel under a row it explains, inside the same card. */
function Panel({ children, ...props }: { children: ReactNode; 'data-soul-suggestion'?: boolean }) {
  return <div {...props} className="border-b border-content/5 px-4 pb-3.5 font-sans last:border-b-0">{children}</div>;
}

/** What the level does without asking (Full lists every step). */
export function LevelActions({ level }: { level: SuperAutonomy }) {
  return (
    <Panel>
      <p className="text-[12px] leading-relaxed text-content/55">{LEVEL_TEXT[level]}</p>
      {level === 'full' ? <Bullets items={[...FULL_ACTIONS.map(a => a.label), 'Create, stop and restart agents']} /> : null}
    </Panel>
  );
}

/** What holds at every level. */
export function AlwaysSafe() {
  return <Panel><Bullets items={ALWAYS_SAFE} /></Panel>;
}

/** The soul.md line to match Full, with a copy button. */
export function SoulSuggestion() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(SOUL_LINE_TO).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <Panel data-soul-suggestion>
      <p className="text-[12px] leading-relaxed text-content/60">To match Full, change the end of its first line from <span className="text-content/80">"{SOUL_LINE_FROM}"</span> to:</p>
      <div className="mt-1.5 flex items-start gap-2 rounded-md border border-content/10 px-2.5 py-2">
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-content/85">{SOUL_LINE_TO}</p>
        <button type="button" onClick={copy} aria-label="Copy the suggested line" title="Copy the suggested line" className="grid size-6 shrink-0 place-items-center rounded text-content/50 transition-colors hover:bg-content/7 hover:text-content">
          {copied ? <Check className="size-3.5 text-success" strokeWidth={2} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
        </button>
      </div>
    </Panel>
  );
}
