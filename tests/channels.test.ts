import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { Channel, ChannelPost } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { HttpError } from '../server/errors.ts';
import { harness, projectDir, settle } from './helpers.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

/** Ada works on the web app, Bo and Cy on the API: two projects, one channel. */
async function crossProject() {
  const h = harness();
  h.manager.updateSettings({ awareness: 'project' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const api = h.manager.addProject({ path: projectDir(h.dir, 'api') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id, role: 'lead' });
  const bo = await h.manager.create({ name: 'Bo', engine: 'codex', projectId: api.id });
  const cy = await h.manager.create({ name: 'Cy', engine: 'claude', projectId: api.id });
  const channel = h.manager.createChannel({ name: 'Release Prep', topic: 'Ship v2', memberIds: [ada.id, bo.id] });
  const posts = () => h.manager.channelPosts(channel.id);
  const post = (id: string) => posts().find(p => p.id === id)!;
  return { ...h, web, api, ada, bo, cy, channel, posts, post };
}

test('channels get a slug name, unique, and record who created them', async () => {
  const h = await crossProject();
  assert.equal(h.channel.name, 'release-prep');
  assert.throws(() => h.manager.createChannel({ name: '#release-prep', memberIds: [] }), e => status(e) === 409);
  assert.throws(() => h.manager.createChannel({ name: '  ##  ', memberIds: [] }), e => status(e) === 400);
  assert.throws(() => h.manager.createChannel({ name: 'x', memberIds: ['nobody'] }), e => status(e) === 400);
  assert.match(h.posts()[0].text, /You created #release-prep with Ada and Bo/);
  assert.ok(h.events.some(e => e.type === 'channel' && e.channel.id === h.channel.id));
});

test('a user post starts a turn for each mentioned member, across projects, and replies come back', async () => {
  const h = await crossProject();
  const post = h.manager.postToChannel(h.channel.id, '@Ada @Bo agree on the /users contract', [h.ada.id, h.bo.id]);
  const ada = h.runner(h.ada.id);
  const bo = h.runner(h.bo.id);
  assert.equal(ada.sent.length, 1);
  assert.equal(ada.sent[0].task?.source, 'user', 'a channel post is the user\'s own request');
  assert.equal(ada.sent[0].task?.channelPostId, post.id);
  assert.match(ada.sent[0].text, /The user posted this in #release-prep/);
  assert.match(ada.sent[0].text, /to you and Bo/);
  assert.match(ada.sent[0].text, /Bo, id .*Codex, dev, project api/);
  assert.deepEqual(h.post(post.id).to.map(d => d.status), ['working', 'working']);

  // The agent's own transcript shows the post as the user's message, tagged with the channel.
  const userEntry = h.manager.entries(h.ada.id).find(e => e.kind === 'user');
  assert.equal(userEntry?.text, '@Ada @Bo agree on the /users contract');
  assert.deepEqual(userEntry?.channel, { id: h.channel.id, postId: post.id });

  ada.complete(true, 'Proposed GET /users?page=n returning {items, next}.');
  bo.complete(false, 'Codex crashed.');
  const replies = h.posts().filter(p => p.inReplyTo === post.id);
  assert.deepEqual(replies.map(p => [p.fromName, p.kind]), [['Ada', 'reply'], ['Bo', 'error']]);
  assert.equal(post.threadId, undefined);
  assert.ok(replies.every(p => p.threadId === post.id), 'turn replies and errors belong to the original post thread');
  assert.equal(replies[0].text, 'Proposed GET /users?page=n returning {items, next}.');
  assert.deepEqual(h.post(post.id).to.map(d => d.status), ['replied', 'failed']);
  assert.equal(h.store.channels.get(h.channel.id)?.unread, true);
  h.manager.channelSeen(h.channel.id);
  assert.equal(h.store.channels.get(h.channel.id)?.unread, false);
});

test('a post without mentions is a note: it starts nobody, and shows up as context later', async () => {
  const h = await crossProject();
  h.manager.postToChannel(h.channel.id, 'Deploy freeze starts Friday.', []);
  assert.equal(h.runners.size, 0);
  h.manager.postToChannel(h.channel.id, 'Bo, check the migration.', [h.bo.id]);
  assert.equal(h.runners.has(h.ada.id), false, 'only the mentioned member starts');
  assert.match(h.runner(h.bo.id).sent[0].text, /You: Deploy freeze starts Friday\./);
});

test('only members can be mentioned', async () => {
  const h = await crossProject();
  assert.throws(() => h.manager.postToChannel(h.channel.id, 'Cy?', [h.cy.id]), e => status(e) === 400);
  assert.throws(() => h.manager.postToChannel(h.channel.id, '', [h.ada.id]), e => status(e) === 400);
});

test('agents mention each other in a channel whatever the awareness setting, and the asker hears back', async () => {
  const h = await crossProject();
  h.manager.updateSettings({ awareness: 'off' });
  const kickoff = h.manager.postToChannel(h.channel.id, 'Ada, get the API shape from Bo.', [h.ada.id]);
  const ada = h.runner(h.ada.id);
  const adaToken = ada.ctx.commsToken!;

  // Direct messages still follow the awareness setting.
  await assert.rejects(h.manager.commsTool(adaToken, 'send_message', { to_agent_id: h.bo.id, text: 'hi' }), e => status(e) === 403);

  const channels = await h.manager.commsTool(adaToken, 'list_channels', {}) as { name: string; members: { name: string; workspace: string }[] }[];
  assert.equal(channels[0].name, '#release-prep');
  assert.ok(channels[0].members.find(m => m.name === 'Bo')?.workspace.endsWith('/api'));

  const receipt = await h.manager.commsTool(adaToken, 'post_to_channel', {
    channel: '#release-prep', text: 'Bo, what does GET /users return?', mention_agent_ids: [h.bo.id],
  }) as { post_id: string; notified: string[] };
  assert.deepEqual(receipt.notified, ['Bo']);
  await settle();
  const bo = h.runner(h.bo.id);
  assert.equal(bo.sent[0].task?.source, 'agent');
  assert.equal(bo.sent[0].task?.channelPostId, receipt.post_id);
  assert.match(bo.sent[0].text, /channel message from teammate Ada/);
  assert.match(bo.sent[0].text, /You: Ada, get the API shape from Bo\./, 'the backlog gives the context');
  assert.deepEqual(h.post(receipt.post_id).to.map(d => d.status), ['working']);
  // The mention shows in Bo's transcript, not as a second row in Ada's.
  assert.ok(h.manager.entries(h.bo.id).some(e => e.kind === 'peer'));
  assert.ok(!h.manager.entries(h.ada.id).some(e => e.kind === 'peer'));

  ada.complete(true, 'Asked Bo; will continue when he answers.');
  bo.complete(true, '{ items: User[], next: string | null }');
  await settle();
  const boReply = h.posts().find(p => p.inReplyTo === receipt.post_id)!;
  assert.equal(boReply.fromName, 'Bo');
  assert.deepEqual(boReply.to.map(d => [d.name, d.status]), [['Ada', 'working']], 'Ada is woken with the answer');
  assert.equal(ada.sent.length, 2);
  assert.match(ada.sent[1].text, /Bo answered your earlier mention/);
  assert.match(ada.sent[1].text, /items: User\[\]/);

  ada.complete(true, 'Wired the client to the new shape.');
  await settle();
  const adaFinal = h.posts().find(p => p.inReplyTo === boReply.id)!;
  assert.equal(adaFinal.text, 'Wired the client to the new shape.');
  assert.equal(h.post(receipt.post_id).threadId, kickoff.id);
  assert.equal(boReply.threadId, kickoff.id);
  assert.equal(adaFinal.threadId, kickoff.id, 'answering a reply keeps the original thread root');
  assert.deepEqual(adaFinal.to, [], 'an answer to an answer wakes nobody');
  assert.equal(h.runner(h.bo.id).sent.length, 1);
  assert.equal(h.posts().filter(p => p.inReplyTo === kickoff.id && p.kind === 'reply').length, 1, 'the kickoff got one final reply');
});

test('agent posts without mentions start nobody; plan-only agents cannot start teammates', async () => {
  const h = await crossProject();
  await h.manager.update(h.ada.id, { autonomy: 'readonly' });
  h.manager.postToChannel(h.channel.id, 'Ada, look around.', [h.ada.id]);
  const token = h.runner(h.ada.id).ctx.commsToken!;
  await h.manager.commsTool(token, 'post_to_channel', { channel: h.channel.id, text: 'FYI: the schema lives in db/schema.sql' });
  await settle();
  assert.equal(h.runners.has(h.bo.id), false);
  await assert.rejects(h.manager.commsTool(token, 'post_to_channel', { channel: h.channel.id, text: 'Bo, do it', mention_agent_ids: [h.bo.id] }), e => status(e) === 403);
  await assert.rejects(h.manager.commsTool(token, 'post_to_channel', { channel: h.channel.id, text: 'Cy?', mention_agent_ids: [h.cy.id] }), e => status(e) === 403);
  const other = h.manager.createChannel({ name: 'secret', memberIds: [h.bo.id] });
  await assert.rejects(h.manager.commsTool(token, 'read_channel', { channel: other.id }), e => status(e) === 403);
  const read = await h.manager.commsTool(token, 'read_channel', { channel: 'release-prep', limit: 5 }) as { posts: { from: string; text: string }[] };
  assert.equal(read.posts.at(-1)?.text, 'FYI: the schema lives in db/schema.sql');
});

test('agents cannot mention non-members or themselves', async () => {
  const h = await crossProject();
  h.manager.postToChannel(h.channel.id, 'Ada, start.', [h.ada.id]);
  const token = h.runner(h.ada.id).ctx.commsToken!;
  await assert.rejects(h.manager.commsTool(token, 'post_to_channel', { channel: h.channel.id, text: 'Cy?', mention_agent_ids: [h.cy.id] }), e => status(e) === 400);
  await assert.rejects(h.manager.commsTool(token, 'post_to_channel', { channel: h.channel.id, text: 'Me', mention_agent_ids: [h.ada.id] }), e => status(e) === 400);
});

test('the reply tool on a mention answers in the channel, and the final reply does not answer twice', async () => {
  const h = await crossProject();
  h.manager.postToChannel(h.channel.id, 'Ada, ask Bo.', [h.ada.id]);
  const ada = h.runner(h.ada.id);
  const receipt = await h.manager.commsTool(ada.ctx.commsToken!, 'post_to_channel', { channel: h.channel.id, text: 'Port?', mention_agent_ids: [h.bo.id] }) as { post_id: string };
  await settle();
  const bo = h.runner(h.bo.id);
  const messageId = bo.sent[0].task!.messageId!;
  const answer = await h.manager.commsTool(bo.ctx.commsToken!, 'reply', { message_id: messageId, text: 'Port 8080.' }) as { post_id: string; notified: string[] };
  assert.deepEqual(answer.notified, ['Ada']);
  assert.equal(h.post(answer.post_id).inReplyTo, receipt.post_id);
  assert.equal(h.post(answer.post_id).threadId, h.post(receipt.post_id).threadId);
  bo.complete(true, 'Answered Ada.');
  await settle();
  const final = h.posts().filter(p => p.fromName === 'Bo' && p.kind === 'reply')[0];
  assert.deepEqual(final.to, [], 'the final reply is posted, but Ada was already told');
  assert.equal(h.store.messages.filter(m => m.toAgentId === h.ada.id).length, 1);
  // Channel replies stay out of the Comms threads' direct-message flow.
  assert.ok(h.store.messages.every(m => m.channelId === h.channel.id));
});

test('a reply over budget still posts once, and reports the failed delivery instead of throwing', async () => {
  const h = await crossProject();
  h.manager.updateSettings({ messageLimit: 1 });
  h.manager.postToChannel(h.channel.id, 'Ada, ask Bo.', [h.ada.id]);
  await h.manager.commsTool(h.runner(h.ada.id).ctx.commsToken!, 'post_to_channel', { channel: h.channel.id, text: 'Port?', mention_agent_ids: [h.bo.id] });
  await settle();
  const bo = h.runner(h.bo.id);
  const result = await h.manager.commsTool(bo.ctx.commsToken!, 'reply', { message_id: bo.sent[0].task!.messageId!, text: 'Port 8080.' }) as { post_id: string; notified: string[]; failed: { error: string }[] };
  assert.deepEqual(result.notified, []);
  assert.match(result.failed[0].error, /budget/);
  assert.equal(h.posts().filter(p => p.text === 'Port 8080.').length, 1);
  assert.equal(h.post(result.post_id).to[0].status, 'failed');
});

test('the message budget ends a ping-pong between two agents', async () => {
  const h = await crossProject();
  h.manager.updateSettings({ messageLimit: 2 });
  h.manager.postToChannel(h.channel.id, 'Ada, talk to Bo.', [h.ada.id]);
  const ada = h.runner(h.ada.id);
  await h.manager.commsTool(ada.ctx.commsToken!, 'post_to_channel', { channel: h.channel.id, text: 'Ping', mention_agent_ids: [h.bo.id] });
  await settle();
  const bo = h.runner(h.bo.id);
  await h.manager.commsTool(bo.ctx.commsToken!, 'post_to_channel', { channel: h.channel.id, text: 'Pong', mention_agent_ids: [h.ada.id], expects_reply: false });
  const third = await h.manager.commsTool(bo.ctx.commsToken!, 'post_to_channel', { channel: h.channel.id, text: 'Ping again', mention_agent_ids: [h.ada.id] }) as { notified: string[]; failed: { error: string }[] };
  assert.deepEqual(third.notified, []);
  assert.match(third.failed[0].error, /budget/);
  bo.complete(true, 'Done.');
  await settle();
  const final = h.posts().filter(p => p.fromName === 'Bo' && p.kind === 'reply')[0];
  assert.equal(final.to[0]?.status, 'failed', 'the automatic answer is also over budget');
});

test('approval requests and stops show up on the channel post', async () => {
  const h = await crossProject();
  const post = h.manager.postToChannel(h.channel.id, 'Ada and Bo, go.', [h.ada.id, h.bo.id]);
  const ada = h.runner(h.ada.id);
  const controller = new AbortController();
  void ada.ctx.hooks.approval({ type: 'tool', toolName: 'Bash', title: 'Run npm install?', detail: '', description: '', canAlwaysAllow: true }, controller.signal);
  void ada.ctx.hooks.approval({ type: 'tool', toolName: 'Bash', title: 'Run npm test?', detail: '', description: '', canAlwaysAllow: true }, controller.signal);
  const notices = h.posts().filter(p => p.kind === 'needs_you');
  assert.deepEqual(notices.map(p => p.text), ['Run npm install?'], 'only the first request of a turn is posted');
  assert.equal(notices[0].threadId, post.id);
  await h.manager.stop(h.bo.id);
  assert.equal(h.post(post.id).to.find(d => d.agentId === h.bo.id)?.status, 'stopped');
  controller.abort();
});

test('removing an agent drops its memberships and settles its deliveries', async () => {
  const h = await crossProject();
  const post = h.manager.postToChannel(h.channel.id, 'Bo, go.', [h.bo.id]);
  await h.manager.remove(h.bo.id);
  assert.deepEqual(h.store.channels.get(h.channel.id)?.memberIds, [h.ada.id]);
  assert.equal(h.post(post.id).to[0].status, 'stopped');
  assert.match(h.posts().at(-1)!.text, /Bo was removed/);
});

test('members can be added and removed; queued mentions to a removed member are cancelled', async () => {
  const h = await crossProject();
  h.manager.postToChannel(h.channel.id, 'Ada, start.', [h.ada.id]);
  h.manager.send(h.bo.id, 'Busy with something else');
  const receipt = await h.manager.commsTool(h.runner(h.ada.id).ctx.commsToken!, 'post_to_channel', { channel: h.channel.id, text: 'Bo?', mention_agent_ids: [h.bo.id] }) as { post_id: string };
  await settle();
  const updated = h.manager.updateChannel(h.channel.id, { memberIds: [h.ada.id, h.cy.id], topic: 'Ship v2.1' });
  assert.deepEqual(updated.memberIds, [h.ada.id, h.cy.id]);
  assert.equal(h.post(receipt.post_id).to[0].status, 'stopped');
  assert.ok(h.posts().some(p => p.text === 'You added Cy.'));
  assert.ok(h.posts().some(p => p.text === 'You removed Bo.'));
  assert.ok(h.posts().some(p => p.text === 'You set the topic: Ship v2.1'));
});

test('a channel cannot be deleted while members work on it', async () => {
  const h = await crossProject();
  h.manager.postToChannel(h.channel.id, 'Ada, go.', [h.ada.id]);
  assert.throws(() => h.manager.removeChannel(h.channel.id), e => status(e) === 409);
  h.runner(h.ada.id).complete();
  h.manager.removeChannel(h.channel.id);
  assert.equal(h.store.channels.size, 0);
  assert.throws(() => h.manager.channelPosts(h.channel.id), e => status(e) === 404);
  assert.ok(h.events.some(e => e.type === 'channelRemoved'));
});

test('a restart fails deliveries that were in flight, and keeps the history', async () => {
  const h = await crossProject();
  const post = h.manager.postToChannel(h.channel.id, 'Ada, go.', [h.ada.id]);
  h.store.flush();
  const { Store } = await import('../server/store.ts');
  const { AgentManager } = await import('../server/manager.ts');
  const store = new Store(h.store.dataDir);
  store.load();
  const restarted = new AgentManager(store, { broadcast: () => {} }, { claude: { available: true, path: null, version: null }, codex: { available: true, path: null, version: null }, orcacode: { available: true, path: null, version: null } });
  restarted.init();
  const after = restarted.channelPosts(h.channel.id).find(p => p.id === post.id)!;
  assert.equal(after.to[0].status, 'failed');
  assert.match(after.to[0].error ?? '', /restarted/);
  assert.equal(restarted.snapshot().channels[0].name, 'release-prep');
});

test('the channel API creates, posts, lists and deletes', async () => {
  const h = await crossProject();
  const server = createApp(h.manager, undefined, undefined, OPEN_AUTH).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown) => fetch(base + path, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const created = await call('POST', '/api/channels', { name: 'design', memberIds: [h.cy.id] });
    assert.equal(created.status, 201);
    const channel = await created.json() as Channel;
    const posted = await call('POST', `/api/channels/${channel.id}/posts`, { text: 'Cy, sketch it', mentions: [h.cy.id] });
    assert.equal(posted.status, 201);
    const root = await posted.json() as ChannelPost;
    const list = await (await call('GET', `/api/channels/${channel.id}/posts`)).json() as ChannelPost[];
    assert.equal(list.at(-1)?.text, 'Cy, sketch it');
    const reply = await call('POST', `/api/channels/${channel.id}/posts`, { text: 'Use the existing palette.', mentions: [], threadId: root.id });
    assert.equal(reply.status, 201);
    const first = await reply.json() as ChannelPost;
    assert.equal(first.threadId, root.id);
    assert.equal(first.inReplyTo, root.id);
    const nested = await call('POST', `/api/channels/${channel.id}/posts`, { text: 'And the existing type.', threadId: first.id });
    const second = await nested.json() as ChannelPost;
    assert.equal(second.threadId, root.id);
    assert.equal(second.inReplyTo, first.id);
    const invalid = [h.posts()[0].id, list[0].id, 'missing-post', 12, null, ''];
    for (const threadId of invalid) {
      const bad = await call('POST', `/api/channels/${channel.id}/posts`, { text: 'Invalid thread', threadId });
      assert.equal(bad.status, 400);
      assert.match((await bad.json() as { error: string }).error, /thread|message/i);
    }
    assert.equal((await call('PATCH', `/api/channels/${channel.id}`, { name: 'design' })).status, 200);
    assert.equal((await call('POST', `/api/channels/${channel.id}/seen`)).status, 200);
    assert.equal((await call('DELETE', `/api/channels/${channel.id}`)).status, 409, 'Cy is still working on it');
    h.runner(h.cy.id).complete();
    assert.equal((await call('DELETE', `/api/channels/${channel.id}`)).status, 204);
    assert.equal((await call('GET', `/api/channels/${channel.id}/posts`)).status, 404);
  } finally {
    server.close();
  }
});

test('thread replies normalize any parent to the root and retain the exact parent', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'Release checklist', []);
  const first = h.manager.postToChannel(h.channel.id, 'Check migrations', [], root.id);
  const nested = h.manager.postToChannel(h.channel.id, 'Migration checked', [], first.id);

  assert.equal(root.threadId, undefined);
  assert.equal(first.threadId, root.id);
  assert.equal(first.inReplyTo, root.id);
  assert.equal(nested.threadId, root.id);
  assert.equal(nested.inReplyTo, first.id);
  assert.equal(h.runners.size, 0, 'thread notes without mentions start no agents');
});

test('thread references reject missing posts, other channels, events and invalid values without posting', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const other = h.manager.createChannel({ name: 'other', memberIds: [] });
  const outside = h.manager.postToChannel(other.id, 'A different conversation', []);
  const before = h.posts().length;
  for (const threadId of ['missing', outside.id, h.posts()[0].id, '', 12, null, {}]) {
    assert.throws(() => h.manager.postToChannel(h.channel.id, 'Reply', [], threadId), e => status(e) === 400);
  }
  assert.equal(h.posts().length, before);
});

