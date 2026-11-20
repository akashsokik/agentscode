import { taskTitle } from '../peerText.ts';
import type { Agent } from '../../shared/types.ts';

export function overviewNow(agent: Agent, now: number) {
  const busy = agent.status === 'working' || agent.status === 'waiting';
  return {
    busy,
    title: busy ? (agent.currentTask?.summary ? taskTitle(agent.currentTask.summary) : 'Working on your request') : agent.lastSummary || 'Ready for the next task.',
    activity: busy ? agent.activity : agent.error || '',
    elapsedMs: busy && agent.turnStartedAt ? Math.max(0, now - agent.turnStartedAt) : null,
    state: agent.status === 'waiting' ? 'Waiting for you' : agent.status === 'working' ? 'Working' : agent.status === 'error' ? 'Stopped with an error' : 'Idle',
  };
}
