import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, TurnUsage } from '../shared/types.ts';
import { cacheHitPercent, turnMetricsText, usageSince, usageTotal } from '../shared/turnUsage.ts';
import { ClaudeRunner, claudeTurnUsage } from '../server/agents/claude.ts';
import { CodexRunner, codexTotals, codexTurnUsage } from '../server/agents/codex.ts';
import type { RunnerHooks, TurnResult } from '../server/agents/runner.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): TurnUsage =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const baseAgent: Agent = {
  id: 'a1', name: 'Ada', engine: 'claude', projectIds: ['p1'], worktree: null, home: '/tmp/agentscode-test/agents/a1', dreaming: true, model: '', effort: '',
  autonomy: 'ask', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
  currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
  costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
};

function recordingHooks(results: TurnResult[], sessions: string[] = []): RunnerHooks {
  return {
    session: id => sessions.push(id), entry: () => {}, activity: () => {}, turnStart: () => {},
    turnEnd: result => results.push(result), approval: async () => ({ allow: true }), closed: () => {},
  };
}

test('the hover text reads as MonoCode shows it', () => {
  assert.deepEqual(
    turnMetricsText({ usage: usage(800, 400, 9100, 100), durationMs: 10_000, costUsd: 0.123 }),
    { headline: 'Cache hit 91% · Output 40 tok/s · Cost $0.12', detail: '800 input · 400 output · 9.1K cached · 100 cache write' },
  );
  // No cache traffic is a 0% hit, not a missing one; no duration means no speed.
  assert.deepEqual(turnMetricsText({ usage: usage(1500, 20) }), { headline: 'Cache hit 0%', detail: '1.5K input · 20 output' });
});

test('turns without a usage breakdown fall back to cost and tokens, or show nothing', () => {
  assert.deepEqual(turnMetricsText({ costUsd: 0.004, tokens: 12_345 }), { headline: 'Cost <$0.01', detail: '12K tokens' });
  assert.deepEqual(turnMetricsText({ tokens: 900 }), { headline: 'Turn tokens', detail: '900 tokens' });
  assert.equal(turnMetricsText({ durationMs: 5000 }), null);
  assert.equal(turnMetricsText({ usage: usage(0, 0) }), null);
  assert.equal(turnMetricsText(undefined), null);
});

test('the cache hit counts reads against the whole prompt; a running total can be differenced', () => {
  assert.equal(cacheHitPercent(usage(100, 5, 900)), 90);
  assert.equal(cacheHitPercent(usage(0, 5)), null);
  assert.equal(usageTotal(usage(1, 2, 3, 4)), 10);
  assert.deepEqual(usageSince(usage(300, 30, 3000), usage(100, 10, 1000)), usage(200, 20, 2000));
  assert.equal(usageSince(usage(50, 30, 3000), usage(100, 10, 1000)), null);
});

test('Claude usage maps straight across, and a result without any gives none', () => {
  assert.deepEqual(
    claudeTurnUsage({ input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 40_000, cache_creation_input_tokens: null }),
    usage(12, 340, 40_000, 0),
  );
  assert.equal(claudeTurnUsage(undefined), undefined);
  assert.equal(claudeTurnUsage({ input_tokens: 0, output_tokens: 0 }), undefined);
});

test('the Claude runner puts the result usage on the turn result', async () => {
  const results: TurnResult[] = [];
  const fake = ((params: { prompt: AsyncIterable<unknown> }) => {
    const input = params.prompt[Symbol.asyncIterator]();
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      await input.next();
      yield {
        type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.05,
        usage: { input_tokens: 20, output_tokens: 600, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2000 },
      };
      await new Promise(() => {});
    }
    return Object.assign(run(), {
      interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      applyFlagSettings: async () => {}, close: () => {},
    });
  }) as unknown as typeof query;
  const runner = new ClaudeRunner({
    agent: () => baseAgent,
    project: { id: 'p1', name: 'App', path: '/tmp/app', createdAt: 0, exists: true, isGit: false },
    cwd: '/tmp/app', binPath: null, hooks: recordingHooks(results),
  }, fake);
  runner.send('Go');
  await settle(10);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].usage, usage(20, 600, 50_000, 2000));
  runner.close();
});