test('a user mention in a thread gets the thread context and replies to that exact post', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'Release checklist', []);
  const first = h.manager.postToChannel(h.channel.id, 'Check migrations', [], root.id);
  const other = h.manager.postToChannel(h.channel.id, 'Design checklist', []);
  h.manager.postToChannel(h.channel.id, 'Unrelated thread detail', [], other.id);
  for (let i = 0; i < 25; i++) h.manager.postToChannel(h.channel.id, `Recent channel note ${i}`, []);
  const request = h.manager.postToChannel(h.channel.id, '@Ada verify the migration', [h.ada.id], first.id);
  const runner = h.runner(h.ada.id);
  const prompt = runner.sent[0].text;

  assert.match(prompt, new RegExp(`thread ${root.id}`));
  assert.match(prompt, /Release checklist/);
  assert.match(prompt, /Check migrations/);
  assert.match(prompt, /Recent channel note 24/);
  assert.doesNotMatch(prompt, /Unrelated thread detail/);
  assert.match(prompt, /final reply is posted back to (?:this|the) thread automatically/);
  runner.complete(true, 'Migration verified.');
  const result = h.posts().find(p => p.inReplyTo === request.id)!;
  assert.equal(result.threadId, root.id);
});

test('post_to_channel defaults to the active thread only in the same channel and validates explicit threads', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const other = h.manager.createChannel({ name: 'design', memberIds: [h.ada.id, h.bo.id] });
  const otherRoot = h.manager.postToChannel(other.id, 'Design notes', []);
  const root = h.manager.postToChannel(h.channel.id, '@Ada review the release', [h.ada.id]);
  const token = h.runner(h.ada.id).ctx.commsToken!;
  const post = (args: Record<string, unknown>) => h.manager.commsTool(token, 'post_to_channel', { channel: h.channel.id, ...args }) as Promise<{ post_id: string; thread_id?: string }>;

  const implicit = await post({ text: 'Checking now.' });
  assert.equal(h.post(implicit.post_id).threadId, root.id);
  assert.equal(h.post(implicit.post_id).inReplyTo, root.id);
  assert.equal(implicit.thread_id, root.id);
  const explicit = await post({ text: 'A follow-up', thread_id: implicit.post_id });
  assert.equal(h.post(explicit.post_id).threadId, root.id);
  assert.equal(h.post(explicit.post_id).inReplyTo, implicit.post_id);
  const outside = await post({ channel: other.id, text: 'Separate topic' });
  assert.equal(h.manager.channelPosts(other.id).find(p => p.id === outside.post_id)?.threadId, undefined);
  const override = await post({ channel: other.id, text: 'In a different thread', thread_id: otherRoot.id });
  assert.equal(override.thread_id, otherRoot.id);
  for (const thread_id of ['missing', otherRoot.id, h.posts()[0].id, '', null, 12]) {
    await assert.rejects(post({ text: 'Invalid thread', thread_id }), e => status(e) === 400);
  }
});

