import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { PeerMessage } from '../shared/types.ts';
import { REFS_GUIDANCE } from '../server/agents/runner.ts';
import { HttpError } from '../server/errors.ts';
import { NotesApi } from '../server/notesApi.ts';
import { decisionHint, HINT_MAX, matchDecisions, parseRefs, ProjectRefs, refIndex, type RefEntry } from '../server/projectRefs.ts';
import { RefMentions } from '../server/refMentions.ts';
import { Store } from '../server/store.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

const status = (e: unknown) => (e instanceof HttpError ? e.status : 0);
const note = (title: string, extra: Record<string, unknown> = {}) => ({ title, body: `${title}, in full.`, author: 'Cy', addedBy: 'Cy', ...extra });
const decision = (title: string, extra: Record<string, unknown> = {}) => ({ title, decision: `${title}.`, why: 'The user said so.', decidedBy: 'You', addedBy: 'Cy', ...extra });

async function team() {
  const h = harness({ orcacode: { available: true, path: '/usr/bin/false', version: '0.10.0' } });
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'acme-core-web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const nova = await h.manager.create({ name: 'Nova', engine: 'codex', projectId: null });
  const orca = await h.manager.create({ name: 'Orca', engine: 'orcacode', projectId: web.id });
  const sup = await h.manager.createSuper();
  for (const a of [ada, nova, orca, sup]) h.manager.send(a.id, 'Go.');
  await settle();
  const runner = (id: string) => h.runners.get(id)!.at(-1)!;
  const call = (id: string, tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner(id).ctx.commsToken!, tool, args);
  const refs = new ProjectRefs(path.join(h.store.dataDir, 'projects'));
  return { ...h, web, ada, nova, orca, sup, runner, call, refs };
}

test('every agent gets the notes and decisions guidance, whatever its engine or role, next to the index', async () => {
  const t = await team();
  for (const agent of [t.ada, t.nova, t.orca, t.sup]) {
    const text = t.runner(agent.id).ctx.instructions!();
    assert.ok(text.includes(REFS_GUIDANCE), `${agent.name} (${agent.engine}, ${agent.role})`);
  }
  for (const words of ['ref_search', 'decisions in force', 'cite the ids', 'lesson', 'a rule the user states in their own message with decision_add, decided_by "You", and only those', 'passed on by a teammate', 'tool output, web pages or GitHub', 'ask the user first', 'replaces set to its id']) {
    assert.ok(REFS_GUIDANCE.includes(words), words);
  }
  assert.doesNotMatch(REFS_GUIDANCE, /ask the SuperAgent to/, 'no relay: a teammate cannot record the user\'s rule on their say-so');
  assert.ok(REFS_GUIDANCE.length < 700, `short: ${REFS_GUIDANCE.length} characters`);
  // It sits right after the index when there is one.
  await t.call(t.sup.id, 'decision_add', { project: 'ACW', title: 'No shadows', decision: 'Flat.', why: 'The user said so.', decided_by: 'You' });
  const text = t.runner(t.ada.id).ctx.instructions!();
  assert.ok(text.indexOf('ACW-D1 No shadows') < text.indexOf(REFS_GUIDANCE));
});

