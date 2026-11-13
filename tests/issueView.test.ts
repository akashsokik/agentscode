import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssueEvent, SuperIssue } from '../shared/types.ts';
import { tabKey } from '../web/layout.ts';
import { citedDecisions, fromServerDecisions, issueLinksSource, localIssueLinks, setIssueLinksSource } from '../web/issues/view/issueLinks.ts';
import { activityLine, actorName, dueTone, matchesQuery, parentOf, parseLabels, PRIORITY_OPTIONS, propertyKey, relationsOf, STATUS_OPTIONS, subIssues } from '../web/issues/view/issueViewModel.ts';
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
  assert.deepEqual([{ kind: 'user' }, { kind: 'super' }, { kind: 'podcode' }, { kind: 'agent', id: 'fen' }, { kind: 'agent', id: 'gone' }].map(a => actorName(a as never, name)), ['You', 'SuperAgent', 'PodCode', 'Fen', 'An agent']);
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

test('writes: only what the issue route takes is editable; an issue opens as its own tab', () => {
  assert.deepEqual(Object.entries(WRITABLE).filter(([, v]) => v).map(([k]) => k).sort(), ['dueDate', 'labels', 'priority', 'projectId', 'status', 'text', 'title']);
  assert.deepEqual(Object.entries(WRITABLE).filter(([, v]) => !v).map(([k]) => k).sort(), ['assignee', 'comment', 'parent', 'relations']);
  assert.equal(tabKey({ kind: 'issue', issueId: 'abc' }), 'issue:abc');
});
