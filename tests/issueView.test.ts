import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssueEvent, SuperIssue } from '../shared/types.ts';
import { tabKey } from '../web/layout.ts';
import { citedDecisions, fromServerDecisions, issueLinksSource, localIssueLinks, setIssueLinksSource } from '../web/issues/view/issueLinks.ts';
import { activityLine, actorName, assigneeOf, commentToPost, commitEdit, parentCandidates, relationRemoval, withRelation, descriptionToSave, dueToSave, dueTone, TEXT_MAX, TITLE_MAX, titleToSave, matchesQuery, parentOf, parseLabels, PRIORITY_OPTIONS, propertyKey, relationsOf, STATUS_OPTIONS, subIssues } from '../web/issues/view/issueViewModel.ts';
import fs from 'node:fs';
import { ISSUE_TEXT_MAX, ISSUE_TITLE_MAX } from '../shared/issues.ts';
import { WRITABLE } from '../web/issues/view/issueWritable.ts';

// The full-pane issue view (ACH-D41, ACH-D43 phase 4): what it shows, as pure rules.

let n = 0;
const issue = (over: Partial<SuperIssue> = {}): SuperIssue => ({
  id: `i${++n}`, key: `ACH-${n}`, title: `Issue ${n}`, text: `Issue ${n}`, projectId: null, status: 'todo', priority: 'none', labels: [], relations: [],
  order: n, createdAt: n, updatedAt: n, by: 'user', activity: [], ...over,
});

test('sub-issues in backlog order with a quiet "3/5": done over all but canceled; none, no count', () => {
  const parent = issue();
  const kids = [issue({ parentId: parent.id, status: 'done', order: 3 }), issue({ parentId: parent.id, status: 'in_progress', order: 1 }), issue({ parentId: parent.id, status: 'done', order: 2 }), issue({ parentId: parent.id, status: 'canceled', order: 4 }), issue({ parentId: parent.id, order: 5 })];
  const other = issue();
  const subs = subIssues([parent, ...kids, other], parent.id);
  assert.deepEqual(subs.items.map(i => i.order), [1, 2, 3, 4, 5]);
  assert.equal(subs.label, '2/4', 'canceled is left out of the count, not the list');
  assert.deepEqual(subIssues([parent, other], parent.id), { items: [], done: 0, total: 0, label: '' });
  assert.equal(parentOf([parent, ...kids], kids[0])?.id, parent.id);
  assert.equal(parentOf([parent], parent), undefined);
});

test('relations both ways: blocked by (from the other side), blocks, related, duplicates; removed issues dropped', () => {
  const a = issue(); const b = issue(); const c = issue(); const d = issue();
  a.relations = [{ type: 'blocks', issueId: b.id }, { type: 'related', issueId: c.id }, { type: 'duplicate_of', issueId: 'gone' }];
  c.relations = [{ type: 'blocks', issueId: a.id }];
  d.relations = [{ type: 'duplicate_of', issueId: a.id }];
  const all = [a, b, c, d];
  assert.deepEqual(relationsOf(all, a).map(r => [r.label, r.issue.key]), [['Blocked by', c.key], ['Blocks', b.key], ['Related to', c.key], ['Duplicated by', d.key]]);
  assert.deepEqual(relationsOf(all, b).map(r => [r.label, r.issue.key]), [['Blocked by', a.key]]);
});

test('the due date reads "Today", is amber today and red when overdue while open; quiet once closed', () => {
  const now = new Date(2026, 10, 13, 9);
  assert.deepEqual(dueTone('2026-11-13', 'todo', now), { tone: 'warning', text: 'Today, 13 Nov' });
  assert.deepEqual(dueTone('2026-11-12', 'in_progress', now), { tone: 'danger', text: 'Yesterday, 12 Nov' });
  assert.deepEqual(dueTone('2026-11-01', 'todo', now), { tone: 'danger', text: '1 Nov' });
  assert.deepEqual(dueTone('2026-11-14', 'todo', now), { tone: 'quiet', text: 'Tomorrow, 14 Nov' });
  assert.deepEqual(dueTone('2027-01-02', 'todo', now), { tone: 'quiet', text: '2 Jan 2027' });
  assert.equal(dueTone('2026-11-01', 'done', now)?.tone, 'quiet');
  assert.equal(dueTone(undefined, 'todo', now), null);
  assert.equal(dueTone('nonsense', 'todo', now), null);
});

