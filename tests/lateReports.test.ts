import assert from 'node:assert/strict';
import test from 'node:test';
import type { PeerMessage } from '../shared/types.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir, settle } from './helpers.ts';

const status = (e: unknown) => (e instanceof HttpError ? e.status : 0);
const report = (id: string, extra: Record<string, unknown> = {}) => ({ message_id: id, outcome: 'done', summary: 'Built it.', evidence: 'npm test: 10 pass', ...extra });

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'acme-web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const fen = await h.manager.create({ name: 'Fen', engine: 'claude', projectId: web.id });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const runner = (id: string) => h.runners.get(id)!.at(-1)!;
  const call = (id: string, tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner(id).ctx.commsToken!, tool, args);
  const mailbox = (h.manager as unknown as { mailbox: { recover(): void } }).mailbox;
  /** The SuperAgent delegates to `to`, ends its turn, and `to` starts working on it. */
  const delegate = async (to: string, task = 'Do the work.') => {
    const request = await call(sup.id, 'delegate_task', { to_agent_id: to, kind: 'implementation', task, acceptance_criteria: 'Done.' }) as PeerMessage;
    if (runner(sup.id).busy) runner(sup.id).complete();
    await settle();
    return request;
  };
  const state = async (requestId: string) => ((await call(sup.id, 'list_delegations', {})) as { messageId: string; state: string }[]).find(d => d.messageId === requestId)?.state;
  return { ...h, ada, fen, sup, runner, call, mailbox, delegate, state };
}

test('a report sent after the turn ended (a background watcher, a late tool call) is delivered and closes the delegation', async () => {
  const t = await team();
  const request = await t.delegate(t.ada.id);
  t.runner(t.ada.id).complete(true, 'Started a background build.');
  await settle();
  assert.equal(await t.state(request.id), 'awaiting_report');
  const sent = await t.call(t.ada.id, 'report_result', report(request.id)) as PeerMessage;
  assert.equal(sent.replyTo, request.id);
  assert.equal(sent.conversationId, request.conversationId, 'in the request\'s own conversation');
  assert.equal(await t.state(request.id), 'done');
  await settle();
  assert.ok(t.runner(t.sup.id).sent.some(s => s.task?.messageId === sent.id), 'delivered to the requester');
});

test('a report for delegation A while handling message B goes to A\'s conversation', async () => {
  const t = await team();
  const a = await t.delegate(t.ada.id, 'Task A.');
  t.runner(t.ada.id).complete(true, 'Working on A in the background.');
  await settle();
  // Fen asks Ada something; Ada is now handling Fen's message (B).
  t.manager.send(t.fen.id, 'Ask Ada.');
  await settle();
  const b = await t.call(t.fen.id, 'send_message', { to_agent_id: t.ada.id, text: 'Where do the tokens live?' }) as PeerMessage;
  t.runner(t.fen.id).complete();
  await settle();
  assert.equal(t.runner(t.ada.id).sent.at(-1)!.task?.messageId, b.id, 'Ada is handling B');
  const sent = await t.call(t.ada.id, 'report_result', report(a.id)) as PeerMessage;
  assert.equal(sent.conversationId, a.conversationId);
  assert.notEqual(sent.conversationId, b.conversationId);
  assert.equal(await t.state(a.id), 'done');
  // And B is still answerable in its own conversation.
  const answer = await t.call(t.ada.id, 'reply', { message_id: b.id, text: 'src/theme.css.' }) as PeerMessage;
  assert.equal(answer.conversationId, b.conversationId);
});

test('a reply to a question after the turn ended is delivered; only once, and only to an open question', async () => {
  const t = await team();
  t.manager.send(t.fen.id, 'Ask Ada.');
  await settle();
  const question = await t.call(t.fen.id, 'send_message', { to_agent_id: t.ada.id, text: 'Where do the tokens live?' }) as PeerMessage;
  t.runner(t.fen.id).complete();
  await settle();
  t.runner(t.ada.id).complete(true, 'Looking.');
  await settle();
  const answer = await t.call(t.ada.id, 'reply', { message_id: question.id, text: 'src/theme.css.' }) as PeerMessage;
  assert.equal(answer.conversationId, question.conversationId);
  // Out of a turn, an answered question is not open any more, and plain sends stay refused.
  await assert.rejects(t.call(t.ada.id, 'reply', { message_id: question.id, text: 'Also this.' }), e => status(e) === 409);
  await assert.rejects(t.call(t.ada.id, 'send_message', { to_agent_id: t.fen.id, text: 'Unsolicited.' }), e => status(e) === 409);
  await assert.rejects(t.call(t.ada.id, 'delegate_task', { to_agent_id: t.fen.id, kind: 'review', task: 'x', acceptance_criteria: 'y' }), e => status(e) === 409);
  await assert.rejects(t.call(t.ada.id, 'post_to_channel', { channel: 'none', text: 'x' }), e => status(e) === 409);
});