test('a mentioned agent and the reply tool keep the originating thread in their prompts and posts', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'Release checklist', []);
  const request = h.manager.postToChannel(h.channel.id, '@Ada ask Bo about migrations', [h.ada.id], root.id);
  const ada = h.runner(h.ada.id);
  const mention = await h.manager.commsTool(ada.ctx.commsToken!, 'post_to_channel', {
    channel: h.channel.id, text: 'Bo, check the migration.', mention_agent_ids: [h.bo.id],
  }) as { post_id: string };
  await settle();
  const bo = h.runner(h.bo.id);
  assert.match(bo.sent[0].text, new RegExp(`thread ${root.id}`));
  assert.match(bo.sent[0].text, /Release checklist/);
  assert.match(bo.sent[0].text, /final reply is posted back to (?:this|the) thread automatically/);
  assert.equal(h.post(mention.post_id).inReplyTo, request.id);
  const answer = await h.manager.commsTool(bo.ctx.commsToken!, 'reply', {
    message_id: bo.sent[0].task!.messageId!, text: 'Migration checked.',
  }) as { post_id: string };
  assert.equal(h.post(answer.post_id).threadId, root.id);
  assert.equal(h.post(answer.post_id).inReplyTo, mention.post_id);
});

test('read_channel exposes thread metadata and can return one thread from any reply id', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'Release checklist', []);
  const first = h.manager.postToChannel(h.channel.id, 'Check migrations', [], root.id);
  const second = h.manager.postToChannel(h.channel.id, 'Migration checked', [], first.id);
  const other = h.manager.postToChannel(h.channel.id, 'Another topic', []);
  h.manager.send(h.ada.id, 'Read the channel');
  const token = h.runner(h.ada.id).ctx.commsToken!;
  type ReadPost = { id: string; thread_id?: string; reply_count?: number };
  const read = (args: Record<string, unknown> = {}) => h.manager.commsTool(token, 'read_channel', { channel: h.channel.id, ...args }) as Promise<{ posts: ReadPost[]; thread_id?: string }>;
  const all = await read();
  assert.equal(all.posts.find(p => p.id === root.id)?.reply_count, 2);
  assert.equal(all.posts.find(p => p.id === first.id)?.thread_id, root.id);
  assert.equal(all.posts.find(p => p.id === other.id)?.reply_count, 0);
  const thread = await read({ thread: second.id });
  assert.equal(thread.thread_id, root.id);
  assert.deepEqual(thread.posts.map(p => p.id), [root.id, first.id, second.id]);
  assert.deepEqual((await read({ thread: root.id, limit: 2 })).posts.map(p => p.id), [root.id, second.id]);
  assert.deepEqual((await read({ thread: root.id, limit: 1 })).posts.map(p => p.id), [root.id]);
  await assert.rejects(read({ thread: 'missing' }), e => status(e) === 400);
});