test('activity lines in plain words, with who did it; a removed agent reads "An agent"', () => {
  const name = (id: string) => (id === 'fen' ? 'Fen' : undefined);
  const e = (over: Partial<IssueEvent>): IssueEvent => ({ at: 1, by: { kind: 'user' }, kind: 'created', ...over });
  assert.equal(activityLine(e({}), name), 'created the issue');
  assert.equal(activityLine(e({ kind: 'status', from: 'todo', to: 'in_progress' }), name), 'moved it from Todo to In progress');
  assert.equal(activityLine(e({ kind: 'priority', to: 'high' }), name), 'set priority High');
  assert.equal(activityLine(e({ kind: 'assignee', to: 'fen' }), name), 'assigned it to Fen');
  assert.equal(activityLine(e({ kind: 'assignee' }), name), 'unassigned it');
  assert.equal(activityLine(e({ kind: 'comment', text: 'x' }), name), 'commented');
  assert.deepEqual([{ kind: 'user' }, { kind: 'super' }, { kind: 'podcode' }, { kind: 'agent', id: 'fen' }, { kind: 'agent', id: 'gone' }, { kind: 'git' }].map(a => actorName(a as never, name)), ['You', 'SuperAgent', 'PodCode', 'Fen', 'An agent', 'git']);
  assert.equal(activityLine(e({ by: { kind: 'git' }, kind: 'status', from: 'in_review', to: 'done', text: 'feat/ACH-1-x merged into main' }), name), 'moved it from In review to Done (feat/ACH-1-x merged into main)');
});

test('pickers: every status (open first, then Done and Canceled) and priority; search by every word; labels parsed', () => {
  assert.deepEqual(STATUS_OPTIONS, ['needs_you', 'in_review', 'in_progress', 'waiting', 'todo', 'backlog', 'done', 'canceled']);
  assert.deepEqual(PRIORITY_OPTIONS, ['none', 'urgent', 'high', 'normal', 'low']);
  assert.equal(matchesQuery('In progress', 'prog in'), true);
  assert.equal(matchesQuery('In review', 'prog'), false);
  assert.deepEqual(parseLabels(' ui, issues\nUI ,, a-very-long-label-name-that-goes-on-and-on '), ['ui', 'issues', 'a-very-long-label-name-that-goes']);
});

test('S, P, D and L open the properties, but not while typing in a field or with a modifier', () => {
  const div = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget;
  const input = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.equal(propertyKey(key('s'), div), 'status');
  assert.equal(propertyKey(key('P'), div), 'priority');
  assert.equal(propertyKey(key('d'), div), 'due');
  assert.equal(propertyKey(key('l'), div), 'labels');
  assert.equal(propertyKey(key('s'), input), null);
  assert.equal(propertyKey(key('s', { metaKey: true }), div), null);
  assert.equal(propertyKey(key('x'), div), null);
});

test('Decisions: ids cited in the text, notes and comments, once each, decisions only; the links source swaps in one place', async () => {
  const i = issue({ text: 'Per ACH-D41 and ALL-D9, see ACH-N3.', notes: 'Also ACH-D41.', activity: [{ at: 1, by: { kind: 'user' }, kind: 'comment', text: 'And ACH-D46.' }] });
  assert.deepEqual(citedDecisions(i), ['ACH-D41', 'ALL-D9', 'ACH-D46']);
  assert.deepEqual(await localIssueLinks(i), { git: { commits: [] }, decisions: ['ACH-D41', 'ALL-D9', 'ACH-D46'], source: 'local' });
  const server = async () => ({ git: { branch: { name: 'feat/ACH-1-x' }, commits: [{ sha: 'abc1234', subject: 'x (ACH-1)' }] }, decisions: [], source: 'server' as const });
  setIssueLinksSource(server);
  assert.equal((await issueLinksSource()(i)).git.branch?.name, 'feat/ACH-1-x');
  setIssueLinksSource(localIssueLinks);
});

