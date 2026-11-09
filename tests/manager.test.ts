import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir, settle } from './helpers.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

async function team() {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  const bo = await h.manager.create({ name: 'Bo', engine: 'codex', projectId: project.id, role: 'reviewer' });
  return { ...h, project, ada, bo };
}

test('turn markers say which prompt each turn runs, even when it was queued mid-turn', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'First');
  h.manager.send(h.ada.id, 'Second');
  const runner = h.runner(h.ada.id);
  assert.equal(runner.sent.length, 1, 'the second message waits behind the first turn');
  runner.complete(true, 'Did the first.');
  await settle();
  assert.equal(runner.sent.length, 2);
  const entries = h.manager.entries(h.ada.id);
  const users = entries.filter(e => e.kind === 'user');
  const markers = entries.filter(e => e.kind === 'turn');
  assert.equal(markers.length, 2);
  assert.equal(markers[0].turn?.entryId, users[0].id);
  assert.equal(markers[1].turn?.entryId, users[1].id);
  // The second prompt was written while the first turn ran; its marker comes after that turn ended.
  const index = (id: string) => entries.findIndex(e => e.id === id);
  const firstDone = entries.findIndex(e => e.kind === 'done');
  assert.ok(index(users[1].id) < firstDone, 'the queued prompt sits inside the first turn');
  assert.ok(index(markers[1].id) > firstDone, 'its turn starts after the first one finished');
});

test('a peer turn is marked with the message it handles', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'Ask Bo');
  const token = h.runner(h.ada.id).ctx.commsToken!;
  const receipt = await h.manager.commsTool(token, 'send_message', { to_agent_id: h.bo.id, text: 'Review it' }) as { id: string };
  await settle();
  const marker = h.manager.entries(h.bo.id).find(e => e.kind === 'turn');
  assert.equal(marker?.turn?.source, 'agent');
  assert.equal(marker?.turn?.messageId, receipt.id);
  assert.ok(h.manager.entries(h.bo.id).some(e => e.id === `peer:${receipt.id}`));
});

test('a user task runs, and the turn result lands in the transcript', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'Add a health check endpoint');
  const runner = h.runner(h.ada.id);
  assert.equal(runner.sent.length, 1);
  assert.match(runner.sent[0].text, /Add a health check endpoint/);
  assert.equal(h.store.agents.get(h.ada.id)?.status, 'working');
  runner.complete(true, 'Added GET /health.\n\nAdded the endpoint and a test.');
  const agent = h.store.agents.get(h.ada.id)!;
  assert.equal(agent.status, 'done');
  assert.equal(agent.lastSummary, 'Added the endpoint and a test.');
  const kinds = h.manager.entries(h.ada.id).map(e => e.kind);
  assert.deepEqual(kinds, ['system', 'user', 'turn', 'done']);
});

test('agents message each other through the comms tools, end to end', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'Ask Bo to review the auth module');
  const ada = h.runner(h.ada.id);
  const adaToken = ada.ctx.commsToken!;
  assert.ok(adaToken, 'each provider process gets a comms token');

  const roster = await h.manager.commsTool(adaToken, 'list_agents', {}) as { id: string; canMessage: boolean }[];
  assert.deepEqual(roster.map(r => [r.id, r.canMessage]), [[h.bo.id, true]]);

  const receipt = await h.manager.commsTool(adaToken, 'send_message', { to_agent_id: h.bo.id, text: 'Please review src/auth.ts' }) as { id: string; status: string };
  assert.equal(receipt.status, 'queued');
  await settle();

  // Bo was idle, so the message starts a turn in Bo's own session right away.
  const bo = h.runner(h.bo.id);
  assert.equal(bo.sent.length, 1);
  assert.equal(bo.sent[0].task?.source, 'agent');
  assert.equal(bo.sent[0].task?.messageId, receipt.id);
  assert.match(bo.sent[0].text, /Please review src\/auth\.ts/);

  const reply = await h.manager.commsTool(bo.ctx.commsToken!, 'reply', { message_id: receipt.id, text: 'Found one issue in token refresh.' }) as { id: string; toAgentId: string };
  assert.equal(reply.toAgentId, h.ada.id);
  bo.complete(true, 'Reviewed auth.');
  await settle();
  assert.equal(h.store.messages.find(m => m.id === receipt.id)?.status, 'delivered');

  // Ada is still busy with the user task, so the reply waits for that turn to end.
  assert.equal(ada.sent.length, 1);
  ada.complete(true, 'Asked Bo.');
  await settle();
  assert.equal(ada.sent.length, 2);
  assert.match(ada.sent[1].text, /Found one issue in token refresh/);

  // Both transcripts show the exchange as peer entries.
  const peerIds = (id: string) => h.manager.entries(id).filter(e => e.kind === 'peer').map(e => e.peer?.id);
  assert.deepEqual(new Set(peerIds(h.ada.id)), new Set([receipt.id, reply.id]));
  assert.deepEqual(new Set(peerIds(h.bo.id)), new Set([receipt.id, reply.id]));
  assert.ok(h.events.some(e => e.type === 'message'));
});

