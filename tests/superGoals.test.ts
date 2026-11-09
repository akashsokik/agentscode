import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { SuperState } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { HttpError } from '../server/errors.ts';
import { SuperStore, updatePrompt, type SuperWatcher } from '../server/superAgent.ts';
import { goalSections } from '../web/superText.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

test('the goal store: add in order, update with links and done times, reorder, remove, restore; written to super.json', () => {
  const dir = tempDir('goals');
  const store = new SuperStore(dir);
  const a = store.addGoal({ text: '  Ship   dark mode ', projectId: 'web', by: 'user' });
  const b = store.addGoal({ text: 'Write release notes', projectId: null, by: 'super' });
  const c = store.addGoal({ text: 'Fix the flaky test', projectId: null, by: 'user' });
  assert.equal(a.text, 'Ship dark mode');
  assert.deepEqual(store.goals().map(g => [g.text, g.order, g.status]), [['Ship dark mode', 0, 'queued'], ['Write release notes', 1, 'queued'], ['Fix the flaky test', 2, 'queued']]);
  assert.throws(() => store.addGoal({ text: 'Ship dark mode', projectId: null, by: 'user' }), e => status(e) === 409);
  assert.throws(() => store.addGoal({ text: '   ', projectId: null, by: 'user' }), e => status(e) === 400);

  const started = store.updateGoal(a.id, { status: 'in_progress', agentId: 'ada', delegationId: 'm1', notes: 'Ada is on it' });
  assert.equal(started.agentId, 'ada');
  assert.equal(started.delegationId, 'm1');
  const finished = store.updateGoal(a.id, { status: 'done' });
  assert.ok(finished.doneAt);
  assert.equal(store.updateGoal(a.id, { status: 'queued', agentId: '' }).doneAt, undefined, 'reopening clears the done time');
  assert.equal(store.goal(a.id).agentId, undefined, 'an empty link is removed');
  assert.throws(() => store.updateGoal(a.id, { status: 'later' as never }), e => status(e) === 400);

  // Reopened, it went to the end; then the flaky test moves to the top.
  assert.deepEqual(store.goals().map(g => g.text), ['Write release notes', 'Fix the flaky test', 'Ship dark mode']);
  store.moveGoal(c.id, 0);
  assert.deepEqual(store.goals().filter(g => g.status !== 'done').map(g => g.text), ['Fix the flaky test', 'Write release notes', 'Ship dark mode']);
  const removed = store.removeGoal(b.id);
  store.restoreGoal(b.id, removed);
  assert.ok(store.goals().some(g => g.id === b.id), 'undo puts a removed goal back');
  store.restoreGoal(b.id, null);
  assert.ok(!store.goals().some(g => g.id === b.id));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'super.json'), 'utf8')) as { goals: unknown[] };
  assert.equal(saved.goals.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'super.json.tmp')), 'written through a temporary file');
  assert.deepEqual(goalSections(store.goals()).open.map(g => g.order), [0, 1]);
});

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const api = h.manager.addProject({ path: projectDir(h.dir, 'api') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const bo = await h.manager.create({ name: 'Bo', engine: 'claude', projectId: api.id });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const runner = h.runner(sup.id);
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner.ctx.commsToken!, tool, args);
  const watcher = (h.manager as unknown as { watcher: SuperWatcher }).watcher;
  return { ...h, web, api, ada, bo, sup, runner, call, watcher };
}

