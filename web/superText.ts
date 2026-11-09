/** The SuperAgent's words for the page. Pure, so it is tested directly. */
import type { Agent, SuperAsk } from '../shared/types.ts';

/** Questions the SuperAgent asked that wait for the user, newest first. */
export function openAsks(asks: readonly SuperAsk[] | undefined): SuperAsk[] {
  return (asks ?? []).filter(a => a.answeredAt === undefined);
}

/** A line on what the SuperAgent is doing, for the status bar and the menu bar. */
export function superLabel(agent: Pick<Agent, 'status' | 'activity'> | undefined, waiting: number): string {
  if (!agent) return 'Set up the SuperAgent';
  const doing = agent.status === 'working' ? agent.activity || 'Working' : agent.status === 'error' ? 'Hit a problem' : 'Watching your agents';
  return waiting ? `${doing} · ${waiting} waiting for you` : doing;
}