test('Hal\'s decisions route: its decisions first, then ones only the text cites; commits once, newest first; the branch most are on', () => {
  const i = issue({ text: 'Per ACH-D41.' });
  const links = fromServerDecisions(i, { issueId: i.id, key: i.key, decisions: [
    { id: 'ACH-D43', citations: [{ source: 'commit', hash: 'aaa1111', subject: 'old', branch: 'feat/x', projectId: 'p', ts: 1 }, { source: 'message', messageId: 'm' }] },
    { id: 'ALL-D9', citations: [{ source: 'commit', hash: 'bbb2222', subject: 'new', branch: 'feat/x', projectId: 'p', ts: 2 }, { source: 'commit', hash: 'aaa1111', branch: 'feat/x', ts: 1 }, { source: 'commit', hash: 'ccc3333', branch: 'main', ts: 0 }] },
  ] });
  assert.deepEqual(links.decisions, ['ACH-D43', 'ALL-D9', 'ACH-D41']);
  assert.deepEqual(links.git.commits.map(c => c.sha), ['bbb2222', 'aaa1111', 'ccc3333']);
  assert.deepEqual(links.git.branch, { name: 'feat/x', project: 'p' });
  assert.equal(links.source, 'server');
  assert.deepEqual(fromServerDecisions(i, { issueId: i.id, key: i.key, decisions: [] }).git, { commits: [] });
});

test('writes: every field the issue route takes is editable (Fen\'s feat/issues-api); an issue opens as its own tab', () => {
  assert.deepEqual(Object.entries(WRITABLE).filter(([, v]) => !v).map(([k]) => k), []);
  assert.equal(tabKey({ kind: 'issue', issueId: 'abc' }), 'issue:abc');
});