test('recover backfills legacy reply chains to their root and persists the migration', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'Old channel post', []);
  const legacy: ChannelPost = { id: 'old-reply', channelId: h.channel.id, ts: root.ts + 1, from: 'agent', agentId: h.ada.id, fromName: 'Ada', kind: 'reply', text: 'Old reply', to: [], inReplyTo: root.id };
  const nested: ChannelPost = { ...legacy, id: 'old-nested', ts: root.ts + 2, text: 'Old answer to a reply', inReplyTo: legacy.id };
  h.store.savePost(nested); // The migration also handles parents that occur later in a legacy file.
  h.store.savePost(legacy);
  h.store.flush();
  const { Store } = await import('../server/store.ts');
  const { AgentManager } = await import('../server/manager.ts');
  const store = new Store(h.store.dataDir);
  store.load();
  const restarted = new AgentManager(store, { broadcast: () => {} }, { claude: { available: true, path: null, version: null }, codex: { available: true, path: null, version: null }, orcacode: { available: true, path: null, version: null } });
  t.after(() => restarted.shutdown());
  restarted.init();
  assert.equal(restarted.channelPosts(h.channel.id).find(p => p.id === legacy.id)?.threadId, root.id);
  const after = restarted.channelPosts(h.channel.id).find(p => p.id === nested.id)!;
  assert.equal(after.threadId, root.id);
  assert.equal(after.inReplyTo, legacy.id);
  store.flush();
  const reloaded = new Store(h.store.dataDir);
  reloaded.load();
  assert.equal(reloaded.posts.get(h.channel.id)?.find(p => p.id === nested.id)?.threadId, root.id);
});

