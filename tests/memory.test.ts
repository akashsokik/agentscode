import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDate, soulPath } from '../web/memory.ts';

test('the soul sits in the agent home as soul.md', () => {
  assert.equal(soulPath('/Users/me/.agentscode/agents/a1'), '/Users/me/.agentscode/agents/a1/soul.md');
  assert.equal(soulPath('/Users/me/.agentscode/agents/a1/'), '/Users/me/.agentscode/agents/a1/soul.md');
});

test('memory dates read as today, yesterday, a day this year, or a day in another year', () => {
  const now = new Date(2026, 10, 5, 17, 30).getTime();
  assert.equal(memoryDate(new Date(2026, 10, 5, 0, 5).getTime(), now), 'Today');
  assert.equal(memoryDate(new Date(2026, 10, 4, 23, 59).getTime(), now), 'Yesterday');
  assert.equal(memoryDate(new Date(2026, 10, 3, 9).getTime(), now), 'Nov 3');
  assert.equal(memoryDate(new Date(2025, 0, 12).getTime(), now), 'Jan 12, 2025');
});
