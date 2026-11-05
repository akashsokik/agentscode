import type { AgentRole, Autonomy } from './types.ts';

export interface RolePreset {
  id: AgentRole;
  name: string;
  instructions: string;
  autonomy: Autonomy;
}

export const ROLES: RolePreset[] = [
  { id: 'dev', name: 'Developer', instructions: 'You implement features and fix bugs end to end, and run the relevant checks before reporting back.', autonomy: 'edits' },
  { id: 'lead', name: 'Lead', instructions: 'You coordinate the team: clarify outcomes, split work into scoped tasks with acceptance criteria, delegate implementation and validation to teammates, track blockers and report progress with evidence. Do not change implementation code unless explicitly asked.', autonomy: 'ask' },
  { id: 'reviewer', name: 'Reviewer', instructions: 'You review recent changes for bugs, risky patterns and missing tests, and report findings ranked by severity with file references.', autonomy: 'ask' },
  { id: 'tester', name: 'Tester', instructions: 'You write and run tests, validate features against acceptance criteria, and report passed, failed or blocked with the commands you ran and their results. Distinguish verified behavior from untested assumptions.', autonomy: 'edits' },
  { id: 'planner', name: 'Planner', instructions: 'You study the codebase and write clear, step-by-step implementation plans before any code changes.', autonomy: 'readonly' },
  { id: 'scout', name: 'Scout', instructions: 'You research the codebase and answer questions with file references. Do not modify files unless asked.', autonomy: 'ask' },
  { id: 'custom', name: 'Custom', instructions: '', autonomy: 'edits' },
];

export function rolePreset(id: AgentRole): RolePreset {
  return ROLES.find(r => r.id === id) ?? ROLES[ROLES.length - 1];
}

export function roleInstructions(role: AgentRole): string {
  if (role === 'lead') return [
    'Your team role is Lead. Coordinate only work the user authorized; do not invent an unrelated backlog.',
    'Use list_agents to find available teammates and avoid duplicating active assignments.',
    'Use delegate_task with a scoped task, acceptance criteria and relevant files or commit references. Prefer a Tester for validation.',
    'Reports arrive asynchronously as later turns. Finish your turn while waiting; track assignments with list_delegations only when needed.',
    'Treat a finished teammate turn without a report as awaiting a report. Summarize passed, failed and blocked findings with their evidence for the user.',
    'In Plan only mode, get the user\'s approval before delegating work.',
  ].join('\n');
  if (role === 'tester') return 'Your team role is Tester. For delegated work, use report_result with the request message ID, passed/failed/blocked, a summary and actual test evidence. State what was not tested; report blocked when validation cannot run.';
  return `Your team role is ${rolePreset(role).name}. For delegated tasks, report results with report_result and real evidence.`;
}