test('the recent posts window includes roots of the replies it returns', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'An older topic', []);
  for (let i = 0; i < 305; i++) h.manager.postToChannel(h.channel.id, `Newer topic ${i}`, []);
  const reply = h.manager.postToChannel(h.channel.id, 'An update on the older topic', [], root.id);
  const recent = h.manager.channelPosts(h.channel.id);
  assert.equal(recent.length, 301);
  assert.equal(recent[0].id, root.id);
  assert.equal(recent.at(-1)?.id, reply.id);
});

test('thread roots survive the memory limit and a reload while their replies are recent', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'An older active topic', []);
  h.manager.postToChannel(h.channel.id, 'First update', [], root.id);
  for (let i = 0; i < 900; i++) h.manager.postToChannel(h.channel.id, `Other topic ${i}`, []);
  h.manager.postToChannel(h.channel.id, 'Recent update', [], root.id);
  for (let i = 0; i < 150; i++) h.manager.postToChannel(h.channel.id, `Newer topic ${i}`, []);
  assert.ok(h.manager.channelPosts(h.channel.id).some(p => p.id === root.id));
  const reply = h.manager.postToChannel(h.channel.id, 'Still in this thread', [], root.id);
  assert.equal(reply.threadId, root.id);
  h.store.flush();
  const { Store } = await import('../server/store.ts');
  const loaded = new Store(h.store.dataDir);
  loaded.load();
  assert.ok(loaded.posts.get(h.channel.id)?.some(p => p.id === root.id));
  assert.equal(loaded.posts.get(h.channel.id)?.find(p => p.id === reply.id)?.threadId, root.id);
});

