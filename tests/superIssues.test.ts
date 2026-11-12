import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { SuperState } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { HttpError } from '../server/errors.ts';
import { SuperStore, updatePrompt, type SuperWatcher } from '../server/superAgent.ts';
import { issueSections } from '../web/superText.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

test('the issue store: add in order, update with links and done times, reorder, remove, restore; written to super.json', () => {
  const dir = tempDir('issues');
  const store = new SuperStore(dir);
  const a = store.addIssue({ text: '  Ship   dark mode ', projectId: 'web', by: 'user' });
  const b = store.addIssue({ text: 'Write release notes', projectId: null, by: 'super' });
  const c = store.addIssue({ text: 'Fix the flaky test', projectId: null, by: 'user' });
  assert.equal(a.text, 'Ship dark mode');
  assert.deepEqual(store.issues().map(g => [g.text, g.order, g.status]), [['Ship dark mode', 0, 'queued'], ['Write release notes', 1, 'queued'], ['Fix the flaky test', 2, 'queued']]);
  assert.throws(() => store.addIssue({ text: 'Ship dark mode', projectId: null, by: 'user' }), e => status(e) === 409);
  assert.throws(() => store.addIssue({ text: '   ', projectId: null, by: 'user' }), e => status(e) === 400);

  const started = store.updateIssue(a.id, { status: 'in_progress', agentId: 'ada', delegationId: 'm1', notes: 'Ada is on it' });
  assert.equal(started.agentId, 'ada');
  assert.equal(started.delegationId, 'm1');
  const finished = store.updateIssue(a.id, { status: 'done' });
  assert.ok(finished.doneAt);
  assert.equal(store.updateIssue(a.id, { status: 'queued', agentId: '' }).doneAt, undefined, 'reopening clears the done time');
  assert.equal(store.issue(a.id).agentId, undefined, 'an empty link is removed');
  assert.throws(() => store.updateIssue(a.id, { status: 'later' as never }), e => status(e) === 400);

  // Reopened, it went to the end; then the flaky test moves to the top.
  assert.deepEqual(store.issues().map(g => g.text), ['Write release notes', 'Fix the flaky test', 'Ship dark mode']);
  store.moveIssue(c.id, 0);
  assert.deepEqual(store.issues().filter(g => g.status !== 'done').map(g => g.text), ['Fix the flaky test', 'Write release notes', 'Ship dark mode']);
  // Undo puts an issue back as it was, or removes one that was added; never one removed since.
  const before = store.issue(b.id);
  store.updateIssue(b.id, { text: 'Write the release notes' });
  store.restoreIssue(b.id, before);
  assert.equal(store.issue(b.id).text, 'Write release notes');
  store.restoreIssue(b.id, null);
  assert.ok(!store.issues().some(g => g.id === b.id));
  assert.throws(() => store.restoreIssue(b.id, before), e => status(e) === 409);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'super.json'), 'utf8')) as { issues: unknown[] };
  assert.equal(saved.issues.length, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'super.json.tmp')), 'written through a temporary file');
  assert.deepEqual(issueSections(store.issues()).open.map(g => g.order), [0, 1]);
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

test('the issue tools: add, list, start with links, complete; each in the decision log, and undoable', async () => {
  const t = await team();
  const { added } = await t.call('add_issue', { text: 'Ship dark mode', project: 'WEB', why: 'The user asked for it.' }) as { added: { id: string; projectId: string; by: string } };
  assert.equal(added.projectId, t.web.id);
  assert.equal(added.by, 'super');
  await assert.rejects(t.call('add_issue', { text: 'X', project: 'mobile', why: 'x' }), e => status(e) === 404);
  const { issues } = await t.call('list_issues', {}) as { issues: { id: string }[] };
  assert.deepEqual(issues.map(g => g.id), [added.id]);

  await t.call('update_issue', { issue_id: added.id, status: 'in_progress', agent_id: 'ada', delegation_id: 'msg-1', why: 'Ada is free.' });
  let issue = t.manager.superView().issues[0];
  assert.equal(issue.status, 'in_progress');
  assert.equal(issue.agentId, t.ada.id);
  assert.match(t.manager.superView().log[0].summary, /in progress, given to Ada/);
  await t.call('complete_issue', { issue_id: added.id, notes: 'Merged after review.', why: 'Ada reported it passed.' });
  issue = t.manager.superView().issues[0];
  assert.equal(issue.status, 'done');
  assert.equal(issue.notes, 'Merged after review.');

  // Undo, as the user: completing goes back to in progress, then adding goes away.
  const [completed, started, add] = t.manager.superView().log;
  assert.equal(completed.tool, 'complete_issue');
  await t.manager.undoSuper(completed.id);
  assert.equal(t.manager.superView().issues[0].status, 'in_progress');
  await t.manager.undoSuper(started.id);
  assert.equal(t.manager.superView().issues[0].status, 'queued');
  await t.manager.undoSuper(add.id);
  assert.equal(t.manager.superView().issues.length, 0);

  // Only the SuperAgent has them.
  t.manager.send(t.ada.id, 'Go.');
  await settle();
  await assert.rejects(t.manager.commsTool(t.runners.get(t.ada.id)!.at(-1)!.ctx.commsToken!, 'add_issue', { text: 'Mine', why: 'x' }), e => status(e) === 403);
});

