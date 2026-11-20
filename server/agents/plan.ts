import type { PlanStep } from '../../shared/types.ts';

// ACH-73: the plan an engine reported, as plain steps. Only what it said: no step is marked done or
// in progress unless the engine said so, and entries without text are dropped, not filled in.

const MAX_STEPS = 50;
const MAX_TEXT = 300;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/** Claude Code's TodoWrite input: todos of { content, status: pending | in_progress | completed }. */
export function claudePlanSteps(input: unknown): PlanStep[] {
  const todos = input && typeof input === 'object' && Array.isArray((input as { todos?: unknown }).todos) ? (input as { todos: unknown[] }).todos : [];
  return todos.flatMap((todo): PlanStep[] => {
    if (!todo || typeof todo !== 'object') return [];
    const t = todo as { content?: unknown; status?: unknown };
    const step = text(t.content);
    if (!step) return [];
    return [{ text: step, status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending' }];
  }).slice(0, MAX_STEPS);
}

/** Codex's todo_list item: items of { text, completed }. Codex has no "in progress", so none is active. */
export function codexPlanSteps(items: unknown): PlanStep[] {
  return (Array.isArray(items) ? items : []).flatMap((item): PlanStep[] => {
    if (!item || typeof item !== 'object') return [];
    const t = item as { text?: unknown; completed?: unknown };
    const step = text(t.text);
    return step ? [{ text: step, status: t.completed === true ? 'done' : 'pending' }] : [];
  }).slice(0, MAX_STEPS);
}