test('legacy migration finds roots outside the memory window and persists past a torn last line', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const root = h.manager.postToChannel(h.channel.id, 'Historical root', []);
  for (let i = 0; i < 1005; i++) h.manager.postToChannel(h.channel.id, `Later topic ${i}`, []);
  const legacy: ChannelPost = { id: 'legacy-recent', channelId: h.channel.id, ts: Date.now(), from: 'agent', agentId: h.ada.id, fromName: 'Ada', kind: 'reply', text: 'Recent legacy reply', to: [], inReplyTo: root.id };
  h.store.savePost(legacy);
  h.store.flush();
  const file = path.join(h.store.dataDir, 'channels', `${h.channel.id}.jsonl`);
  fs.appendFileSync(file, '{"id":"torn');
  const { Store } = await import('../server/store.ts');
  const loaded = new Store(h.store.dataDir);
  loaded.load();
  assert.equal(loaded.posts.get(h.channel.id)?.find(p => p.id === legacy.id)?.threadId, root.id);
  assert.ok(loaded.posts.get(h.channel.id)?.some(p => p.id === root.id));
  const size = fs.statSync(file).size;
  const again = new Store(h.store.dataDir);
  again.load();
  assert.equal(again.posts.get(h.channel.id)?.find(p => p.id === legacy.id)?.threadId, root.id);
  assert.equal(fs.statSync(file).size, size, 'backfilling the same file twice appends no more updates');
});

