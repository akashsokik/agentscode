/**
 * MonoCode's usage footer (usage_footer.rs), for the agent in front: its engine's logo, a small bar
 * for the window closest to its limit and each window's use and countdown ("12% 3h 5m · 41% 4d 2h"),
 * and a refresh button. Like MonoCode it follows the session you are in, so a Claude agent shows
 * Claude's limits and a Codex agent Codex's, and a limit kept for one model ("Fable weekly limit")
 * shows only for an agent on that model. The chip opens a card per limit. The server reads usage
 * from the CLIs' own logins and keeps it a while (server/usage.ts); this polls that cached read,
 * and only Refresh reads again.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EngineKind, EngineUsage, UsageWindow } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { modelLabel } from '../format.ts';
import { focusedAgentId, useLayout } from '../layout.ts';
import { useApp } from '../store.ts';
import { chipLabel, limitName, percent, resetLabel, tightest, updatedLabel, usageTone, windowsFor } from '../usageFormat.ts';
import { RefreshCw } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { EngineIcon, ENGINE_NAMES } from './EngineIcon.tsx';
import { useNow } from './useNow.ts';

const ENGINES: EngineKind[] = ['claude', 'codex'];
/** The server keeps a read for 15 minutes; asking it this often only keeps the countdowns honest. */
const POLL_MS = 60_000;

interface Reading {
  usage?: EngineUsage;
  fetching: boolean;
}

/** Whose usage the footer shows: the engine, and the names its model goes by, to pick its own limits. */
interface Subject {
  engine: EngineKind;
  /** The model as the footer names it ("Fable 5.1"); unset when no agent is in view. */
  model?: string;
  names: string[];
}

const TONE: Record<ReturnType<typeof usageTone>, string> = {
  danger: 'bg-[#f87171]',
  warning: 'bg-[#fbbf24]',
  quiet: 'bg-content/45',
};

function Bar({ used, className }: { used: number; className: string }) {
  return (
    <span aria-hidden className={`block overflow-hidden rounded-full bg-content/10 ${className}`}>
      <span className={`block h-full rounded-full ${TONE[usageTone(used)]}`} style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
    </span>
  );
}

function WindowCard({ window: w, now }: { window: UsageWindow; now: number }) {
  return (
    <div className="rounded-lg border border-content/6 bg-content/[0.045] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium text-content/65">{limitName(w.minutes, w.model)}</span>
        <span className="shrink-0 font-medium text-content">{percent(w.usedPercent)} used</span>
      </div>
      <Bar used={w.usedPercent} className="mt-2 h-1.5 w-full" />
      <div className="mt-1.5 flex justify-between gap-3 text-[10px] leading-4 text-content/40">
        <span>{percent(100 - w.usedPercent)} remaining</span>
        <span className="truncate">{resetLabel(w, now)}</span>
      </div>
    </div>
  );
}

function UsageDetails({ subject, reading, windows, now }: { subject: Subject; reading: Reading; windows: UsageWindow[]; now: number }) {
  const usage = reading.usage;
  const updated = reading.fetching ? 'Updating…' : updatedLabel(usage?.updatedAt, now);
  return (
    <div className="flex flex-col gap-1.5 font-sans text-[11px] text-content">
      <div className="flex items-start gap-2.5 px-1 pb-2 pt-0.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-content/7 bg-content/6">
          <EngineIcon engine={subject.engine} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-4">{ENGINE_NAMES[subject.engine]} usage</div>
          <div className="mt-0.5 truncate text-[10px] leading-4 text-content/40">{subject.model ? `${subject.model} · ${updated}` : updated}</div>
        </div>
      </div>
      {usage?.error && windows.length ? (
        <p className="rounded-lg bg-[#fbbf24]/10 px-2.5 py-2 text-[10px] leading-4 text-[#b45309] dark:text-[#fcd34d]">Couldn’t refresh. Showing the last available snapshot.</p>
      ) : null}
      {windows.map(w => <WindowCard key={`${w.minutes}:${w.model ?? ''}`} window={w} now={now} />)}
      {!windows.length ? (
        <p className="rounded-lg border border-content/6 bg-content/[0.045] px-3 py-2.5 text-content/65">
          {usage?.error ?? (reading.fetching ? 'Reading usage…' : 'No usage read yet.')}
        </p>
      ) : null}
    </div>
  );
}

