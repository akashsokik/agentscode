/**
 * What the composer's ModelPicker lists. Pure, so it is tested directly. The layout follows
 * MonoCode's ModelPicker: a menu with an effort row and a Model row, each opening a submenu.
 */
import type { Agent, EngineKind, EngineModels, ModelOption } from '../../shared/types.ts';

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

/** The effort row's name, as MonoCode names each engine's setting. */
export function effortRowLabel(engine: EngineKind): string {
  return engine === 'codex' ? 'Reasoning' : 'Effort';
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
export function modelRows(agent: Pick<Agent, 'model'>, models: EngineModels | undefined, query: string): ModelRow[] {
  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]) => !needle || texts.some(text => text.toLowerCase().includes(needle));
  const listed = models?.models ?? [];
  const defaultHint = models?.discovered ? models.defaultLabel : 'CLI setting';
  const rows: ModelRow[] = [];
  if (matches('Default', defaultHint)) rows.push({ kind: 'default', label: 'Default', hint: defaultHint });
  for (const model of listed) if (matches(model.label, model.value, model.description)) rows.push({ kind: 'model', model });
  if (agent.model && !listed.some(m => m.value === agent.model) && matches(agent.model)) {
    rows.push({ kind: 'model', model: { value: agent.model, label: agent.model, description: 'Custom model id', efforts: [] } });
  }
  const exact = rows.some(row => row.kind === 'model' && (row.model.value.toLowerCase() === needle || row.model.label.toLowerCase() === needle));
  if (needle && !exact) rows.push({ kind: 'custom', value: query.trim() });
  return rows;
}

/** Which row the flyout highlights first: the agent's current model, else the top row. */
export function currentModelRow(rows: ModelRow[], agent: Pick<Agent, 'model'>): number {
  const index = rows.findIndex(row => row.kind !== 'custom' && modelRowValue(row) === agent.model);
  return index >= 0 ? index : 0;
}
