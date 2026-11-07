/**
 * What the composer's ModelPicker lists. Pure, so it is tested directly. The layout follows
 * MonoCode's ModelPicker: a menu with Reasoning, Service Tier and Model rows, each opening a
 * submenu; the model submenu has a provider rail when the engine has several providers (OrcaCode).
 */
import type { Agent, EngineKind, EngineModels, ModelOption } from '../../shared/types.ts';
import { serviceTiers, splitOrcacodeModel } from '../../shared/engines.ts';

/** An effort level as MonoCode names it: "xhigh" is Extra High, the rest are capitalised. */
export function effortName(value: string): string {
  if (value === 'xhigh') return 'Extra High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The efforts the agent's model supports, else every effort the engine knows. */
export function effortOptions(agent: Pick<Agent, 'model'>, models: EngineModels | undefined): string[] {
  const model = models?.models.find(m => m.value === agent.model);
  return model?.efforts.length ? model.efforts : models?.efforts ?? [];
}

/** The effort in force: the agent's own pick, else the CLI's default, else ''. */
export function effectiveEffort(agent: Pick<Agent, 'effort'>, models: EngineModels | undefined): string {
  return agent.effort || models?.defaultEffort || '';
}

/** The effort row's name: Reasoning, for every engine. */
export function effortRowLabel(_engine: EngineKind): string {
  return 'Reasoning';
}

/** The menu's rows, in order: Reasoning (when the model has levels), Service Tier (when it has tiers), Model. */
export type Entry = 'effort' | 'tier' | 'model';

export function menuEntries(agent: Pick<Agent, 'model' | 'effort' | 'serviceTier'>, models: EngineModels | undefined): Entry[] {
  const entries: Entry[] = [];
  if (hasEffortRow(agent, models)) entries.push('effort');
  if (serviceTiers(agent, models).length || agent.serviceTier) entries.push('tier');
  entries.push('model');
  return entries;
}

export interface TierRow {
  /** '' is Standard. */
  value: string;
  label: string;
  hint?: string;
}

/** The Service Tier submenu: Standard, then each tier the model offers (and the agent's own, if the model dropped it). */
export function tierRows(agent: Pick<Agent, 'model' | 'serviceTier'>, models: EngineModels | undefined): TierRow[] {
  const tiers = serviceTiers(agent, models);
  const rows: TierRow[] = [{ value: '', label: 'Standard' }, ...tiers.map(t => ({ value: t.id, label: t.name, hint: t.description }))];
  if (agent.serviceTier && !tiers.some(t => t.id === agent.serviceTier)) rows.push({ value: agent.serviceTier, label: agent.serviceTier });
  return rows;
}

/** The tier in force, by name: Standard unless the agent picked one. */
export function tierName(agent: Pick<Agent, 'model' | 'serviceTier'>, models: EngineModels | undefined): string {
  if (!agent.serviceTier) return 'Standard';
  return serviceTiers(agent, models).find(t => t.id === agent.serviceTier)?.name ?? agent.serviceTier;
}

export interface ModelGroup {
  /** The provider id models carry before `::` (OrcaCode), e.g. "openrouter". */
  id: string;
  label: string;
}

/** A model's group id: its provider, from `provider::model`. */
export function groupOf(model: Pick<ModelOption, 'value'>): string | null {
  return splitOrcacodeModel(model.value).provider;
}

/** The providers the engine's models come from, in the order they are listed. Fewer than two means no rail. */
export function modelGroups(models: EngineModels | undefined): ModelGroup[] {
  const groups: ModelGroup[] = [];
  for (const model of models?.models ?? []) {
    const id = groupOf(model);
    if (id && !groups.some(g => g.id === id)) groups.push({ id, label: model.group ?? id });
  }
  return groups;
}

/** The rail tab the flyout opens on: the agent's model's provider, else the first one. */
export function initialGroup(agent: Pick<Agent, 'model'>, groups: ModelGroup[]): string | null {
  const own = splitOrcacodeModel(agent.model).provider;
  return groups.find(g => g.id === own)?.id ?? groups[0]?.id ?? null;
}

export interface EffortRow {
  /** '' is Default: whatever the CLI is configured for. */
  value: string;
  label: string;
  hint?: string;
}

/**
 * The effort submenu: Default first (with what it resolves to), then each level. A level the agent
 * has that the model no longer lists still shows, so the check mark has a row.
 */
export function effortRows(agent: Pick<Agent, 'model' | 'effort'>, models: EngineModels | undefined): EffortRow[] {
  const values = effortOptions(agent, models);
  const all = agent.effort && !values.includes(agent.effort) ? [...values, agent.effort] : values;
  const fallback = models?.defaultEffort;
  return [
    { value: '', label: 'Default', hint: fallback ? effortName(fallback) : undefined },
    ...all.map(value => ({ value, label: effortName(value) })),
  ];
}

/** Whether the menu has an effort row: the model has levels, or the agent already picked one. */
export function hasEffortRow(agent: Pick<Agent, 'model' | 'effort'>, models: EngineModels | undefined): boolean {
  return effortOptions(agent, models).length > 0 || Boolean(agent.effort);
}

export type ModelRow =
  | { kind: 'default'; label: string; hint: string }
  | { kind: 'model'; model: ModelOption }
  | { kind: 'custom'; value: string };

/** The value a row sets the agent's model to. */
export function modelRowValue(row: ModelRow): string {
  return row.kind === 'default' ? '' : row.kind === 'model' ? row.model.value : row.value;
}

/**
 * The model flyout's rows for a search: Default, the matching models, the agent's own custom id if
 * it is one, and, when the search names no model exactly, the search itself as a custom model id.
 */
export function modelRows(agent: Pick<Agent, 'model'>, models: EngineModels | undefined, query: string, group: string | null = null): ModelRow[] {
  const needle = query.trim().toLowerCase();
  // Every word must match somewhere, so "opus router" finds OpenRouter's Opus.
  const words = needle.split(/\s+/).filter(Boolean);
  const matches = (...texts: string[]) => !words.length || words.every(word => texts.some(text => text.toLowerCase().includes(word)));
  // A search covers every provider; without one, the rail's tab picks the provider.
  const listed = (models?.models ?? []).filter(m => needle || !group || groupOf(m) === group);
  const defaultHint = models?.discovered ? models.defaultLabel : 'CLI setting';
  const rows: ModelRow[] = [];
  if (matches('Default', defaultHint)) rows.push({ kind: 'default', label: 'Default', hint: defaultHint });
  for (const model of listed) if (matches(model.label, model.value, model.description, model.group ?? '')) rows.push({ kind: 'model', model });
  if (agent.model && !(models?.models ?? []).some(m => m.value === agent.model) && matches(agent.model)) {
    rows.push({ kind: 'model', model: { value: agent.model, label: agent.model, description: 'Custom model id', efforts: [] } });
  }
  const exact = rows.some(row => row.kind === 'model' && (row.model.value.toLowerCase() === needle || row.model.label.toLowerCase() === needle));
  // Model ids have no spaces, so a multi-word search is only a search.
  if (needle && !exact && !/\s/.test(needle)) rows.push({ kind: 'custom', value: query.trim() });
  return rows;
}

/** Which row the flyout highlights first: the agent's current model, else the top row. */
export function currentModelRow(rows: ModelRow[], agent: Pick<Agent, 'model'>): number {
  const index = rows.findIndex(row => row.kind !== 'custom' && modelRowValue(row) === agent.model);
  return index >= 0 ? index : 0;
}
