import type { Agent, Autonomy, EngineModels, PeerMessage } from '../shared/types.ts';
import { RUNTIME_MODE_HINT, RUNTIME_MODE_LABEL } from './mono/AccessPicker.tsx';
import { splitOrcacodeModel } from '../shared/engines.ts';

export function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function cost(usd: number | undefined): string {
  if (!usd) return '';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
export function joinNames(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

/** joinNames for long lists: "Ada, Bo, Cy and 31 others". */
export function someNames(names: string[], max = 4): string {
  if (names.length <= max) return joinNames(names);
  return `${names.slice(0, max - 1).join(', ')} and ${names.length - (max - 1)} others`;
}

export function shortPath(full: string, home: string | undefined): string {
  if (home && (full === home || full.startsWith(`${home}/`))) return `~${full.slice(home.length)}`;
  return full;
}

/** The access levels, labelled as the composer's AccessPicker shows them. */
export const AUTONOMY: { value: Autonomy; label: string; hint: string }[] = (['readonly', 'ask', 'edits', 'full'] as const)
  .map(value => ({ value, label: RUNTIME_MODE_LABEL[value], hint: RUNTIME_MODE_HINT[value] }));

export function autonomyLabel(value: Autonomy): string {
  return AUTONOMY.find(a => a.value === value)?.label ?? value;
}

export function modelLabel(agent: Pick<Agent, 'model'>, models: EngineModels | undefined): string {
  if (!agent.model) return models?.discovered ? models.defaultLabel : 'Default';
  return models?.models.find(m => m.value === agent.model)?.label ?? splitOrcacodeModel(agent.model).model;
}

/** The engine's providers that are not set up yet (OrcaCode), as a hint under its model picker. */
export function notSetUp(models: EngineModels | undefined): string | undefined {
  const missing = (models?.providers ?? []).filter(p => !p.configured).map(p => p.name);
  return missing.length ? `Not set up: ${missing.join(', ')}. Add them in orcacode with /provider, then Refresh models in Settings.` : undefined;
}

export function effortLabel(effort: string, fallback: string | null | undefined): string {
  const value = effort || fallback || '';
  if (!value) return 'Effort';
  if (value === 'xhigh') return 'Extra high';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const STATUS_LABEL: Record<PeerMessage['status'], string> = {
  queued: 'Queued',
  delivering: 'Working',
  delivered: 'Handled',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
