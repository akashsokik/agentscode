import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, projectDir } from './helpers.ts';

async function activeAgent() {
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const agent = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id, autonomy: 'ask' });
  h.manager.send(agent.id, 'Work on the app');
  return { ...h, agent, provider: h.runner(agent.id) };
}

test('a rejected access change keeps the previous mode and reports the error', async t => {
  const h = await activeAgent();
  t.after(() => h.manager.shutdown());
  h.provider.setAutonomy = async () => { throw new Error('Claude rejected the permission change.'); };

  await assert.rejects(h.manager.update(h.agent.id, { autonomy: 'edits' }), /Claude rejected the permission change/);

  assert.equal(h.manager.snapshot().agents[0].autonomy, 'ask');
  assert.equal(h.events.some(event => event.type === 'agent' && event.agent.autonomy === 'edits'), false);
});

test('an access change is published only after the provider accepts it', async t => {
  const h = await activeAgent();
  t.after(() => h.manager.shutdown());
  const accepted = Promise.withResolvers<void>();
  h.provider.setAutonomy = async () => accepted.promise;

  const updating = h.manager.update(h.agent.id, { autonomy: 'edits' });
  assert.equal(h.manager.snapshot().agents[0].autonomy, 'ask');

  accepted.resolve();
  assert.equal((await updating).autonomy, 'edits');
  assert.equal(h.manager.snapshot().agents[0].autonomy, 'edits');
});

test('a failed access change can be retried with the same selection', async t => {
  const h = await activeAgent();
  t.after(() => h.manager.shutdown());
  h.provider.setAutonomy = async () => { throw new Error('Permission update failed.'); };
  await assert.rejects(h.manager.update(h.agent.id, { autonomy: 'edits' }), /Permission update failed/);

  let applied: string | undefined;
  h.provider.setAutonomy = async value => { applied = value; };
  await h.manager.update(h.agent.id, { autonomy: 'edits' });

  assert.equal(applied, 'edits');
  assert.equal(h.manager.snapshot().agents[0].autonomy, 'edits');
});

test('an idle agent without a provider stores access for its first turn', async t => {
  const h = harness();
  t.after(() => h.manager.shutdown());
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  const agent = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id, autonomy: 'ask' });

  await h.manager.update(agent.id, { autonomy: 'edits' });
  h.manager.send(agent.id, 'Edit the app');

  assert.equal(h.runner(agent.id).ctx.agent().autonomy, 'edits');
});
