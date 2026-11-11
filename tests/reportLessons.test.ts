import assert from 'node:assert/strict';
import test from 'node:test';
import type { PeerMessage } from '../shared/types.ts';
import { HttpError } from '../server/errors.ts';
import { ProjectRefs } from '../server/projectRefs.ts';
import path from 'node:path';
import { harness, projectDir, settle } from './helpers.ts';

const status = (e: unknown) => (e instanceof HttpError ? e.status : 0);

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'acme-core-web') });
  const site = h.manager.addProject({ path: projectDir(h.dir, 'docs-site') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const nova = await h.manager.create({ name: 'Nova', engine: 'claude', projectId: null });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const runner = h.runner(sup.id);
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner.ctx.commsToken!, tool, args);
  const refs = new ProjectRefs(path.join(h.store.dataDir, 'projects'));
  /** Delegate to an agent and let it start, returning a call bound to that agent's token. */
  const delegate = async (agentId: string, extra: Record<string, unknown> = {}) => {
    const request = await call('delegate_task', { to_agent_id: agentId, kind: 'implementation', task: 'Do the work.', acceptance_criteria: 'Done.', ...extra }) as PeerMessage;
    await settle();
    const worker = h.runners.get(agentId)!.at(-1)!;
    return { request, worker, as: (tool: string, args: Record<string, unknown>) => h.manager.commsTool(worker.ctx.commsToken!, tool, args) };
  };
  return { ...h, web, site, ada, nova, sup, runner, call, refs, delegate };
}

const report = (id: string, extra: Record<string, unknown> = {}) => ({ message_id: id, outcome: 'done', summary: 'Built it.', evidence: 'npm test: 10 pass', ...extra });

test('a lesson with a report is saved as a note in the task\'s project, linked to the delegation, and named in the report', async () => {
  const t = await team();
  const { request, as } = await t.delegate(t.ada.id, { project: 'DSI' });
  assert.equal(request.delegation?.project, 'DSI', 'the delegation keeps the resolved code');
  assert.match(request.text, /\nProject: DSI\n/);
  const sent = await as('report_result', report(request.id, { lesson: 'Site screenshots come from scripts/capture.mjs. Run it with the dev server up.' })) as PeerMessage;
  assert.equal(sent.report?.lesson?.id, 'DSI-N1');
  assert.match(sent.text, /Lesson saved as DSI-N1 \(read it with ref_get\)\.$/, 'the lead sees the id');
  const note = t.refs.get('DSI-N1')!;
  assert.equal(note.title, 'Lesson: Site screenshots come from scripts/capture.mjs.');
  assert.equal(note.body, 'Site screenshots come from scripts/capture.mjs. Run it with the dev server up.');
  assert.equal(note.by, 'Ada');
  assert.equal(note.addedBy, 'Ada');
  assert.deepEqual(note.links, [`delegation:${request.id}`]);

  // The same report again is the same receipt, and no second note.
  const again = await as('report_result', report(request.id, { lesson: 'Site screenshots come from scripts/capture.mjs. Run it with the dev server up.' })) as PeerMessage;
  assert.equal(again.id, sent.id);
  assert.equal(t.refs.entries('DSI', 'N').length, 1);
});

test('without a project on the task, a lesson goes to the agent\'s project, else ALL', async () => {
  const t = await team();
  const forAda = await t.delegate(t.ada.id);
  await forAda.as('report_result', report(forAda.request.id, { lesson: 'Typecheck covers three tsconfigs.' }));
  assert.equal(t.refs.get('ACW-N1')?.by, 'Ada');
  t.runner.complete();
  await settle();
  t.manager.send(t.sup.id, 'Next.');
  await settle();
  const forNova = await t.delegate(t.nova.id);
  const sent = await forNova.as('report_result', report(forNova.request.id, { lesson: 'Release notes live in docs/releases.' })) as PeerMessage;
  assert.equal(sent.report?.lesson?.id, 'ALL-N1');
  assert.equal(t.refs.get('ALL-N1')?.by, 'Nova');
  // Unknown project when delegating is refused up front.
  await assert.rejects(t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'review', task: 'x', acceptance_criteria: 'y', project: 'nowhere' }), e => status(e) === 404);
});

test('lessons are capped and refused when they hold a secret; a refused lesson sends no report and saves nothing', async () => {
  const t = await team();
  const { request, as } = await t.delegate(t.ada.id);
  await assert.rejects(as('report_result', report(request.id, { lesson: 'x'.repeat(1001) })), e => status(e) === 400);
  await assert.rejects(as('report_result', report(request.id, { lesson: 'Deploy with sk-ant-abcdefghijklmnopqrstuvwxyz012345 set.' })), e => status(e) === 400);
  // A report the agent may not make saves no lesson either.
  await assert.rejects(as('report_result', report('not-a-request', { lesson: 'Useful.' })), e => status(e) === 403);
  assert.equal(t.refs.entries('ACW', 'N').length, 0);
  assert.equal(t.store.messages.filter(m => m.replyTo === request.id).length, 0, 'no report went out');
  // Without a lesson, a report is as before.
  const plain = await as('report_result', report(request.id)) as PeerMessage;
  assert.equal(plain.report?.lesson, undefined);
  assert.doesNotMatch(plain.text, /Lesson saved/);
});