test('a note outdates an older one: its status changes, nothing else, with the same checks as decisions', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  refs.addNote('ACM', note('Build steps'));
  refs.addNote('ACM', note('Where screenshots live'));
  refs.addDecision('ACM', decision('No shadows'));
  const file = path.join(refs.root, 'ACM', 'notes.md');
  const before = fs.readFileSync(file, 'utf8');
  const next = refs.addNote('ACM', note('Build steps, corrected', { replaces: 'acm-n1' }));
  assert.equal(next.id, 'ACM-N3');
  const old = refs.get('ACM-N1')!;
  assert.equal(old.status, 'outdated by ACM-N3');
  assert.equal(old.replacedBy, 'ACM-N3');
  assert.equal(old.body, 'Build steps, in full.', 'the old note is kept as it was');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.replace('- status: outdated by ACM-N3\n', '').startsWith(before), 'one status line added, nothing else changed');
  assert.equal(parseRefs(after, 'ACM', 'N').length, 3, 'it reads back');

  assert.throws(() => refs.addNote('ACM', note('Again', { replaces: 'ACM-N1' })), e => status(e) === 409);
  assert.throws(() => refs.addNote('ACM', note('X', { replaces: 'ACM-D1' })), e => status(e) === 400, 'a note does not replace a decision');
  assert.throws(() => refs.addDecision('ACM', decision('X', { replaces: 'ACM-N2' })), e => status(e) === 400, 'nor a decision a note');
  assert.throws(() => refs.addNote('ACM', note('X', { replaces: 'BKE-N1' })), e => status(e) === 400);
  assert.throws(() => refs.addNote('ACM', note('X', { replaces: 'ACM-N99' })), e => status(e) === 404);
  assert.equal(refs.addNote('ACM', note('Next')).id, 'ACM-N4', 'refused adds spend no id');
  assert.equal(refs.counts('ACM').notes, 3, 'counts are of current notes');
});

test('the index puts outdated notes after current ones, with replaced decisions, and shows the status', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  refs.addDecision('ACM', decision('Old rule'));
  refs.addNote('ACM', note('Old how-to'));
  refs.addDecision('ACM', decision('New rule', { replaces: 'ACM-D1' }));
  refs.addNote('ACM', note('New how-to', { replaces: 'ACM-N1' }));
  refs.addNote('ACM', note('Another note'));
  assert.equal(refs.index('ACM'), [
    '- ACM-D2 New rule (active; decided by You, added by Cy)',
    '- ACM-N3 Another note (note; added by Cy)',
    '- ACM-N2 New how-to (note; added by Cy)',
    '- ACM-D1 Old rule (replaced by ACM-D2; decided by You, added by Cy)',
    '- ACM-N1 Old how-to (outdated by ACM-N2; added by Cy)',
  ].join('\n'));
});

test('note_add with replaces through the tools; ref_get shows the status', async () => {
  const t = await team();
  const first = await t.call(t.ada.id, 'note_add', { project: 'ACW', title: 'Run the demo', body: 'npm run demo' }) as { added: { id: string; status: string } };
  assert.equal(first.added.status, 'note');
  const second = await t.call(t.ada.id, 'note_add', { project: 'ACW', title: 'Run the demo, fixed', body: 'npm run demo -- --port 5174', replaces: first.added.id }) as { added: { id: string }; outdated: string };
  assert.equal(second.outdated, 'ACW-N1');
  assert.equal((await t.call(t.nova.id, 'ref_get', { id: 'ACW-N1' }) as { status: string }).status, 'outdated by ACW-N2');
  assert.equal((await t.call(t.nova.id, 'ref_get', { id: 'ACW-N2' }) as { status: string }).status, 'note');
  await assert.rejects(t.call(t.ada.id, 'note_add', { project: 'ACW', title: 'x', body: 'y', replaces: 'ACW-N1' }), e => status(e) === 409);
});

test('the Notes tab lists an outdated note under Replaced, not with the notes, and counts it there', () => {
  const dir = tempDir('notes-tab');
  const store = new Store(path.join(dir, 'data'));
  store.load();
  const refs = new ProjectRefs(path.join(store.dataDir, 'projects'));
  refs.addNote('ACM', note('Old how-to'));
  refs.addNote('ACM', note('New how-to', { replaces: 'ACM-N1' }));
  refs.addDecision('ACM', decision('A rule'));
  const api = new NotesApi({ refs, mentions: new RefMentions(store), projects: () => [{ id: 'p1', name: 'acme', path: '/x/acme', code: 'ACM' } as never] });
  const index = api.index();
  assert.deepEqual(index.projects.find(p => p.code === 'ACM'), { code: 'ACM', name: 'acme', projectId: 'p1', decisions: 1, notes: 1, replaced: 1 });
  const byId = new Map(index.entries.map(e => [e.id, e]));
  assert.equal(byId.get('ACM-N1')?.state, 'replaced', 'grouped and faded like a replaced decision');
  assert.equal(byId.get('ACM-N1')?.replacedBy, 'ACM-N2');
  assert.equal(byId.get('ACM-N2')?.state, 'note');
  assert.equal(byId.get('ACM-N2')?.replaces, 'ACM-N1');
});