test('invalid legacy reply chains do not cross channels or loop during migration', async t => {
  const h = await crossProject();
  t.after(() => h.manager.shutdown());
  const other = h.manager.createChannel({ name: 'other', memberIds: [] });
  const outside = h.manager.postToChannel(other.id, 'Another channel', []);
  const base: ChannelPost = { id: 'cycle-a', channelId: h.channel.id, ts: Date.now(), from: 'agent', agentId: h.ada.id, fromName: 'Ada', kind: 'reply', text: 'Legacy reply', to: [], inReplyTo: 'cycle-b' };
  const broken = [base, { ...base, id: 'cycle-b', inReplyTo: base.id }, { ...base, id: 'cross-channel', inReplyTo: outside.id }, { ...base, id: 'event-reply', inReplyTo: h.posts()[0].id }];
  for (const post of broken) h.store.savePost(post);
  h.store.flush();
  const { Store } = await import('../server/store.ts');
  const loaded = new Store(h.store.dataDir);
  loaded.load();
  for (const post of broken) {
    assert.equal(loaded.posts.get(h.channel.id)?.find(p => p.id === post.id)?.threadId, undefined);
    assert.throws(() => h.manager.postToChannel(h.channel.id, 'Reply', [], post.id), e => status(e) === 400);
  }
});