test('the editors use the model\'s limits (Rhea L1): 120 for a title, 4000 for a description', () => {
  assert.equal(TITLE_MAX, ISSUE_TITLE_MAX);
  assert.equal(TEXT_MAX, ISSUE_TEXT_MAX);
  const source = fs.readFileSync(new URL('../web/issues/view/EditableText.tsx', import.meta.url), 'utf8');
  assert.match(source, /maxLength=\{TITLE_MAX\}/);
  assert.match(source, /maxLength=\{TEXT_MAX\}/);
  assert.doesNotMatch(source, /maxLength=\{\d/, 'no number of its own');
});

test('title and description edits: what is saved, what reverts; line breaks in a description are kept (Rhea M1)', () => {
  assert.equal(titleToSave('  New   title \n', 'Old'), 'New title');
  assert.equal(titleToSave('Old', 'Old'), null, 'unchanged');
  assert.equal(titleToSave('   ', 'Old'), null, 'empty reverts');
  assert.equal(titleToSave('x'.repeat(200), 'Old')?.length, 120);
  const md = 'Steps:\n\n- open the view\n- press S\n\n```\ncode\n```';
  assert.equal(descriptionToSave(md, 'old'), md, 'kept as Markdown');
  assert.equal(descriptionToSave(md + '  \n\n\n', md), null, 'only trailing space and blank lines: unchanged');
  assert.equal(descriptionToSave('  ', 'old'), null);
});

test('the due date saves a whole day once the field is left, never a half-typed year (Rhea L5); clearing saves null', () => {
  assert.equal(dueToSave('2026-11-20', '2026-11-13'), '2026-11-20');
  assert.equal(dueToSave('0002-11-13', '2026-11-13'), undefined, 'a year being typed');
  assert.equal(dueToSave('2026-13-01', undefined), undefined);
  assert.equal(dueToSave('2026-11-13', '2026-11-13'), undefined, 'unchanged');
  assert.equal(dueToSave('', '2026-11-13'), null, 'cleared');
  assert.equal(dueToSave('', undefined), undefined);
});

test('an edit saves through one write; a refusal reverts; nothing to save writes nothing', async () => {
  const writes: unknown[] = [];
  const write = (ok: boolean) => async (v: unknown) => { writes.push(v); return ok; };
  assert.equal(await commitEdit('New', write(true)), 'saved');
  assert.equal(await commitEdit('Bad', write(false)), 'reverted');
  assert.equal(await commitEdit(null, write(true)), 'saved', 'null is a value (a cleared due date)');
  assert.equal(await commitEdit(undefined, write(true)), 'unchanged');
  assert.deepEqual(writes, ['New', 'Bad', null]);
});

test('relations: removing one writes the issue that holds it; adding one is the own list plus it, once, never itself', () => {
  const a = issue(); const b = issue(); const c = issue();
  a.relations = [{ type: 'blocks', issueId: b.id }];
  c.relations = [{ type: 'blocks', issueId: a.id }, { type: 'related', issueId: b.id }];
  const all = [a, b, c];
  const rows = relationsOf(all, a);
  const blocks = rows.find(r => r.label === 'Blocks')!;
  const blockedBy = rows.find(r => r.label === 'Blocked by')!;
  assert.deepEqual(relationRemoval(all, blocks, a.id), [{ id: a.id, relations: [] }], 'its own: this issue\'s list');
  assert.deepEqual(relationRemoval(all, blockedBy, a.id), [{ id: c.id, relations: [{ type: 'related', issueId: b.id }] }], 'from the other side: that issue\'s list, the rest kept');
  // "related" stored on both sides: one removal drops both copies (Ivy's nit).
  const x = issue(); const y = issue();
  x.relations = [{ type: 'related', issueId: y.id }]; y.relations = [{ type: 'related', issueId: x.id }, { type: 'blocks', issueId: x.id }];
  const related = relationsOf([x, y], x).find(r => r.label === 'Related to')!;
  assert.deepEqual(relationRemoval([x, y], related, x.id), [{ id: x.id, relations: [] }, { id: y.id, relations: [{ type: 'blocks', issueId: x.id }] }]);
  assert.deepEqual(withRelation(a, 'related', c.id), [{ type: 'blocks', issueId: b.id }, { type: 'related', issueId: c.id }]);
  assert.equal(withRelation(a, 'blocks', b.id), null, 'already there');
  assert.equal(withRelation(a, 'blocks', a.id), null, 'itself');
});

test('parent: any other issue, open ones first, never itself or one below it; assignee and comments as the API takes them', () => {
  const top = issue(); const mid = issue({ parentId: top.id }); const leaf = issue({ parentId: mid.id }); const done = issue({ status: 'done' }); const other = issue();
  const all = [top, mid, leaf, done, other];
  assert.deepEqual(parentCandidates(all, mid).map(i => i.id), [top.id, other.id, done.id]);
  assert.deepEqual(parentCandidates(all, top).map(i => i.id), [other.id, done.id], 'not its sub-issues or theirs');
  assert.equal(assigneeOf({ agentId: 'fen' }), 'fen');
  assert.equal(assigneeOf({ forUser: true }), 'user');
  assert.equal(assigneeOf({}), 'none');
  const name = (id: string) => (id === 'fen' ? 'Fen' : undefined);
  assert.equal(activityLine({ at: 1, by: { kind: 'user' }, kind: 'assignee', to: 'user' }, name), 'assigned it to you');
  assert.equal(commentToPost('  Looks good.\n\n- one\n- two  \n'), 'Looks good.\n\n- one\n- two');
  assert.equal(commentToPost('   \n '), undefined);
});

test('activity reads parent and relation changes with the issues\' keys (Fen\'s da575ac events)', () => {
  const agent = () => undefined;
  const keys = (id: string) => ({ p1: 'ACH-3', o7: 'ACH-7', o2: 'ACH-2' } as Record<string, string>)[id];
  const e = (over: Partial<IssueEvent>): IssueEvent => ({ at: 1, by: { kind: 'user' }, kind: 'parent', ...over });
  assert.equal(activityLine(e({ to: 'p1' }), agent, keys), 'set the parent to ACH-3');
  assert.equal(activityLine(e({ from: 'p1' }), agent, keys), 'removed the parent');
  assert.equal(activityLine(e({ kind: 'relation', to: 'blocks:o7' }), agent, keys), 'added a relation: blocks ACH-7');
  assert.equal(activityLine(e({ kind: 'relation', from: 'related:o2' }), agent, keys), 'removed a relation: related to ACH-2');
  assert.equal(activityLine(e({ kind: 'relation', to: 'duplicate_of:gone' }), agent, keys), 'added a relation: duplicate of a removed issue');
  assert.equal(activityLine(e({ kind: 'relation', to: 'o7' }), agent, keys), 'added a relation: ACH-7', 'a value with no type');
});

test('issue text renders inert: an openui-lang block in a description or comment never draws live UI (Ivy L1)', () => {
  for (const file of ['../web/issues/view/EditableText.tsx', '../web/issues/view/Activity.tsx']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const renders = source.match(/<Markdown\b[^>]*>/g) ?? [];
    assert.ok(renders.length > 0, file);
    for (const r of renders) assert.match(r, /\binert\b/, `${file}: ${r}`);
  }
});