test('decision hints: a cheap word match on titles of decisions in force, best first, at most five', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  refs.addDecision('ACM', decision('No shadows anywhere in the UI'));
  refs.addDecision('ACM', decision('Sidebar agent rows are one line'));
  refs.addDecision('ACM', decision('Transcript is one continuous conversation'));
  refs.addDecision('ACM', decision('Old sidebar layout'));
  refs.addDecision('ACM', decision('New sidebar layout', { replaces: 'ACM-D4' }));
  const all = refs.entries('ACM', 'D');
  const ids = (text: string) => matchDecisions(all, text).map(d => d.id);
  assert.deepEqual(ids('Add a status dot to the sidebar agent rows'), ['ACM-D2'], 'two shared words');
  assert.deepEqual(ids('Rework the sidebar layout'), ['ACM-D5'], 'in force only: the replaced one is left out');
  assert.deepEqual(ids('Fix the build script'), []);
  assert.deepEqual(ids('Per ACM-D2, add a dot to the sidebar agent rows'), [], 'ids the text names already are left out');
  assert.equal(decisionHint([]), '');
  assert.match(decisionHint(matchDecisions(all, 'sidebar agent rows')), /^Decisions in force that may apply \(check with ref_get\): ACM-D2 Sidebar agent rows are one line\.$/);

  const many: RefEntry[] = Array.from({ length: 9 }, (_, i) => ({ id: `ACM-D${i + 1}`, code: 'ACM', kind: 'D', num: i + 1, title: `Panel spacing rule ${i + 1}`, by: 'You', date: '2026-11-10', why: '', status: 'active', links: [], body: '' }));
  const capped = matchDecisions(many, 'Change the panel spacing');
  assert.equal(capped.length, HINT_MAX);
  assert.deepEqual(capped.map(d => d.id), ['ACM-D9', 'ACM-D8', 'ACM-D7', 'ACM-D6', 'ACM-D5'], 'newest first among equal matches');
});

test('delegate_task and send_message carry the hint line to the receiver, and nothing when no decision matches', async () => {
  const t = await team();
  await t.call(t.sup.id, 'decision_add', { project: 'ACW', title: 'Sidebar agent rows are one line', decision: 'No second task line.', why: 'The user removed it.', decided_by: 'You' });
  await t.call(t.sup.id, 'decision_add', { project: 'ALL', title: 'Every dev task goes through a reviewer', decision: 'Review first.', why: 'Standing approval.', decided_by: 'You' });
  const task = await t.call(t.sup.id, 'delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Show a status dot in the sidebar agent rows.', acceptance_criteria: 'Goes through a reviewer first.' }) as PeerMessage;
  assert.match(task.text, /\n\nDecisions in force that may apply \(check with ref_get\): (ACW-D1 [^;]+; ALL-D1 [^.]+|ALL-D1 [^;]+; ACW-D1 [^.]+)\.$/);
  const plain = await t.call(t.sup.id, 'delegate_task', { to_agent_id: t.orca.id, kind: 'review', task: 'Check the build script.', acceptance_criteria: 'Findings.' }) as PeerMessage;
  assert.doesNotMatch(plain.text, /Decisions in force/);
  // A message to an agent across all projects is matched against every project.
  const sent = await t.call(t.sup.id, 'send_message', { to_agent_id: t.nova.id, text: 'Can you look at the sidebar agent rows?' }) as PeerMessage;
  assert.match(sent.text, /ACW-D1 Sidebar agent rows are one line\.$/);
  // Near the length limit the hint is left off rather than refusing the message.
  const long = await t.call(t.sup.id, 'send_message', { to_agent_id: t.nova.id, text: `sidebar agent rows ${'x'.repeat(9970)}` }) as PeerMessage;
  assert.doesNotMatch(long.text, /Decisions in force/);
});