test('a delegation still awaiting its report after a restart is closed by its late report', async () => {
  const t = await team();
  const request = await t.delegate(t.ada.id);
  t.runner(t.ada.id).complete(true, 'Building in the background.');
  await settle();
  t.mailbox.recover(); // what a restart does: a finished conversation stays open (fix/comms-stopped-on-boot)
  assert.equal(t.store.conversations.find(c => c.id === request.conversationId)?.stopped, false);
  assert.equal(await t.state(request.id), 'awaiting_report');
  const sent = await t.call(t.ada.id, 'report_result', report(request.id, { outcome: 'blocked' })) as PeerMessage;
  assert.equal(await t.state(request.id), 'blocked');
  await settle();
  assert.notEqual(t.store.messages.find(m => m.id === sent.id)?.status, 'cancelled', 'not dropped by delivery');
  // A plain message into that conversation still needs a turn.
  await assert.rejects(t.call(t.ada.id, 'send_message', { to_agent_id: t.sup.id, text: 'More.' }), e => status(e) === 409);
});

test('protections hold for late answers: a user stop, a stopped agent and a spent budget', async () => {
  const t = await team();
  // A conversation the user stopped stays stopped.
  const stopped = await t.delegate(t.ada.id, 'Stopped task.');
  t.runner(t.ada.id).complete();
  await settle();
  t.manager.stopConversation(stopped.conversationId);
  await assert.rejects(t.call(t.ada.id, 'report_result', report(stopped.id)), e => status(e) === 409);
  assert.equal(t.store.conversations.find(c => c.id === stopped.conversationId)?.stopped, true);

  // A budget that is used up still applies.
  t.manager.updateSettings({ messageLimit: 1 });
  t.manager.send(t.sup.id, 'Again.');
  await settle();
  const spent = await t.delegate(t.fen.id, 'One message only.');
  t.runner(t.fen.id).complete();
  await settle();
  await assert.rejects(t.call(t.fen.id, 'report_result', report(spent.id)), e => status(e) === 409);
  assert.equal(await t.state(spent.id), 'awaiting_report');
});

test('a user Stop of the reporting agent holds for its late report', async () => {
  const t = await team();
  const request = await t.delegate(t.ada.id);
  t.runner(t.ada.id).complete();
  await settle();
  await t.manager.stop(t.ada.id);
  await assert.rejects(t.call(t.ada.id, 'report_result', report(request.id)), e => status(e) === 409 || status(e) === 401);
});

test('older stopped conversations: one an earlier build closed at a restart takes the late report; one the user stopped refuses it', async () => {
  const t = await team();
  // Closed by an earlier build on restart: stopped, no stoppedBy, no cancelled mail. recover reopens it.
  const closed = await t.delegate(t.ada.id, 'Closed at a restart.');
  t.runner(t.ada.id).complete();
  await settle();
  const c1 = t.store.conversations.find(c => c.id === closed.conversationId)!;
  c1.stopped = true;
  delete c1.stoppedBy;
  // Stopped by the user in an earlier build: its queued mail was cancelled. It stays stopped.
  t.manager.send(t.sup.id, 'Next.');
  await settle();
  const userStopped = await t.delegate(t.fen.id, 'Stopped by the user.');
  t.runner(t.fen.id).complete();
  await settle();
  const c2 = t.store.conversations.find(c => c.id === userStopped.conversationId)!;
  c2.stopped = true;
  delete c2.stoppedBy;
  t.store.messages.push({ ...userStopped, id: 'cancelled-1', status: 'cancelled', delegation: undefined, text: 'queued when stopped' });
  t.mailbox.recover();
  await t.call(t.ada.id, 'report_result', report(closed.id));
  assert.equal(await t.state(closed.id), 'done');
  await assert.rejects(t.call(t.fen.id, 'report_result', report(userStopped.id)), e => status(e) === 409);
  assert.equal(c2.stopped, true);
});