test('an agent coming free with queued issues wakes the SuperAgent, but only through the wake checks', async () => {
  const t = await team();
  t.runner.complete();
  t.manager.addIssue({ text: 'Write the release notes', projectId: t.web.id });
  // A turn you start is yours: Ada coming free after it is no issue news.
  t.manager.send(t.ada.id, 'Fix the header.');
  await settle();
  t.runners.get(t.ada.id)!.at(-1)!.complete(true, 'Fixed it.');
  assert.equal(t.watcher.waiting(), 2, 'the issue you added, and Ada finishing, but no issue line');
  // Bo asks Ada something; when that turn ends with nothing more queued, Ada is free.
  t.manager.send(t.bo.id, 'Ask Ada about the header.');
  await settle();
  await t.manager.commsTool(t.runners.get(t.bo.id)!.at(-1)!.ctx.commsToken!, 'send_message', { to_agent_id: t.ada.id, text: 'Is the header done?' });
  await settle();
  t.runners.get(t.ada.id)!.at(-1)!.complete(true, 'Yes.');
  await settle();
  assert.equal(t.watcher.waiting(), 3, 'now the issue line');

  // Quiet hours around now: nothing goes.
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  t.manager.updateSettings({ superQuietFrom: hhmm(new Date(Date.now() - 3_600_000)), superQuietTo: hhmm(new Date(Date.now() + 3_600_000)) });
  assert.equal(t.watcher.flush(), false);
  t.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  // No hourly budget: nothing goes.
  t.manager.updateSettings({ superMaxWakesPerHour: 0 });
  assert.equal(t.watcher.blocked(), 'the hourly wake budget is used');
  assert.equal(t.watcher.flush(), false);
  // Wake-ups off: nothing goes.
  t.manager.updateSettings({ superMaxWakesPerHour: 6, superWake: false });
  assert.equal(t.watcher.flush(), false);
  t.manager.updateSettings({ superWake: true });

  assert.equal(t.watcher.flush(), true);
  await settle();
  const sent = t.runner.sent.at(-1)!;
  assert.equal(sent.task?.source, 'system');
  assert.match(sent.text, /Ada is free and 1 queued issue waits/);
  assert.match(sent.text, /Open issues, in order[^\n]*\n1\. \[\w+\] queued: Write the release notes/);
  assert.match(sent.text, /The user added an issue: "Write the release notes"/);

  // With no queued issues, a free agent is ordinary news, with no issue line.
  t.runner.complete();
  t.manager.updateIssue(t.manager.superView().issues[0].id, { status: 'done' });
  const bo = t.runners.get(t.bo.id)!.at(-1)!;
  if (bo.busy) bo.complete(true, 'Asked.');
  await settle();
  assert.ok(t.watcher.flush());
  await settle();
  assert.doesNotMatch(t.runner.sent.at(-1)!.text, /queued issue|Open issues/);
});

