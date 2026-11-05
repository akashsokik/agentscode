import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent } from '../shared/types.ts';
import { ALL_PROJECTS, railAgents, railAgentStatus } from '../web/sidebar/agentRail.ts';

let made = 0;
const agent = (fields: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent => ({ projectId: null, status: 'idle', unread: false, createdAt: ++made, ...fields }) as Agent;

test('only agents with no project are listed; project agents stay in their workspace column', () => {
  const listed = railAgents([
    agent({ id: 'ada', name: 'Ada', projectId: 'p1' }),
    agent({ id: 'nova', name: 'Nova' }),
    agent({ id: 'cy', name: 'Cy', projectId: 'p2' }),
    // An agent whose project was deleted still has a project id: it is not one that works across all of them.
    agent({ id: 'gone', name: 'Dee', projectId: 'deleted' }),
    agent({ id: 'atlas', name: 'atlas' }),
  ]);
  assert.deepEqual(listed.map(a => a.id), ['atlas', 'nova']);
});

test('nothing is listed when every agent belongs to a project', () => {
  assert.deepEqual(railAgents([agent({ id: 'ada', name: 'Ada', projectId: 'p1' })]), []);
});

test('by name, case-insensitive and numeric; the same name keeps creation order', () => {
  const first = agent({ id: 'first', name: 'Scout' });
  const listed = railAgents([
    agent({ id: 'a10', name: 'Agent 10' }),
    agent({ id: 'second', name: 'scout' }),
    first,
    agent({ id: 'a2', name: 'Agent 2' }),
  ]);
  // "Scout" was made before "scout", so it comes first.
  assert.deepEqual(listed.map(a => a.id), ['a2', 'a10', 'first', 'second']);
});

test('the All projects label is still exported for web/projects.ts', () => {
  assert.equal(ALL_PROJECTS, 'All projects');
});

test('row status follows the agent card: needs you, then working, failed, unread', () => {
  assert.equal(railAgentStatus({ status: 'waiting', unread: false }, false), 'needs-you');
  assert.equal(railAgentStatus({ status: 'working', unread: true }, true), 'needs-you');
  assert.equal(railAgentStatus({ status: 'working', unread: true }, false), 'working');
  assert.equal(railAgentStatus({ status: 'error', unread: true }, false), 'failed');
  assert.equal(railAgentStatus({ status: 'done', unread: true }, false), 'unread');
  assert.equal(railAgentStatus({ status: 'idle', unread: false }, false), null);
});
