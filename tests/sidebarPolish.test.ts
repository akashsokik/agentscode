import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { agentsSummary } from '../web/sidebar/agentRail.ts';

const agent = (id: string, fields: Partial<Agent> = {}): Agent => ({ id, name: id, status: 'idle', activity: '', lastActiveAt: 0, currentTask: null, ...fields }) as Agent;

test('a folded section, a project row and a rail icon say how many need you, or that one works', () => {
  const agents = [agent('a', { status: 'working' }), agent('b', { status: 'waiting' }), agent('c')];
  assert.deepEqual(agentsSummary(agents, new Set(['c'])), { needsYou: 2, working: true });
  // A working agent with an approval pending is waiting on you, not working.
  assert.deepEqual(agentsSummary([agent('a', { status: 'working' })], new Set(['a'])), { needsYou: 1, working: false });
  assert.deepEqual(agentsSummary([], new Set()), { needsYou: 0, working: false });
});