test('the update prompt lists open issues briefly, top down, and leaves done ones out', () => {
  const issue = (id: string, order: number, status: 'queued' | 'in_progress' | 'done') => ({ id, text: `Issue ${id}`, projectId: null, status, order, createdAt: 0, updatedAt: 0, by: 'user' as const });
  const issues = [issue('a', 1, 'queued'), issue('b', 0, 'in_progress'), issue('c', 2, 'done'), ...Array.from({ length: 9 }, (_, i) => issue(`x${i}`, 3 + i, 'queued'))];
  const prompt = updatePrompt([], [], 0, issues);
  assert.match(prompt, /1\. \[a\] queued: Issue a/);
  assert.match(prompt, /2\. \[b\] in_progress: Issue b/);
  assert.doesNotMatch(prompt, /Issue c/);
  assert.match(prompt, /\(3 more; list_issues has them all\)/);
  assert.doesNotMatch(updatePrompt([], [], 0, []), /Open issues/);
});

test('the SuperAgent messages any agent whatever the team settings, but never one the user stopped; other agents keep their rules', async () => {
  const t = await team();
  t.manager.updateSettings({ awareness: 'off' });
  const listed = await t.call('list_agents', {}) as { name: string; canMessage: boolean }[];
  assert.ok(listed.filter(a => a.name === 'Ada' || a.name === 'Bo').every(a => a.canMessage), 'read-only, yet it can message everyone');
  await t.call('send_message', { to_agent_id: t.ada.id, text: 'Can you take the release notes?' });
  // An agent the user stopped is off limits until the user gives it a task: it asks the user instead.
  await t.manager.stop(t.bo.id);
  assert.equal((await t.call('list_agents', {}) as { name: string; canMessage: boolean }[]).find(a => a.name === 'Bo')!.canMessage, false);
  await assert.rejects(t.call('send_message', { to_agent_id: t.bo.id, text: 'Pick this back up.' }), e => status(e) === 409);
  await assert.rejects(t.call('new_session', { agent_id: 'Bo', why: 'Unstick him.' }), e => status(e) === 409 && /ask_user/.test((e as Error).message));
  assert.equal(t.store.agents.get(t.bo.id)!.turns, 0, 'no turn started');
  t.manager.send(t.bo.id, 'Carry on.');
  await settle();
  t.runners.get(t.bo.id)!.at(-1)!.complete();
  await t.call('new_session', { agent_id: 'Bo', why: 'Context is full.' });
  // One turn's collaboration keeps the usual budget: 12 messages, then 409; the next turn starts afresh.
  for (let i = 1; i < 12; i++) await t.call('send_message', { to_agent_id: t.ada.id, text: `Nudge ${i}` });
  await assert.rejects(t.call('send_message', { to_agent_id: t.ada.id, text: 'One too many' }), e => status(e) === 409 && /budget/.test((e as Error).message));
  t.runner.complete();
  t.manager.send(t.sup.id, 'Next.');
  await settle();
  await t.call('send_message', { to_agent_id: t.ada.id, text: 'A new turn, a new budget.' });
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

test('the user manages issues over HTTP: add, edit, reorder, remove', async () => {
  const t = await team();
  const server = createApp(t.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/super/issues`;
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await send(base, 'POST', { text: 'First', projectId: null });
    const two = await (await send(base, 'POST', { text: 'Second', projectId: t.web.id })).json() as SuperState;
    const second = two.issues.find(g => g.text === 'Second')!;
    assert.equal(second.projectId, t.web.id);
    assert.equal(second.by, 'user');
    assert.equal((await send(base, 'POST', { text: '' })).status, 400);
    assert.equal((await send(base, 'POST', { text: 'X', projectId: 'nope' })).status, 404);
    const moved = await (await send(`${base}/${second.id}/move`, 'POST', { to: 0 })).json() as SuperState;
    assert.deepEqual(moved.issues.map(g => g.text), ['Second', 'First']);
    const edited = await (await send(`${base}/${second.id}`, 'PATCH', { text: 'Second, reworded', status: 'blocked' })).json() as SuperState;
    assert.equal(edited.issues[0].text, 'Second, reworded');
    assert.equal(edited.issues[0].status, 'blocked');
    assert.equal((await send(`${base}/${second.id}`, 'PATCH', { status: 'someday' })).status, 400);
    const left = await (await send(`${base}/${second.id}`, 'DELETE')).json() as SuperState;
    assert.deepEqual(left.issues.map(g => g.text), ['First']);
    assert.equal((await send(`${base}/${second.id}`, 'DELETE')).status, 404);
    assert.ok(t.events.some(e => e.type === 'super' && e.super.issues.length === 2));
  } finally {
    server.close();
  }
});

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const quietNow = () => ({ superQuietFrom: hhmm(new Date(Date.now() - 3_600_000)), superQuietTo: hhmm(new Date(Date.now() + 3_600_000)) });

/** The newest report to `to`, from `from`. */
const reportTo = (t: Awaited<ReturnType<typeof team>>, to: string, from: string) => [...t.store.messages].reverse().find(m => m.toAgentId === to && m.fromAgentId === from && m.report);

test('work you asked the SuperAgent for never waits: its reports come through wake-ups off, quiet hours and no budget, uncounted, hop after hop', async () => {
  const t = await team();
  t.runner.complete();
  t.manager.updateSettings({ superWake: false, superMaxWakesPerHour: 0, ...quietNow() });
  // You ask; it delegates to Ada in your turn.
  t.manager.send(t.sup.id, 'Get the release notes written, then reviewed.');
  await settle();
  const toAda = await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Write the notes.', acceptance_criteria: 'Notes exist.' }) as { id: string; conversationId: string };
  assert.equal(t.store.conversations.find(c => c.id === toAda.conversationId)?.userStarted, true);
  t.runner.complete();
  await settle();
  const ada = t.runners.get(t.ada.id)!.at(-1)!;
  await t.manager.commsTool(ada.ctx.commsToken!, 'report_result', { message_id: toAda.id, outcome: 'done', summary: 'Written.', evidence: 'notes.md' });
  ada.complete(true, 'Reported.');
  await settle();
  const first = reportTo(t, t.sup.id, t.ada.id)!;
  assert.notEqual(first.status, 'queued', 'delivered despite every wake-up limit');
  assert.equal(t.runner.sent.at(-1)!.task?.messageId, first.id);
  // Second hop: from that report's turn it sends the review to Bo; Bo's report comes through too.
  const toBo = await t.call('delegate_task', { to_agent_id: t.bo.id, kind: 'review', task: 'Review the notes.', acceptance_criteria: 'Findings.' }) as { id: string };
  t.runner.complete();
  await settle();
  const bo = t.runners.get(t.bo.id)!.at(-1)!;
  await t.manager.commsTool(bo.ctx.commsToken!, 'report_result', { message_id: toBo.id, outcome: 'passed', summary: 'Fine.', evidence: 'read it' });
  bo.complete(true, 'Reported.');
  await settle();
  const second = reportTo(t, t.sup.id, t.bo.id)!;
  assert.notEqual(second.status, 'queued');
  assert.equal(t.runner.sent.at(-1)!.task?.messageId, second.id);
  assert.equal(new SuperStore(t.store.dataDir).wakesSince(Date.now() - 60_000), 0, 'none of it counts as a wake-up');
  assert.equal(t.manager.superView().held, null);
});

test('mail about work it began on its own waits on the wake-up limits, is shown as waiting, and is told in the next update', async () => {
  const t = await team();
  t.runner.complete();
  // An update turn (not yours): in it, it delegates to Ada.
  t.watcher.note({ agentId: t.ada.id, key: 'x', text: 'Ada is free' });
  assert.equal(t.watcher.flush(), true);
  await settle();
  const toAda = await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Tidy the docs.', acceptance_criteria: 'Tidy.' }) as { id: string; conversationId: string };
  assert.equal(t.store.conversations.find(c => c.id === toAda.conversationId)?.userStarted, undefined);
  t.runner.complete();
  await settle();
  const sentBefore = t.runner.sent.length;
  t.manager.updateSettings({ superWake: false });
  const ada = t.runners.get(t.ada.id)!.at(-1)!;
  await t.manager.commsTool(ada.ctx.commsToken!, 'report_result', { message_id: toAda.id, outcome: 'done', summary: 'Tidied.', evidence: 'docs/' });
  ada.complete(true, 'Reported.');
  await settle();
  const report = reportTo(t, t.sup.id, t.ada.id)!;
  assert.equal(report.status, 'queued');
  assert.equal(t.runner.sent.length, sentBefore, 'no turn starts');
  assert.deepEqual(t.manager.superView().held, { count: 1, reason: 'wake-ups are off' });
  // Your own message still goes, and the report still waits after it.
  t.manager.send(t.sup.id, 'Status?');
  await settle();
  t.runner.complete();
  await settle();
  assert.equal(report.status, 'queued');
  // Wake-ups on, as the minute tick sees it: the update goes first, and says the report waited.
  t.watcher.note({ agentId: t.bo.id, key: 'y', text: 'Bo is free' });
  t.manager.updateSettings({ superWake: true });
  assert.equal(t.watcher.flush(), true);
  assert.match(t.runner.sent.at(-1)!.text, /While you could not take a turn \(wake-ups are off\), 1 message to you waited/);
  t.runner.complete();
  await settle();
  assert.equal(report.status, 'delivering');
  assert.equal(t.runner.sent.filter(x => x.task?.messageId === report.id).length, 1);
  assert.equal(new SuperStore(t.store.dataDir).wakesSince(Date.now() - 60_000), 3, 'two updates and the report');
  t.runner.complete();
  await settle();
  // Held again and then delivered before the next update: that update does not count it.
  t.manager.updateSettings({ superWake: false });
  t.watcher.noteHeld(report.id, 'wake-ups are off');
  t.manager.updateSettings({ superWake: true });
  t.watcher.note({ agentId: t.bo.id, key: 'z', text: 'Bo again' });
  assert.equal(t.watcher.flush(), true);
  assert.doesNotMatch(t.runner.sent.at(-1)!.text, /waited/, 'delivered since, so no longer waiting');
});

test('the daily budget holds only what it starts on its own, and says so; work you asked for goes past it; held mail survives a restart', async () => {
  const t = await team();
  t.runner.complete();
  // Your turn delegates to Ada; an update turn delegates to Bo.
  t.manager.send(t.sup.id, 'Write the notes.');
  await settle();
  const mine = await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Notes.', acceptance_criteria: 'Done.' }) as { id: string };
  t.runner.complete();
  t.watcher.note({ agentId: t.bo.id, key: 'z', text: 'Bo is free' });
  assert.ok(t.watcher.flush());
  await settle();
  const its = await t.call('delegate_task', { to_agent_id: t.bo.id, kind: 'review', task: 'Look around.', acceptance_criteria: 'Notes.' }) as { id: string };
  t.runner.complete();
  await settle();
  // Its own spending today passes the budget.
  t.manager.updateSettings({ superDailyBudgetUsd: 1 });
  new SuperStore(t.store.dataDir).addAutonomousCost(5);
  // Bo (its own work) reports first, then Ada (yours).
  for (const [runner, id] of [[t.runners.get(t.bo.id)!.at(-1)!, its.id], [t.runners.get(t.ada.id)!.at(-1)!, mine.id]] as const) {
    await t.manager.commsTool(runner.ctx.commsToken!, 'report_result', { message_id: id, outcome: 'done', summary: 'Done.', evidence: 'x' });
    runner.complete(true, 'Reported.');
  }
  await settle();
  const fromBo = reportTo(t, t.sup.id, t.bo.id)!;
  const fromAda = reportTo(t, t.sup.id, t.ada.id)!;
  assert.notEqual(fromAda.status, 'queued', 'your work goes past the daily budget, ahead of held mail');
  assert.equal(fromBo.status, 'queued');
  assert.deepEqual(t.manager.superView().held, { count: 1, reason: 'the daily budget is used' });
  t.runner.complete();
  await settle();
  // A restart keeps the held one queued, in an open conversation, instead of failing it.
  const mailbox = (t.manager as unknown as { mailbox: { recover(): void } }).mailbox;
  mailbox.recover();
  assert.equal(fromBo.status, 'queued');
  assert.equal(t.store.conversations.find(c => c.id === fromBo.conversationId)!.stopped, false);
  // A bigger budget lets it through.
  t.manager.updateSettings({ superDailyBudgetUsd: 100 });
  await settle();
  assert.equal(fromBo.status, 'delivering');
});

test('issues are handed out only in update turns, never from mail about work you asked for', async () => {
  const t = await team();
  const { added } = await t.call('add_issue', { text: 'Tidy the docs', why: 'x' }) as { added: { id: string } };
  t.runner.complete();
  // Your turn delegates to Ada; her report comes back as a mail turn on your work.
  t.manager.send(t.sup.id, 'Write the notes.');
  await settle();
  const mine = await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Notes.', acceptance_criteria: 'Done.' }) as { id: string };
  t.runner.complete();
  await settle();
  const ada = t.runners.get(t.ada.id)!.at(-1)!;
  await t.manager.commsTool(ada.ctx.commsToken!, 'report_result', { message_id: mine.id, outcome: 'done', summary: 'Done.', evidence: 'x' });
  ada.complete(true, 'Reported.');
  await settle();
  assert.equal(t.runner.sent.at(-1)!.task?.source, 'agent');
  await assert.rejects(t.call('update_issue', { issue_id: added.id, status: 'in_progress', agent_id: 'Bo', why: 'Bo is free.' }), e => status(e) === 409 && /update turns/.test((e as Error).message));
  await assert.rejects(t.call('update_issue', { issue_id: added.id, agent_id: 'Bo', why: 'x' }), e => status(e) === 409);
  // Notes and completing are fine there; starting an issue is fine in an update turn.
  await t.call('update_issue', { issue_id: added.id, notes: 'Waiting for a free agent.', why: 'x' });
  t.runner.complete();
  await settle();
  t.watcher.note({ agentId: t.bo.id, key: 'free', text: 'Bo is free' });
  assert.ok(t.watcher.flush());
  await t.call('update_issue', { issue_id: added.id, status: 'in_progress', agent_id: 'Bo', why: 'Bo is free.' });
  assert.equal(t.manager.superView().issues[0].status, 'in_progress');
});

test('the app hears about the SuperAgent only when something changed', async () => {
  const t = await team();
  const tick = () => (t.manager as unknown as { superTick(): void }).superTick();
  tick();
  const before = t.events.filter(e => e.type === 'super').length;
  tick();
  tick();
  assert.equal(t.events.filter(e => e.type === 'super').length, before, 'an unchanged view is not sent again');
  t.manager.addIssue({ text: 'Something new' });
  assert.equal(t.events.filter(e => e.type === 'super').length, before + 1);
});

test('issue undo refuses when the issue is gone or would repeat an open one; update_issue needs something to change', async () => {
  const t = await team();
  const { added } = await t.call('add_issue', { text: 'Ship it', why: 'x' }) as { added: { id: string } };
  t.manager.removeIssue(added.id);
  await assert.rejects(t.manager.undoSuper(t.manager.superView().log[0].id), e => status(e) === 409);
  assert.equal(t.manager.superView().issues.length, 0, 'not brought back');

  const { added: two } = await t.call('add_issue', { text: 'Write docs', why: 'x' }) as { added: { id: string } };
  await t.call('complete_issue', { issue_id: two.id, why: 'Done.' });
  t.manager.addIssue({ text: 'Write docs' });
  await assert.rejects(t.manager.undoSuper(t.manager.superView().log[0].id), e => status(e) === 409 && /same thing/.test((e as Error).message));
  await assert.rejects(t.call('update_issue', { issue_id: two.id, why: 'Nothing.' }), e => status(e) === 400);
});

test('issues read from super.json are checked; the app must send text as text', async () => {
  const dir = tempDir('issues-bad');
  fs.writeFileSync(path.join(dir, 'super.json'), JSON.stringify({
    asks: [], log: [], wakes: [],
    issues: [
      { id: 'ok', text: 'Fine', projectId: null, status: 'queued', order: 0, createdAt: 1, updatedAt: 1, by: 'user' },
      { id: 'bad1', text: 42, projectId: null, status: 'queued', order: 1, createdAt: 1, updatedAt: 1, by: 'user' },
      { id: 'bad2', text: 'Odd', projectId: null, status: 'someday', order: 2, createdAt: 1, updatedAt: 1, by: 'user' },
      null,
    ],
  }));
  assert.deepEqual(new SuperStore(dir).issues().map(g => g.id), ['ok']);
  const t = await team();
  assert.throws(() => t.manager.addIssue({ text: 42 as unknown as string }), e => status(e) === 400);
  assert.throws(() => t.manager.addIssue({ text: 'X', projectId: 7 as unknown as string }), e => status(e) === 400);
  t.manager.addIssue({ text: 'Two\nlines' });
  assert.equal(t.manager.superView().issues[0].text, 'Two lines', 'an issue is one line');
  assert.throws(() => t.manager.updateIssue(t.manager.superView().issues[0].id, { text: ['x'] }), e => status(e) === 400);
});

test('an answer to its question is your turn: what it delegates there comes back with wake-ups off, no budget and the day spent', async () => {
  const t = await team();
  t.manager.updateSettings({ superWake: false, superMaxWakesPerHour: 0, superDailyBudgetUsd: 1, ...quietNow() });
  new SuperStore(t.store.dataDir).addAutonomousCost(5);
  // It asks; you answer from the card. That answer is a turn you started.
  const { asked } = await t.call('ask_user', { question: 'Let your own work finish past the cap?', options: ['Yes', 'No'] }) as { asked: { id: string } };
  t.runner.complete();
  t.manager.answerSuper(asked.id, { answer: 'Yes' });
  await settle();
  assert.equal(t.runner.sent.at(-1)!.task?.source, 'user');
  const toAda = await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Do it.', acceptance_criteria: 'Done.' }) as { id: string; conversationId: string };
  assert.equal(t.store.conversations.find(c => c.id === toAda.conversationId)?.userStarted, true);
  t.runner.complete();
  await settle();
  const ada = t.runners.get(t.ada.id)!.at(-1)!;
  await t.manager.commsTool(ada.ctx.commsToken!, 'report_result', { message_id: toAda.id, outcome: 'done', summary: 'Done.', evidence: 'x' });
  ada.complete(true, 'Reported.');
  await settle();
  const report = reportTo(t, t.sup.id, t.ada.id)!;
  assert.notEqual(report.status, 'queued', 'delivered at once');
  assert.equal(t.runner.sent.at(-1)!.task?.messageId, report.id);
  assert.equal(t.manager.superView().held, null);
});

test('the daily budget counts only its own turns: what you start, and mail on your work, never use it up', async () => {
  const t = await team();
  t.manager.updateSettings({ superDailyBudgetUsd: 10 });
  const store = new SuperStore(t.store.dataDir);
  // End the running turn as the engine would, reporting its running cost.
  const end = (cost: number) => {
    t.runner.busy = false;
    t.runner.ctx.hooks.turnEnd({ ok: true, summary: 'Done.', costUsd: t.store.agents.get(t.sup.id)!.costUsd + cost });
    t.runner.ctx.hooks.ready?.();
  };
  // A turn you started, however costly, is not counted.
  end(40);
  await settle();
  assert.equal(store.spentToday(new Date()), 0);
  assert.equal(t.watcher.dailyHeld(), null);
  // An update turn is.
  t.watcher.note({ agentId: t.ada.id, key: 'k', text: 'Ada is free' });
  assert.ok(t.watcher.flush());
  await settle();
  end(12);
  await settle();
  assert.equal(Math.round(store.spentToday(new Date())), 12);
  assert.equal(t.watcher.dailyHeld(), 'the daily budget is used');
});

test('the creation cap stops only agents it makes on its own: never in your turn or on your work', async () => {
  const t = await team();
  t.manager.updateSettings({ superMaxCreatesPerDay: 0 });
  // In your turn (team() leaves it running "Run the team."): created.
  const made = await t.call('create_agent', { name: 'Tess', role: 'tester', why: 'You asked for a tester.' }) as { created: { id: string } };
  assert.ok(t.store.agents.has(made.created.id));
  assert.equal(t.manager.superView().log[0].forUser, true);
  t.runner.complete();
  await settle();
  // In an update turn: refused.
  t.watcher.note({ agentId: t.ada.id, key: 'k', text: 'Ada is free' });
  assert.ok(t.watcher.flush());
  await assert.rejects(t.call('create_agent', { name: 'Auto', why: 'More hands.' }), e => status(e) === 429);
  // With a cap of 1, the agent made for you does not use it up.
  t.manager.updateSettings({ superMaxCreatesPerDay: 1 });
  await t.call('create_agent', { name: 'Auto', why: 'More hands.' });
  await assert.rejects(t.call('create_agent', { name: 'Auto2', why: 'More hands.' }), e => status(e) === 429);
});
