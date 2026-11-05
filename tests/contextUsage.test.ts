import assert from 'node:assert/strict';
import test from 'node:test';
import { contextPercent, contextRatio, contextTooltip, dropContextWindow, formatTokens, mergeContextUsage, sameContextUsage } from '../shared/contextUsage.ts';
import { contextWindow, promptTokens } from '../server/agents/claude.ts';
import { harness, projectDir, settle } from './helpers.ts';

test('the tooltip reads as MonoCode shows it', () => {
  assert.deepEqual(contextTooltip({ used: 176_000, window: 256_000 }), { headline: '69% context used', detail: '176K / 256K tokens' });
  assert.deepEqual(contextTooltip({ used: 980 }), { headline: 'Context used', detail: '980 tokens' });
  assert.equal(formatTokens(1500), '1.5K');
  assert.equal(formatTokens(1_000_000), '1M');
});

test('an unknown window gives no ratio, and a full one is capped', () => {
  assert.equal(contextRatio(undefined), null);
  assert.equal(contextRatio({ used: 5000 }), null);
  assert.equal(contextRatio({ used: 5000, window: 0 }), null);
  assert.equal(contextRatio({ used: 300_000, window: 200_000 }), 1);
  assert.equal(contextPercent({ used: 150_000, window: 200_000 }), 75);
});

test('a reading without a window keeps the last one; a model change drops only the window', () => {
  const first = mergeContextUsage(undefined, { used: 40_000 });
  assert.deepEqual(first, { used: 40_000 });
  const withWindow = mergeContextUsage(first, { window: 200_000 });
  assert.deepEqual(withWindow, { used: 40_000, window: 200_000 });
  assert.deepEqual(mergeContextUsage(withWindow, { used: 52_000 }), { used: 52_000, window: 200_000 });
  assert.deepEqual(dropContextWindow(withWindow), { used: 40_000 });
  assert.equal(dropContextWindow(undefined), undefined);
  assert.ok(sameContextUsage(withWindow, { used: 40_000, window: 200_000 }));
  assert.ok(!sameContextUsage(withWindow, first));
});

test('the prompt size counts fresh input and both cache fields, which may be null', () => {
  assert.equal(promptTokens({ input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40_000 }), 43_012);
  assert.equal(promptTokens({ input_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: null }), 7);
  assert.equal(promptTokens(undefined), 0);
});

test('the window comes from the answering model, else the one that read the most', () => {
  const usage = {
    'claude-haiku-5-5': { inputTokens: 90_000, contextWindow: 200_000 },
    'claude-opus-5-5': { inputTokens: 12, cacheReadInputTokens: 40_000, contextWindow: 1_000_000 },
  };
  assert.equal(contextWindow(usage, 'claude-opus-5-5'), 1_000_000);
  assert.equal(contextWindow(usage, 'opus'), 200_000);
  assert.equal(contextWindow({}, 'claude-opus-5-5'), undefined);
  assert.equal(contextWindow(undefined, ''), undefined);
});

test('readings reach the agent in the snapshot; a model change drops the window, New session clears it', async () => {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  h.manager.send(ada.id, 'Read the code');
  const runner = h.runner(ada.id);
  const agentEvents = () => h.events.filter(e => e.type === 'agent').length;

  runner.ctx.hooks.context?.({ used: 40_000 });
  runner.ctx.hooks.context?.({ window: 200_000 });
  const before = agentEvents();
  runner.ctx.hooks.context?.({ used: 40_000 });
  assert.equal(agentEvents(), before, 'an unchanged reading is not broadcast');
  assert.deepEqual(h.manager.snapshot().agents.find(a => a.id === ada.id)?.context, { used: 40_000, window: 200_000 });

  runner.complete(true, 'Read it.');
  await settle();
  await h.manager.update(ada.id, { model: 'opus' });
  assert.deepEqual(h.store.agents.get(ada.id)?.context, { used: 40_000 });

  await h.manager.newSession(ada.id);
  assert.equal(h.store.agents.get(ada.id)?.context, undefined);
});
