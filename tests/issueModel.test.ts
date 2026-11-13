import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { issueStatusFrom, issueTitle, legacyIssue, legacyIssueStatus, migrateIssue, reconcileIssues, type LegacyIssue } from '../shared/issues.ts';
import { issueBranchName, issueKeysIn, nextIssueKey } from '../shared/issueKeys.ts';
import { SuperStore } from '../server/superAgent.ts';
import { tempDir } from './helpers.ts';

// Phase 1 of Linear-style issues (ACH-D41, ACH-D43): the model, keys and the migration of what
// super.json holds today, with nothing lost, and an older build still able to read and change it.

const legacy = (id: string, extra: Partial<LegacyIssue> = {}): LegacyIssue => ({
  id, text: `Issue ${id}. With more detail after the first sentence.`, projectId: 'p-ach', status: 'queued', order: 0, createdAt: 1000, updatedAt: 1000, by: 'super', ...extra,
});

test('issue keys: a project code and a number; decision and note ids are not keys', () => {
  assert.deepEqual(issueKeysIn('feat/ACH-25-linear-style-issues'), ['ACH-25']);
  assert.deepEqual(issueKeysIn('Fixes ACH-25 and OBX-3; see ACH-D41, ALL-N3 and ALL-D9. Again ACH-25.'), ['ACH-25', 'OBX-3']);
  assert.deepEqual(issueKeysIn('ACH-25x, xACH-25, ach-25, A-1, TOOLONG-1, ACH-007'), ['ACH-7']);
  assert.deepEqual(issueKeysIn(''), []);
  assert.equal(issueBranchName('ACH-25', 'Linear-style Issues: proposal and HTML demo!'), 'feat/ACH-25-linear-style-issues-proposal-and-html');
  assert.equal(issueBranchName('ACH-3', '  '), 'feat/ACH-3');
});

test('a key is never reused: past every number given and every key in use', () => {
  let counters: Record<string, number> = {};
  const one = nextIssueKey('ACH', counters); counters = one.counters;
  const two = nextIssueKey('ACH', counters); counters = two.counters;
  assert.deepEqual([one.key, two.key], ['ACH-1', 'ACH-2']);
  assert.equal(nextIssueKey('OBX', counters).key, 'OBX-1', 'each project counts on its own');
  assert.equal(nextIssueKey('ACH', counters, ['ACH-9', 'OBX-40']).key, 'ACH-10');
});

test('statuses: the old names map to the new ones and back; anything else is refused', () => {
  assert.deepEqual(['queued', 'in_progress', 'blocked', 'done'].map(issueStatusFrom), ['todo', 'in_progress', 'needs_you', 'done']);
  assert.deepEqual(['backlog', 'in_review', 'waiting', 'canceled'].map(issueStatusFrom), ['backlog', 'in_review', 'waiting', 'canceled']);
  assert.equal(issueStatusFrom('later'), null);
  assert.equal(issueStatusFrom('toString'), null, 'no prototype keys');
  assert.deepEqual(['needs_you', 'waiting', 'in_review', 'in_progress', 'todo', 'backlog', 'done', 'canceled'].map(s => legacyIssueStatus(s as never)), ['blocked', 'blocked', 'in_progress', 'in_progress', 'queued', 'queued', 'done', 'done']);
});

test('migrating an old record loses nothing: status by its new name, title, text, notes as a comment, agent, links, dates', () => {
  const old = legacy('a1', { status: 'blocked', agentId: 'ada', delegationId: 'm1', notes: 'Waiting for the API key', updatedAt: 2000, by: 'user' });
  const issue = migrateIssue(old, 'ACH-4', 5000);
  assert.equal(issue.key, 'ACH-4');
  assert.equal(issue.status, 'needs_you');
  assert.equal(issue.title, 'Issue a1.');
  assert.equal(issue.text, old.text, 'the whole text is kept as the description');
  assert.deepEqual([issue.priority, issue.labels, issue.relations], ['none', [], []]);
  assert.deepEqual([issue.agentId, issue.delegationId, issue.notes, issue.by, issue.order, issue.createdAt, issue.updatedAt], ['ada', 'm1', 'Waiting for the API key', 'user', 0, 1000, 2000]);
  assert.deepEqual(issue.activity.map(e => [e.kind, e.by.kind, e.text ?? '']), [['created', 'user', ''], ['comment', 'user', 'Waiting for the API key'], ['migrated', 'podcode', 'Status blocked became needs_you; key ACH-4.']]);
  // And back for an older build: the same old record.
  assert.deepEqual(legacyIssue(issue), old);
  const done = migrateIssue(legacy('d1', { status: 'done', doneAt: 3000 }), 'ACH-5', 5000);
  assert.deepEqual([done.status, done.doneAt], ['done', 3000]);
  assert.equal(issueTitle('x'.repeat(200)).length, 118, '117 characters and an ellipsis');
});