test('the goal tools: add, list, start with links, complete; each in the decision log, and undoable', async () => {
  const t = await team();
  const { added } = await t.call('add_goal', { text: 'Ship dark mode', project: 'WEB', why: 'The user asked for it.' }) as { added: { id: string; projectId: string; by: string } };
  assert.equal(added.projectId, t.web.id);
  assert.equal(added.by, 'super');
  await assert.rejects(t.call('add_goal', { text: 'X', project: 'mobile', why: 'x' }), e => status(e) === 404);
  const { goals } = await t.call('list_goals', {}) as { goals: { id: string }[] };
  assert.deepEqual(goals.map(g => g.id), [added.id]);

  await t.call('update_goal', { goal_id: added.id, status: 'in_progress', agent_id: 'ada', delegation_id: 'msg-1', why: 'Ada is free.' });
  let goal = t.manager.superView().goals[0];
  assert.equal(goal.status, 'in_progress');
  assert.equal(goal.agentId, t.ada.id);
  assert.match(t.manager.superView().log[0].summary, /in progress, given to Ada/);
  await t.call('complete_goal', { goal_id: added.id, notes: 'Merged after review.', why: 'Ada reported it passed.' });
  goal = t.manager.superView().goals[0];
  assert.equal(goal.status, 'done');
  assert.equal(goal.notes, 'Merged after review.');

  // Undo, as the user: completing goes back to in progress, then adding goes away.
  const [completed, started, add] = t.manager.superView().log;
  assert.equal(completed.tool, 'complete_goal');
  await t.manager.undoSuper(completed.id);
  assert.equal(t.manager.superView().goals[0].status, 'in_progress');
  await t.manager.undoSuper(started.id);
  assert.equal(t.manager.superView().goals[0].status, 'queued');
  await t.manager.undoSuper(add.id);
  assert.equal(t.manager.superView().goals.length, 0);

  // Only the SuperAgent has them.
  t.manager.send(t.ada.id, 'Go.');
  await settle();
  await assert.rejects(t.manager.commsTool(t.runners.get(t.ada.id)!.at(-1)!.ctx.commsToken!, 'add_goal', { text: 'Mine', why: 'x' }), e => status(e) === 403);
});

test('an agent coming free with queued goals wakes the SuperAgent, but only through the wake checks', async () => {
  const t = await team();
  t.runner.complete();
  t.manager.addGoal({ text: 'Write the release notes', projectId: t.web.id });
  t.manager.send(t.ada.id, 'Fix the header.');
  await settle();
  t.runners.get(t.ada.id)!.at(-1)!.complete(true, 'Fixed it.');
  assert.ok(t.watcher.waiting() >= 2, 'the new goal and the free agent are both news');

  // Quiet hours around now: nothing goes.
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  t.manager.updateSettings({ superQuietFrom: hhmm(new Date(Date.now() - 3_600_000)), superQuietTo: hhmm(new Date(Date.now() + 3_600_000)) });
  assert.equal(t.watcher.flush(), false);
  t.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  // No hourly budget: nothing goes.
  t.manager.updateSettings({ superMaxWakesPerHour: 0 });
  assert.equal(t.watcher.blocked(), 'the hourly budget is used');
  assert.equal(t.watcher.flush(), false);
  // Wake-ups off: nothing goes.
  t.manager.updateSettings({ superMaxWakesPerHour: 6, superWake: false });
  assert.equal(t.watcher.flush(), false);
  t.manager.updateSettings({ superWake: true });

  assert.equal(t.watcher.flush(), true);
  await settle();
  const sent = t.runner.sent.at(-1)!;
  assert.equal(sent.task?.source, 'system');
  assert.match(sent.text, /Ada is free and 1 queued goal waits/);
  assert.match(sent.text, /Open goals, in order[^\n]*\n1\. \[\w+\] queued: Write the release notes/);
  assert.match(sent.text, /The user added a goal: "Write the release notes"/);

  // With no queued goals, a free agent is ordinary news, with no goal line.
  t.runner.complete();
  t.manager.updateGoal(t.manager.superView().goals[0].id, { status: 'done' });
  t.manager.send(t.bo.id, 'Go.');
  await settle();
  t.runners.get(t.bo.id)!.at(-1)!.complete(true, 'Done.');
  assert.ok(t.watcher.flush());
  await settle();
  assert.doesNotMatch(t.runner.sent.at(-1)!.text, /queued goal|Open goals/);
});

