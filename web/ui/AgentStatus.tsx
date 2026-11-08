import type { Agent } from '../../shared/types.ts';
import { StatusLabel, type Tone } from './common.tsx';

/** How an agent is doing, in one tone and a few words: Needs you, what it is doing, Failed or Idle. */
export function agentState(agent: Agent, pending: boolean): { tone: Tone; busy?: boolean; label: string } {
  if (pending || agent.status === 'waiting') return { tone: 'warning', label: 'Needs you' };
  if (agent.status === 'working') return { tone: 'neutral', busy: true, label: agent.activity || 'Working' };
  if (agent.status === 'error') return { tone: 'danger', label: 'Failed' };
  return { tone: 'muted', label: 'Idle' };
}

/** An agent's state as a StatusLabel, the way MonoCode's headers show "Idle": a spinner while it works. */
export function AgentStatus({ agent, pending, className = '' }: { agent: Agent; pending: boolean; className?: string }) {
  const state = agentState(agent, pending);
  return (
    <StatusLabel tone={state.tone} busy={state.busy} quiet={state.tone === 'muted'} shrink title={state.label} className={className}>
      <span className="min-w-0 truncate">{state.label}</span>
    </StatusLabel>
  );
}