test('reconcile after a downgrade: what an older build changed wins, added ones migrate, removed ones stay removed', () => {
  const keyFor = (() => { let n = 10; return () => `ACH-${++n}`; })();
  const current = [migrateIssue(legacy('a'), 'ACH-1', 1), migrateIssue(legacy('b'), 'ACH-2', 1), migrateIssue(legacy('c'), 'ACH-3', 1)];
  current[0] = { ...current[0], status: 'in_review', priority: 'high', updatedAt: 1500 };
  current[1] = { ...current[1], status: 'backlog', updatedAt: 1500 };
  // The older build: a reworded (status still reads the same), b blocked, c removed, d added.
  const old = [
    { ...legacyIssue(current[0]), text: 'A reworded.', updatedAt: 2000 },
    { ...legacyIssue(current[1]), status: 'blocked' as const, updatedAt: 2000 },
    legacy('d', { createdAt: 1800, updatedAt: 1800 }),
  ];
  const result = reconcileIssues(current, old, keyFor, 3000);
  const byId = new Map(result.map(i => [i.id, i]));
  assert.deepEqual([byId.get('a')!.text, byId.get('a')!.title, byId.get('a')!.status, byId.get('a')!.priority, byId.get('a')!.key], ['A reworded.', 'A reworded.', 'in_review', 'high', 'ACH-1'], 'in_review still reads as in_progress, so it stays; new fields are kept');
  assert.equal(byId.get('b')!.status, 'needs_you');
  assert.equal(byId.get('b')!.activity.at(-1)!.text, 'Changed by an older PodCode build.');
  assert.equal(byId.has('c'), false, 'removed by the older build');
  assert.equal(byId.get('d')!.key, 'ACH-11');
  // Unchanged copies change nothing; no old copy at all keeps the current list as it is.
  assert.deepEqual(reconcileIssues(current, current.map(legacyIssue), keyFor, 3000), current);
  assert.deepEqual(reconcileIssues(current, null, keyFor, 3000), current);
  assert.deepEqual(reconcileIssues(null, null, keyFor, 3000), []);
});

test('the store migrates super.json once: keys by project code in the order made, both formats written, nothing lost', () => {
  const dir = tempDir('issue-migrate');
  const file = path.join(dir, 'super.json');
  const old = [
    legacy('late', { createdAt: 3000, updatedAt: 3000, order: 1, projectId: 'p-ach' }),
    legacy('early', { createdAt: 1000, updatedAt: 1000, order: 0, projectId: 'p-ach', agentId: 'ada', notes: 'Ada has it', status: 'in_progress' }),
    legacy('other', { createdAt: 2000, updatedAt: 2000, order: 2, projectId: 'p-obx', status: 'blocked' }),
    legacy('none', { createdAt: 2500, updatedAt: 2500, order: 3, projectId: null }),
    legacy('gone', { createdAt: 500, updatedAt: 4000, status: 'done', doneAt: 4000, projectId: 'p-unknown' }),
  ];
  fs.writeFileSync(file, JSON.stringify({ asks: [], log: [], wakes: [], issues: old, goals: old, routines: [] }));
  const codes: Record<string, string> = { 'p-ach': 'ACH', 'p-obx': 'OBX' };
  const store = new SuperStore(dir, id => codes[id]);
  const issues = store.issues();
  const byId = new Map(issues.map(i => [i.id, i]));
  assert.deepEqual(['early', 'late', 'other', 'gone', 'none'].map(id => byId.get(id)!.key), ['ACH-1', 'ACH-2', 'OBX-1', 'ALL-1', 'ALL-2'], 'in creation order (gone was made first); no project or an unknown one is ALL');
  assert.deepEqual(issues.map(i => i.id), ['early', 'late', 'other', 'none', 'gone'], 'backlog order, closed last');
  assert.deepEqual([byId.get('early')!.status, byId.get('other')!.status, byId.get('gone')!.status], ['in_progress', 'needs_you', 'done']);
  assert.equal(byId.get('early')!.agentId, 'ada');
  assert.equal(byId.get('early')!.notes, 'Ada has it');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.issues2.length, 5, 'written back once');
  assert.deepEqual(raw.issueKeys, { ACH: 2, OBX: 1, ALL: 2 });
  assert.deepEqual(raw.issues.map((g: LegacyIssue) => [g.id, g.status]), [['early', 'in_progress'], ['late', 'queued'], ['other', 'blocked'], ['none', 'queued'], ['gone', 'done']], 'the old format for older builds');
  assert.deepEqual(raw.goals, raw.issues);
  const written = fs.readFileSync(file, 'utf8');
  new SuperStore(dir, id => codes[id]).issues();
  assert.equal(fs.readFileSync(file, 'utf8'), written, 'a second read changes nothing');
});

