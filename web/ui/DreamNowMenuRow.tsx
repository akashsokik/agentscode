import type { Agent } from '../../shared/types.ts';
import { api } from '../api.ts';
import { attempt } from '../store.ts';
import { MenuRow } from './common.tsx';
import { Sparkles } from '../mono/icons.tsx';

/** "Dream now" in an agent's menu: off while dreams are off or the agent is in a turn, saying why. */
export function DreamNowMenuRow({ agent, run }: { agent: Agent; run: (action: () => void) => () => void }) {
  const working = agent.status === 'working' || agent.status === 'waiting';
  const hint = !agent.dreaming ? 'Dreams are off for this agent.' : working ? 'Waits until the turn ends.' : 'Tidy its memory from recent sessions.';
  return (
    <MenuRow
      icon={Sparkles}
      title="Dream now"
      hint={hint}
      disabled={!agent.dreaming || working}
      onSelect={run(() => void attempt(() => api.dreamNow(agent.id)))}
    />
  );
}