test('Codex totals take cached input out of input', () => {
  assert.deepEqual(
    codexTotals({ input_tokens: 29_072, cached_input_tokens: 7168, cache_write_input_tokens: 0, output_tokens: 164, reasoning_output_tokens: 0 }),
    usage(21_904, 164, 7168, 0),
  );
  assert.deepEqual(codexTotals(undefined), usage(0, 0));
});

test('a Codex turn is the difference from the totals kept after the last turn of the same thread', () => {
  const first = usage(100, 10, 1000);
  const later = usage(150, 25, 3000);
  assert.deepEqual(codexTurnUsage(first, 't1', true, undefined), { usage: first, threadUsage: { thread: 't1', usage: first } });
  // A fresh thread starts from zero even if another thread's totals are still kept.
  assert.deepEqual(codexTurnUsage(first, 't2', true, { thread: 't1', usage: later }).usage, first);
  assert.deepEqual(codexTurnUsage(later, 't1', false, { thread: 't1', usage: first }).usage, usage(50, 15, 2000));
  // A resumed thread with no kept totals has no honest figure, but keeps the totals for next time.
  assert.deepEqual(codexTurnUsage(later, 't1', false, undefined), { threadUsage: { thread: 't1', usage: later } });
  assert.deepEqual(codexTurnUsage(later, 't1', false, { thread: 't0', usage: first }), { threadUsage: { thread: 't1', usage: later } });
  // Totals that shrank mean Codex counted again from zero.
  assert.deepEqual(codexTurnUsage(first, 't1', false, { thread: 't1', usage: later }).usage, first);
});

test('the Codex runner reports per-turn usage across a resumed thread', async () => {
  const dir = tempDir('codex-usage');
  const bin = path.join(dir, 'codex');
  // Codex prints the thread's running totals on every turn.completed, resumed or not.
  fs.writeFileSync(bin, `#!/bin/sh
cat > /dev/null
case "$*" in
  *resume*) totals='{"input_tokens":5000,"cached_input_tokens":3500,"output_tokens":300}' ;;
  *) totals='{"input_tokens":2000,"cached_input_tokens":500,"output_tokens":100}' ;;
esac
echo '{"type":"thread.started","thread_id":"thread-1"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Done."}}'
echo "{\\"type\\":\\"turn.completed\\",\\"usage\\":$totals}"
`, { mode: 0o755 });
  const agent: Agent = { ...baseAgent, engine: 'codex' };
  const results: TurnResult[] = [];
  const hooks: RunnerHooks = {
    ...recordingHooks(results, []),
    session: id => { agent.sessionId = id; },
    turnEnd: result => {
      results.push(result);
      if (result.threadUsage) agent.threadUsage = result.threadUsage;
    },
  };
  const runner = new CodexRunner({
    agent: () => agent,
    project: { id: 'p1', name: 'App', path: dir, createdAt: 0, exists: true, isGit: false },
    cwd: dir, binPath: bin, hooks,
  });
  const turn = async (text: string) => {
    runner.send(text);
    for (let i = 0; i < 200 && runner.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  };
  await turn('First');
  await turn('Second');
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].usage, usage(1500, 100, 500));
  assert.equal(results[0].tokens, 2100);
  assert.deepEqual(results[1].usage, usage(0, 200, 3000));
  assert.equal(results[1].tokens, 3200);
  assert.deepEqual(agent.threadUsage, { thread: 'thread-1', usage: usage(1500, 300, 3500) });
});

test('the turn usage lands on the done entry, and the thread totals on the agent until New session', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const cy = await h.manager.create({ name: 'Cy', engine: 'codex', projectId: project.id });
  h.manager.send(cy.id, 'Do it');
  const runner = h.runner(cy.id);
  runner.busy = false;
  runner.ctx.hooks.turnEnd({
    ok: true, summary: 'Did it.', tokens: 1600, usage: usage(1000, 100, 500),
    threadUsage: { thread: 'thread-9', usage: usage(1000, 100, 500) },
  });
  runner.ctx.hooks.ready?.();
  await settle();
  const done = h.manager.entries(cy.id).findLast(e => e.kind === 'done');
  assert.deepEqual(done?.meta?.usage, usage(1000, 100, 500));
  assert.equal(done?.meta?.tokens, 1600);
  assert.deepEqual(h.store.agents.get(cy.id)?.threadUsage, { thread: 'thread-9', usage: usage(1000, 100, 500) });

  await h.manager.newSession(cy.id);
  assert.equal(h.store.agents.get(cy.id)?.threadUsage, undefined);
});