function UsageChip({ subject, reading, now }: { subject: Subject; reading: Reading; now: number }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const usage = reading.usage;
  const windows = windowsFor(usage?.windows ?? [], subject.names);
  const top = tightest(windows);
  const label = windows.length ? chipLabel(windows, now)
    : !usage ? '···'
    : usage.unavailable ? 'not connected'
    : 'usage unavailable';
  const description = windows.length
    ? windows.map(w => `${limitName(w.minutes, w.model)}: ${percent(w.usedPercent)} used, ${resetLabel(w, now).toLowerCase()}`).join('. ')
    : usage?.error ?? 'Loading usage';
  return (
    <>
      <button
        ref={button}
        type="button"
        data-usage-chip={subject.engine}
        aria-expanded={open}
        aria-label={`${ENGINE_NAMES[subject.engine]} usage${subject.model ? ` for ${subject.model}` : ''}: ${description}`}
        title={description}
        onClick={() => setOpen(v => !v)}
        className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 tabular-nums transition-colors duration-150 hover:bg-content/10 hover:text-content ${open ? 'bg-content/10 text-content' : ''}`}
      >
        <EngineIcon engine={subject.engine} className="size-3" />
        {top ? <Bar used={top.usedPercent} className="h-1 w-8" /> : null}
        <span>{label}</span>
      </button>
      {open ? (
        <Popover anchor={button} side="top" align="start" width={300} gap={7} ignore="[data-usage-chip]" onDismiss={() => setOpen(false)} className="p-2.5">
          <UsageDetails subject={subject} reading={reading} windows={windows} now={now} />
        </Popover>
      ) : null}
    </>
  );
}

/** The agent last in front, so a channel or Comms tab keeps the footer on the agent you came from. */
let lastAgentId: string | null = null;

/** Whose usage to show: the agent in front (or the last one), else, before any, the first installed engine. */
function useSubject(available: EngineKind[]): Subject | undefined {
  const focused = focusedAgentId(useLayout());
  useEffect(() => {
    if (focused) lastAgentId = focused;
  }, [focused]);
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === (focused ?? lastAgentId)));
  const models = useApp(s => (agent ? s.snapshot?.models[agent.engine] : undefined));
  if (agent) {
    // An agent on an engine with no usage to read shows none, rather than another engine's.
    if (!available.includes(agent.engine)) return undefined;
    const label = modelLabel(agent, models);
    const names = [agent.model, label === 'Default' ? undefined : label].filter((n): n is string => Boolean(n));
    return { engine: agent.engine, model: names.length ? label : undefined, names };
  }
  return available[0] ? { engine: available[0], names: [] } : undefined;
}

/**
 * The usage chip for the agent in front, or `fallback` when there is none to show: no engine
 * installed, or a server from before usage existed (its route 404s).
 */
export function UsageFooter({ fallback }: { fallback: ReactNode }) {
  const engines = useApp(s => s.snapshot?.engines);
  const available = ENGINES.filter(engine => engines?.[engine]?.available);
  const subject = useSubject(available);
  const engine = subject?.engine;
  const [readings, setReadings] = useState<Partial<Record<EngineKind, Reading>>>({});
  const [missing, setMissing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(30_000);

  const read = useCallback((kind: EngineKind, force: boolean): Promise<void> => {
    setReadings(r => ({ ...r, [kind]: { ...r[kind], fetching: true } }));
    return (force ? api.refreshUsage(kind) : api.usage(kind)).then(
      usage => setReadings(r => ({ ...r, [kind]: { usage, fetching: false } })),
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 404) setMissing(true);
        setReadings(r => ({ ...r, [kind]: { usage: r[kind]?.usage ?? { windows: [], error: 'Could not reach AgentsCode for usage.' }, fetching: false } }));
      },
    );
  }, []);

  // Only the engine on show is read; switching to the other reads it then (the server keeps it warm).
  useEffect(() => {
    if (!engine) return;
    read(engine, false);
    const timer = window.setInterval(() => read(engine, false), POLL_MS);
    return () => window.clearInterval(timer);
  }, [engine, read]);

  if (missing || !subject) return <>{fallback}</>;
  return (
    <span role="group" aria-label="Subscription usage" className="flex shrink-0 items-center gap-1">
      <UsageChip key={subject.engine} subject={subject} reading={readings[subject.engine] ?? { fetching: true }} now={now} />
      <button
        type="button"
        aria-label="Refresh usage"
        title="Refresh usage"
        disabled={refreshing}
        onClick={() => {
          setRefreshing(true);
          void read(subject.engine, true).finally(() => setRefreshing(false));
        }}
        className="grid size-5 shrink-0 place-items-center rounded-md text-content/40 transition-colors duration-150 hover:bg-content/10 hover:text-content disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.75} />
      </button>
    </span>
  );
}