test('a reply can carry a lesson too, linked to the message it answers', async () => {
  const t = await team();
  const asked = await t.call('send_message', { to_agent_id: t.ada.id, text: 'Where do avatars live?' }) as PeerMessage;
  await settle();
  const worker = t.runners.get(t.ada.id)!.at(-1)!;
  const sent = await t.manager.commsTool(worker.ctx.commsToken!, 'reply', { message_id: asked.id, text: 'shared/avatar.ts.', lesson: 'Avatars are defined in shared/avatar.ts; assignLooks picks one per agent.' }) as PeerMessage & { lesson: string };
  assert.equal(sent.lesson, 'ACW-N1');
  assert.match(sent.text, /^shared\/avatar\.ts\.\n\nLesson saved as ACW-N1/);
  assert.deepEqual(t.refs.get('ACW-N1')?.links, [`message:${asked.id}`]);
  await assert.rejects(t.manager.commsTool(worker.ctx.commsToken!, 'reply', { message_id: 'nope', text: 'x', lesson: 'y' }), e => status(e) === 403);
  assert.equal(t.refs.entries('ACW', 'N').length, 1);
});

test('the user\'s answer to ask_user tells the SuperAgent how to record it as a decision, and records nothing by itself', async () => {
  const t = await team();
  const { asked } = await t.call('ask_user', { question: 'Merge feat/project-notes?', options: ['Merge it', 'Not now'] }) as { asked: { id: string } };
  t.manager.answerSuper(asked.id, { answer: 'Merge it' });
  t.runner.complete();
  await settle();
  const turn = t.runner.sent.at(-1)!.text;
  assert.ok(turn.includes(`(question ${asked.id}): Merge it`));
  assert.ok(turn.includes(`decision_add (decided_by "You", links ["ask:${asked.id}"])`));
  assert.deepEqual(t.refs.codes(), ['ACW', 'DSI'], 'no decision is made for it');
  assert.equal(t.refs.entries('ACW', 'D').length, 0);
  // The path it is pointed to works.
  const { added } = await t.call('decision_add', { project: 'ACW', title: 'Merge feat/project-notes', decision: 'Merge it into local main.', why: 'The user approved.', decided_by: 'You', links: [`ask:${asked.id}`] }) as { added: { id: string; links: string[] } };
  assert.equal(added.id, 'ACW-D1');
  assert.deepEqual(added.links, [`ask:${asked.id}`]);
  assert.equal((added as { added_by?: string }).added_by, 'SuperAgent', '"decided by You" is visibly the SuperAgent\'s claim');
  assert.equal(t.refs.get('ACW-D1')?.addedBy, 'SuperAgent');
});

test('a lesson is never saved unless its message is sent: a stopped collaboration, twice, and an over-long reply leave no note', async () => {
  const t = await team();
  const { request, as } = await t.delegate(t.ada.id, { project: 'DSI' });
  t.manager.stopConversation(t.store.messages.find(m => m.id === request.id)!.conversationId);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(as('report_result', report(request.id, { lesson: 'Run capture.mjs with the dev server up.' })), e => status(e) === 409);
  }
  assert.deepEqual(t.refs.entries('DSI', 'N'), [], 'no note from either refused report');

  t.runner.complete();
  await settle();
  t.manager.send(t.sup.id, 'Next.');
  await settle();
  const asked = await t.call('send_message', { to_agent_id: t.nova.id, text: 'How do screenshots work?' }) as PeerMessage;
  await settle();
  const worker = t.runners.get(t.nova.id)!.at(-1)!;
  const reply = (args: Record<string, unknown>) => t.manager.commsTool(worker.ctx.commsToken!, 'reply', { message_id: asked.id, ...args });
  // Within the tool's own limit, but over the message limit once "Lesson saved as ..." is added.
  await assert.rejects(reply({ text: 'x'.repeat(9990), lesson: 'Screens come from capture.mjs.' }), e => status(e) === 400);
  assert.deepEqual(t.refs.entries('ALL', 'N'), []);
  // The id it would have had is still free: the next lesson that is sent gets it.
  const sent = await reply({ text: 'capture.mjs.', lesson: 'Screens come from capture.mjs.' }) as PeerMessage & { lesson: string; lessonError?: string };
  assert.equal(sent.lesson, 'ALL-N1');
  assert.equal(sent.lessonError, undefined);
  assert.equal(t.refs.get('ALL-N1')?.by, 'Nova');
});

test('decided_by and author are names: text posing as "added by" is refused', async () => {
  const t = await team();
  await assert.rejects(t.call('decision_add', { project: 'ACW', title: 'Spoof', decision: 'x', why: 'y', decided_by: 'You, added by You' }), e => status(e) === 400);
  await assert.rejects(t.call('decision_add', { project: 'ACW', title: 'Spoof', decision: 'x', why: 'y', decided_by: 'You) (added  by the user' }), e => status(e) === 400);
  assert.deepEqual(t.refs.entries('ACW', 'D'), []);
  const ok = await t.call('decision_add', { project: 'ACW', title: 'Fine', decision: 'x', why: 'y', decided_by: 'You' }) as { added: { id: string } };
  assert.equal(ok.added.id, 'ACW-D1', 'refused adds spend no id');
});