test('new issues get the next key, never a removed one; status, priority, due date and labels are checked; activity records changes', () => {
  const dir = tempDir('issue-keys');
  const store = new SuperStore(dir, () => 'ACH');
  const a = store.addIssue({ text: 'One', projectId: 'p', by: 'user' });
  const b = store.addIssue({ text: 'Two', projectId: 'p', by: 'super', priority: 'high', dueDate: '2026-11-20', labels: ['UI', 'ui'] });
  assert.deepEqual([a.key, b.key, a.status, b.priority, b.dueDate, b.labels], ['ACH-1', 'ACH-2', 'todo', 'high', '2026-11-20', ['ui']]);
  store.removeIssue(b.id);
  assert.equal(store.addIssue({ text: 'Three', projectId: 'p', by: 'user' }).key, 'ACH-3', 'ACH-2 is not reused');
  assert.throws(() => store.addIssue({ text: 'Bad', projectId: 'p', by: 'user', status: 'someday' }), /status is one of/);
  assert.throws(() => store.addIssue({ text: 'Bad', projectId: 'p', by: 'user', dueDate: '2026-02-30' }), /due date/);
  assert.throws(() => store.addIssue({ text: 'Bad', projectId: 'p', by: 'user', priority: 'asap' }), /priority is one of/);
  store.updateIssue(a.id, { status: 'in_review', agentId: 'fen', priority: 'urgent' }, 2000, { kind: 'agent', id: 'fen' });
  const canceled = store.updateIssue(a.id, { status: 'canceled' }, 3000, { kind: 'user' });
  assert.equal(canceled.canceledAt, 3000);
  assert.deepEqual(canceled.activity.slice(1).map(e => [e.kind, e.by.kind, e.from ?? '', e.to ?? '']), [
    ['priority', 'agent', 'none', 'urgent'], ['assignee', 'agent', '', 'fen'], ['status', 'agent', 'todo', 'in_review'], ['status', 'user', 'in_review', 'canceled'],
  ]);
  assert.equal(store.issues().at(-1)!.id, a.id, 'canceled is closed: after the open ones');
  // The title follows the text unless it was set on its own.
  const c = store.issues().find(i => i.text === 'Three')!;
  assert.equal(store.updateIssue(c.id, { text: 'Three, reworded. More.' }).title, 'Three, reworded.');
  store.updateIssue(c.id, { title: 'My own title' });
  assert.equal(store.updateIssue(c.id, { text: 'Changed again.' }).title, 'My own title');
});

test('an undo record from before ACH-D41 (the old format) still puts the issue back', () => {
  const dir = tempDir('issue-undo');
  const store = new SuperStore(dir, () => 'ACH');
  const issue = store.addIssue({ text: 'Keep me', projectId: 'p', by: 'user' });
  store.removeIssue(issue.id);
  store.restoreIssue(issue.id, { ...legacyIssue(issue), status: 'blocked' }, true);
  const back = store.issue(issue.id);
  assert.deepEqual([back.status, back.text, back.key.startsWith('ACH-')], ['needs_you', 'Keep me', true]);
});
