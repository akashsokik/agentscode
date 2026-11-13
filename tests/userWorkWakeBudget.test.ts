import assert from 'node:assert/strict';
import test from 'node:test';
import type { PeerMessage } from '../shared/types.ts';
import { SuperStore, type SuperWatcher } from '../server/superAgent.ts';
import { harness, settle } from './helpers.ts';

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const dev = await h.manager.create({ name: 'Dev', engine: 'claude', projectId: null });
  const reviewer = await h.manager.create({ name: 'Reviewer', engine: 'claude', projectId: null, role: 'reviewer' });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Ready.');
  await settle();
  h.runner(sup.id).complete();
  const call = (id: string, tool: string, args: Record<string, unknown>) => h.manager.commsTool(h.runner(id).ctx.commsToken!, tool, args);
  const watcher = (h.manager as unknown as { watcher: SuperWatcher }).watcher;
  const wakes = () => new SuperStore(h.store.dataDir).wakesSince(Date.now() - 3_600_000);
  return { ...h, dev, reviewer, sup, call, watcher, wakes };
}

test('ACH-25: user work given directly to a dev carries replies, reviews and fixes past the wake caps without counting', async () => {
  const t = await team();
  try {
    t.manager.updateSettings({ superMaxWakesPerHour: 0, superWake: false, superDailyBudgetUsd: 1 });
    new SuperStore(t.store.dataDir).addAutonomousCost(5);
    t.manager.send(t.dev.id, 'Implement this and coordinate its review with the SuperAgent.');
    await settle();
    const request = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Please coordinate the review.' }) as PeerMessage;
    t.runner(t.dev.id).complete();
    await settle();
    assert.equal(t.store.conversations.find(c => c.id === request.conversationId)?.userStarted, true);
    assert.equal(t.runner(t.sup.id).sent.at(-1)?.task?.messageId, request.id);
    const reply = await t.call(t.sup.id, 'reply', { message_id: request.id, text: 'Starting the review.' }) as PeerMessage;
    assert.equal(reply.conversationId, request.conversationId);

    for (const [agent, kind] of [[t.reviewer, 'review'], [t.dev, 'implementation']] as const) {
      const task = await t.call(t.sup.id, 'delegate_task', { to_agent_id: agent.id, kind, task: kind === 'review' ? 'Review the change.' : 'Fix the review findings.', acceptance_criteria: 'Finished.' }) as PeerMessage;
      assert.equal(task.conversationId, request.conversationId, 'follow-ups retain the user root');
      t.runner(t.sup.id).complete();
      await settle();
      // Dev first handles the earlier reply, then the fix delegation.
      if (agent.id === t.dev.id) {
        assert.equal(t.runner(agent.id).sent.at(-1)?.task?.messageId, reply.id);
        t.runner(agent.id).complete();
        await settle();
      }
      const report = await t.call(agent.id, 'report_result', { message_id: task.id, outcome: 'done', summary: 'Finished.', evidence: 'Read the change.' }) as PeerMessage;
      t.runner(agent.id).complete();
      await settle();
      assert.equal(t.runner(t.sup.id).sent.at(-1)?.task?.messageId, report.id);
      assert.equal(report.status, 'delivering');
      assert.equal(t.wakes(), 0);
      assert.equal(t.manager.superView().held, null);
    }
  } finally { await t.manager.shutdown(); }
});

test('ACH-25: a delegation rooted in a user turn to a lead can reach the SuperAgent with an exhausted hourly budget', async () => {
  const t = await team();
  try {
    await t.manager.update(t.dev.id, { role: 'lead' });
    t.manager.updateSettings({ superMaxWakesPerHour: 0 });
    t.manager.send(t.dev.id, 'Ask the SuperAgent to coordinate this work.');
    await settle();
    const task = await t.call(t.dev.id, 'delegate_task', { to_agent_id: t.sup.id, kind: 'implementation', task: 'Coordinate my user-requested work.', acceptance_criteria: 'Coordinated.' }) as PeerMessage;
    await settle();
    assert.equal(t.runner(t.sup.id).sent.at(-1)?.task?.messageId, task.id);
    assert.equal(t.wakes(), 0);
    assert.equal(t.manager.superView().held, null);
  } finally { await t.manager.shutdown(); }
});

test('ACH-25: reports on SuperAgent-initiated chains still wait on and consume the hourly wake budget', async () => {
  const t = await team();
  try {
    t.manager.updateSettings({ superMaxWakesPerHour: 1 });
    t.watcher.note({ agentId: t.dev.id, key: 'free', text: 'Dev is free.' });
    assert.equal(t.watcher.flush(), true);
    await settle();
    const task = await t.call(t.sup.id, 'delegate_task', { to_agent_id: t.dev.id, kind: 'implementation', task: 'Tidy something on your own.', acceptance_criteria: 'Tidied.' }) as PeerMessage;
    assert.equal(t.store.conversations.find(c => c.id === task.conversationId)?.userStarted, undefined);
    t.runner(t.sup.id).complete();
    await settle();
    // Even if reporting during a later user turn, this report answers the original autonomous task.
    t.runner(t.dev.id).complete();
    t.manager.send(t.dev.id, 'Tell me the result of the earlier autonomous task.');
    await settle();
    const report = await t.call(t.dev.id, 'report_result', { message_id: task.id, outcome: 'done', summary: 'Tidied.', evidence: 'Done.' }) as PeerMessage;
    t.runner(t.dev.id).complete();
    await settle();
    assert.equal(report.status, 'queued');
    assert.equal(t.wakes(), 1);
    assert.deepEqual(t.manager.superView().held, { count: 1, reason: 'the hourly wake budget is used' });
    t.manager.updateSettings({ superMaxWakesPerHour: 2 });
    await settle();
    assert.equal(report.status, 'delivering');
    assert.equal(t.wakes(), 2, 'autonomous report consumes its own wake');
  } finally { await t.manager.shutdown(); }
});