test('comms calls need a live token and an active turn', async () => {
  const h = await team();
  await assert.rejects(h.manager.commsTool('', 'list_agents', {}), e => status(e) === 401);
  await assert.rejects(h.manager.commsTool('made-up', 'list_agents', {}), e => status(e) === 401);
  h.manager.send(h.ada.id, 'Do something');
  const ada = h.runner(h.ada.id);
  const token = ada.ctx.commsToken!;
  await assert.rejects(h.manager.commsTool(token, 'delete_everything', {}), e => status(e) === 400);
  ada.complete();
  await assert.rejects(h.manager.commsTool(token, 'send_message', { to_agent_id: h.bo.id, text: 'late' }), e => status(e) === 409);
  // Reading stays available between turns.
  assert.ok(Array.isArray(await h.manager.commsTool(token, 'read_messages', {})));
});

test('stop retires the token and cancels the collaboration', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'Coordinate with Bo');
  const token = h.runner(h.ada.id).ctx.commsToken!;
  const receipt = await h.manager.commsTool(token, 'send_message', { to_agent_id: h.bo.id, text: 'Start on the parser' }) as { id: string };
  await h.manager.stop(h.ada.id);
  await assert.rejects(h.manager.commsTool(token, 'list_agents', {}), e => status(e) === 401);
  assert.equal(h.store.messages.find(m => m.id === receipt.id)?.status, 'cancelled');
  assert.equal(h.store.agents.get(h.ada.id)?.status, 'idle');
});

test('plan-only agents cannot start conversations', async () => {
  const h = await team();
  await h.manager.update(h.ada.id, { autonomy: 'readonly' });
  h.manager.send(h.ada.id, 'Plan it');
  const token = h.runner(h.ada.id).ctx.commsToken!;
  await assert.rejects(h.manager.commsTool(token, 'send_message', { to_agent_id: h.bo.id, text: 'Implement it' }), e => status(e) === 403);
});

test('set_task_summary updates the visible current task', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'A long request about many things');
  const token = h.runner(h.ada.id).ctx.commsToken!;
  await h.manager.commsTool(token, 'set_task_summary', { summary: 'Owns src/api/*; adding /health' });
  assert.equal(h.store.agents.get(h.ada.id)?.currentTask?.summary, 'Owns src/api/*; adding /health');
});

test('agent names stay unique, and projects with agents cannot be removed', async () => {
  const h = await team();
  await assert.rejects(h.manager.create({ name: 'ada', engine: 'claude', projectId: h.project.id }), e => status(e) === 409);
  assert.throws(() => h.manager.removeProject(h.project.id), e => status(e) === 409);
  await h.manager.remove(h.bo.id);
  await h.manager.remove(h.ada.id);
  h.manager.removeProject(h.project.id);
  assert.equal(h.store.projects.size, 0);
});

test('a restart settles running agents and unfinished mail', async () => {
  const h = await team();
  h.manager.send(h.ada.id, 'Work');
  const token = h.runner(h.ada.id).ctx.commsToken!;
  await h.manager.commsTool(token, 'send_message', { to_agent_id: h.bo.id, text: 'Help' });
  h.store.flush();
  const { Store } = await import('../server/store.ts');
  const { AgentManager } = await import('../server/manager.ts');
  const store = new Store(h.store.dataDir);
  store.load();
  const { FakeRunner } = await import('./helpers.ts');
  const runners: InstanceType<typeof FakeRunner>[] = [];
  const restarted = new AgentManager(store, { broadcast: () => {} }, { claude: { available: true, path: null, version: null }, codex: { available: true, path: null, version: null }, orcacode: { available: true, path: null, version: null } }, {
    createRunner: ctx => { const runner = new FakeRunner(ctx); runners.push(runner); return runner; },
    worktreesRoot: path.join(h.dir, 'worktrees-2'),
  });
  restarted.init();
  assert.equal(store.agents.get(h.ada.id)?.status, 'idle');
  // Ada's message to Bo was not lost: it goes to Bo once the restarted app is up.
  await settle();
  const help = store.messages.find(m => m.text === 'Help')!;
  assert.equal(help.status, 'delivering');
  assert.ok(runners.some(r => r.ctx.agent().id === h.bo.id && r.sent.some(s => s.task?.messageId === help.id)));
});