test('the update prompt lists open goals briefly, top down, and leaves done ones out', () => {
  const goal = (id: string, order: number, status: 'queued' | 'in_progress' | 'done') => ({ id, text: `Goal ${id}`, projectId: null, status, order, createdAt: 0, updatedAt: 0, by: 'user' as const });
  const goals = [goal('a', 1, 'queued'), goal('b', 0, 'in_progress'), goal('c', 2, 'done'), ...Array.from({ length: 9 }, (_, i) => goal(`x${i}`, 3 + i, 'queued'))];
  const prompt = updatePrompt([], [], 0, goals);
  assert.match(prompt, /1\. \[a\] queued: Goal a/);
  assert.match(prompt, /2\. \[b\] in_progress: Goal b/);
  assert.doesNotMatch(prompt, /Goal c/);
  assert.match(prompt, /\(3 more; list_goals has them all\)/);
  assert.doesNotMatch(updatePrompt([], [], 0, []), /Open goals/);
});

test('the SuperAgent messages any agent, whatever the team settings; other agents keep their rules', async () => {
  const t = await team();
  t.manager.updateSettings({ awareness: 'off' });
  const listed = await t.call('list_agents', {}) as { name: string; canMessage: boolean }[];
  assert.ok(listed.filter(a => a.name === 'Ada' || a.name === 'Bo').every(a => a.canMessage), 'read-only, yet it can message everyone');
  await t.call('send_message', { to_agent_id: t.ada.id, text: 'Can you take the release notes?' });
  // Even an agent the user paused.
  await t.manager.stop(t.bo.id);
  await t.call('send_message', { to_agent_id: t.bo.id, text: 'Pick this back up when you can.' });
  // Many messages of its own never run out of one collaboration's budget.
  for (let i = 0; i < 15; i++) await t.call('send_message', { to_agent_id: t.ada.id, text: `Nudge ${i}` });
  // Ada, in her project, still cannot reach Bo in another with awareness off.
  t.manager.send(t.ada.id, 'Go.');
  await settle();
  await assert.rejects(t.manager.commsTool(t.runners.get(t.ada.id)!.at(-1)!.ctx.commsToken!, 'send_message', { to_agent_id: t.bo.id, text: 'Hi' }), e => status(e) === 403);
});

test('the daily creation cap is a setting: 25 by default, checked', () => {
  const h = harness();
  assert.equal(h.manager.snapshot().settings.superMaxCreatesPerDay, 25);
  for (const bad of [-1, 201, 1.5]) assert.throws(() => h.manager.updateSettings({ superMaxCreatesPerDay: bad }), e => status(e) === 400, String(bad));
  assert.equal(h.manager.updateSettings({ superMaxCreatesPerDay: 40 }).superMaxCreatesPerDay, 40);
});

test('the user manages goals over HTTP: add, edit, reorder, remove', async () => {
  const t = await team();
  const server = createApp(t.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/super/goals`;
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await send(base, 'POST', { text: 'First', projectId: null });
    const two = await (await send(base, 'POST', { text: 'Second', projectId: t.web.id })).json() as SuperState;
    const second = two.goals.find(g => g.text === 'Second')!;
    assert.equal(second.projectId, t.web.id);
    assert.equal(second.by, 'user');
    assert.equal((await send(base, 'POST', { text: '' })).status, 400);
    assert.equal((await send(base, 'POST', { text: 'X', projectId: 'nope' })).status, 404);
    const moved = await (await send(`${base}/${second.id}/move`, 'POST', { to: 0 })).json() as SuperState;
    assert.deepEqual(moved.goals.map(g => g.text), ['Second', 'First']);
    const edited = await (await send(`${base}/${second.id}`, 'PATCH', { text: 'Second, reworded', status: 'blocked' })).json() as SuperState;
    assert.equal(edited.goals[0].text, 'Second, reworded');
    assert.equal(edited.goals[0].status, 'blocked');
    assert.equal((await send(`${base}/${second.id}`, 'PATCH', { status: 'someday' })).status, 400);
    const left = await (await send(`${base}/${second.id}`, 'DELETE')).json() as SuperState;
    assert.deepEqual(left.goals.map(g => g.text), ['First']);
    assert.equal((await send(`${base}/${second.id}`, 'DELETE')).status, 404);
    assert.ok(t.events.some(e => e.type === 'super' && e.super.goals.length === 2));
  } finally {
    server.close();
  }
});
