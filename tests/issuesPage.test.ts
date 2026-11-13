import assert from 'node:assert/strict';
import test from 'node:test';
import type { SuperIssue } from '../shared/types.ts';
import {
  activeFilters, chipText, clearFilter, DEFAULT_DISPLAY, displayedIssues, displayFrom, dueBucket, filterOptions, groupIssues, inView, issuesPage, localDay,
  matchesFilters, matchesQuery, NONE, readDisplay, saveDisplay, sortIssues, toggleFilter, YOU, type IssuesDisplay,
} from '../web/issues/issuesView.ts';
import { isPageKey } from '../web/issues/pageKeys.ts';
import { knownTabs, tabKey, TAB_KINDS } from '../web/layout.ts';

const names = { agent: (id: string) => ({ ada: 'Ada', bo: 'Bo' } as Record<string, string>)[id], project: (id: string) => ({ p1: 'PodCode', p2: 'Orca' } as Record<string, string>)[id] };
const TODAY = '2026-11-13';

function issue(id: string, over: Partial<SuperIssue> = {}): SuperIssue {
  const n = Number(id.replace(/\D/g, '')) || 1;
  return { id, key: `ACH-${n}`, title: `Issue ${id}`, text: `Issue ${id}`, projectId: null, status: 'todo', priority: 'none', labels: [], relations: [], activity: [], order: n, createdAt: n, updatedAt: n, by: 'user', ...over };
}

test('views: All has everything, Active is open past the backlog, Backlog its status, Mine yours or waiting on you', () => {
  const list = [
    issue('i1', { status: 'needs_you' }), issue('i2', { status: 'in_progress' }), issue('i3', { status: 'backlog' }),
    issue('i4', { status: 'done' }), issue('i5', { status: 'todo', forUser: true }), issue('i6', { status: 'canceled' }),
  ];
  const ids = (view: Parameters<typeof inView>[1]) => list.filter(g => inView(g, view)).map(g => g.id);
  assert.deepEqual(ids('all'), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']);
  assert.deepEqual(ids('active'), ['i1', 'i2', 'i5']);
  assert.deepEqual(ids('backlog'), ['i3']);
  assert.deepEqual(ids('mine'), ['i1', 'i5']);
});

test('due dates fall in buckets from today: overdue, today, this week (six days on), later, none', () => {
  assert.equal(dueBucket('2026-11-12', TODAY), 'overdue');
  assert.equal(dueBucket('2026-11-13', TODAY), 'today');
  assert.equal(dueBucket('2026-11-19', TODAY), 'week');
  assert.equal(dueBucket('2026-11-20', TODAY), 'later');
  assert.equal(dueBucket(undefined, TODAY), 'none');
  assert.equal(dueBucket('not a day', TODAY), 'none');
  assert.equal(localDay(new Date(2026, 10, 3, 23, 30).getTime()), '2026-11-03', 'local time, padded');
});

test('filters: any value within a property, every property across them; toggling drops an emptied property', () => {
  const a = issue('i1', { status: 'todo', priority: 'high', agentId: 'ada', labels: ['ui'] });
  const b = issue('i2', { status: 'in_progress', priority: 'high', forUser: true, projectId: 'p1' });
  const c = issue('i3', { status: 'todo', priority: 'low', dueDate: '2026-11-10' });
  let f = toggleFilter({}, 'status', 'todo');
  f = toggleFilter(f, 'status', 'in_progress');
  assert.deepEqual([a, b, c].filter(g => matchesFilters(g, f, TODAY)).map(g => g.id), ['i1', 'i2', 'i3']);
  f = toggleFilter(f, 'priority', 'high');
  assert.deepEqual([a, b, c].filter(g => matchesFilters(g, f, TODAY)).map(g => g.id), ['i1', 'i2']);
  assert.ok(matchesFilters(b, { assignee: [YOU] }, TODAY));
  assert.ok(matchesFilters(c, { assignee: [NONE], project: [NONE], labels: [NONE], due: ['overdue'] }, TODAY));
  assert.ok(!matchesFilters(a, { labels: [NONE] }, TODAY));
  assert.deepEqual(toggleFilter({ status: ['todo'] }, 'status', 'todo'), {}, 'the last value off removes the property');
  assert.deepEqual(clearFilter(f, 'priority'), { status: ['todo', 'in_progress'] });
  assert.deepEqual(activeFilters({ priority: ['high'], status: ['todo'], labels: [] }).map(x => x.property), ['status', 'priority'], 'in menu order, empty ones left out');
});

test('chips read as sentences: one or two values by name, more as a count', () => {
  assert.equal(chipText('status', ['todo'], names), 'Status is Todo');
  assert.equal(chipText('status', ['todo', 'in_progress'], names), 'Status is Todo, In progress');
  assert.equal(chipText('labels', ['a', 'b', 'c'], names), 'Labels is any of 3');
  assert.equal(chipText('assignee', [YOU, 'ada'], names), 'Assignee is You, Ada');
  assert.equal(chipText('project', [NONE], names), 'Project is No project');
  assert.equal(chipText('assignee', ['gone'], names), 'Assignee is Removed agent');
  assert.equal(chipText('due', ['today'], names), 'Due date is Due today');
});

test('submenu options: fixed values always listed, others as used, counted within the other filters', () => {
  const list = [
    issue('i1', { status: 'todo', agentId: 'bo', labels: ['ui', 'web'] }),
    issue('i2', { status: 'todo', agentId: 'ada', priority: 'high' }),
    issue('i3', { status: 'done', forUser: true, priority: 'high' }),
  ];
  const status = filterOptions(list, 'status', { priority: ['high'] }, TODAY, names);
  assert.equal(status.length, 8, 'every status');
  assert.deepEqual(status.filter(o => o.count).map(o => [o.value, o.count]), [['todo', 1], ['done', 1]], 'counted among high priority only');
  assert.deepEqual(filterOptions(list, 'status', { status: ['done'] }, TODAY, names).find(o => o.value === 'todo')?.count, 2, 'its own filter does not narrow its counts');
  assert.deepEqual(filterOptions(list, 'assignee', {}, TODAY, names).map(o => o.label), ['You', 'Ada', 'Bo']);
  assert.deepEqual(filterOptions(list, 'labels', {}, TODAY, names).map(o => [o.value, o.count]), [['ui', 1], ['web', 1], [NONE, 2]]);
  assert.deepEqual(filterOptions(list, 'project', { project: ['p2'] }, TODAY, names).map(o => o.label), ['Orca', 'No project'], 'a chosen value stays listed though no issue has it');
});

test('search matches every word in the key, title, description or labels', () => {
  const g = issue('i7', { title: 'Fix the sidebar', text: 'Fix the sidebar. It flickers on resize.', labels: ['ui'] });
  assert.ok(matchesQuery(g, 'ach-7'));
  assert.ok(matchesQuery(g, 'sidebar FLICKERS'));
  assert.ok(matchesQuery(g, 'ui fix'));
  assert.ok(!matchesQuery(g, 'sidebar crash'));
  assert.ok(matchesQuery(g, '   '));
});

test('ordering: backlog order with closed last (newest closed first), or by priority, updated, created or due', () => {
  const list = [
    issue('i1', { order: 2, priority: 'low', updatedAt: 5, createdAt: 1, dueDate: '2026-12-01' }),
    issue('i2', { order: 0, priority: 'urgent', updatedAt: 3, createdAt: 2 }),
    issue('i3', { order: 1, priority: 'high', updatedAt: 9, createdAt: 3, dueDate: '2026-11-20' }),
    issue('i4', { status: 'done', doneAt: 10, order: 9 }),
    issue('i5', { status: 'canceled', canceledAt: 20, order: 8 }),
  ];
  const ids = (o: Parameters<typeof sortIssues>[1]) => sortIssues(list, o).map(g => g.id);
  assert.deepEqual(ids('manual'), ['i2', 'i3', 'i1', 'i5', 'i4']);
  assert.deepEqual(ids('priority'), ['i2', 'i3', 'i1', 'i5', 'i4'], 'ties (no priority) fall back to the backlog order');
  assert.deepEqual(ids('updated'), ['i3', 'i1', 'i5', 'i4', 'i2'], 'newest first; a tie keeps open before closed');
  assert.deepEqual(ids('created').slice(0, 3), ['i5', 'i4', 'i3']);
  assert.deepEqual(ids('due'), ['i3', 'i1', 'i2', 'i5', 'i4'], 'soonest first, none last');
});

test('grouping by status puts the closed groups last and marks them to fold; empty groups only on request', () => {
  const list = [issue('i1', { status: 'todo' }), issue('i2', { status: 'needs_you' }), issue('i3', { status: 'done' })];
  const groups = groupIssues(list, DEFAULT_DISPLAY, names, TODAY);
  assert.deepEqual(groups.map(g => [g.key, g.items.length, g.closed]), [['needs_you', 1, false], ['todo', 1, false], ['done', 1, true]]);
  const all = groupIssues(list, { ...DEFAULT_DISPLAY, showEmptyGroups: true }, names, TODAY);
  assert.equal(all.length, 8);
  assert.equal(groupIssues(list.slice(0, 2), { ...DEFAULT_DISPLAY, showEmptyGroups: true, showClosed: false }, names, TODAY).length, 6, 'hidden closed groups stay out');
});

test('grouping by assignee, project or priority, or not at all', () => {
  const list = [issue('i1', { agentId: 'bo' }), issue('i2', { forUser: true, projectId: 'p2', priority: 'high' }), issue('i3', { projectId: 'p1' })];
  const by = (groupBy: IssuesDisplay['groupBy']) => groupIssues(list, { ...DEFAULT_DISPLAY, groupBy }, names, TODAY).map(g => [g.label, g.items.map(i => i.id).join()]);
  assert.deepEqual(by('assignee'), [['You', 'i2'], ['Bo', 'i1'], ['No assignee', 'i3']]);
  assert.deepEqual(by('project'), [['Orca', 'i2'], ['PodCode', 'i3'], ['No project', 'i1']]);
  assert.deepEqual(by('priority'), [['High', 'i2'], ['No priority', 'i1,i3']]);
  assert.deepEqual(by('none'), [['Issues', 'i1,i2,i3']]);
  assert.deepEqual(groupIssues([], { ...DEFAULT_DISPLAY, groupBy: 'none' }, names, TODAY), []);
});

test('the page: view counts follow the filters and search; sub-issues and closed ones follow the Display', () => {
  const list = [
    issue('i1', { status: 'todo', labels: ['ui'] }), issue('i2', { status: 'backlog', labels: ['ui'] }),
    issue('i3', { status: 'todo', parentId: 'i1', labels: ['ui'] }), issue('i4', { status: 'done', labels: ['ui'] }), issue('i5', { status: 'todo' }),
  ];
  const page = (over: Partial<Parameters<typeof issuesPage>[1]> = {}, display: Partial<IssuesDisplay> = {}) =>
    issuesPage(list, { view: 'all', filters: { labels: ['ui'] }, query: '', display: { ...DEFAULT_DISPLAY, ...display }, ...over }, names, TODAY);
  assert.deepEqual(page().counts, { all: 4, active: 2, backlog: 1, mine: 0 });
  assert.equal(page({}, { showSubIssues: false }).counts.all, 3);
  assert.equal(page({}, { showClosed: false }).counts.all, 3);
  const active = page({ view: 'active', query: 'nothing like this' });
  assert.equal(active.shown, 0);
  assert.equal(active.inView, 3, 'the view has issues; the filters hide them');
  assert.equal(issuesPage(undefined, { view: 'all', filters: {}, query: '', display: DEFAULT_DISPLAY }, names, TODAY).shown, 0);
});

test('display options are read back field by field, defaults for anything wrong, and survive a broken store', () => {
  assert.deepEqual(displayFrom(null), DEFAULT_DISPLAY);
  assert.deepEqual(displayFrom({ groupBy: 'project', orderBy: 'nonsense', showClosed: false, properties: ['updated', 'key', 'bogus'] }), {
    ...DEFAULT_DISPLAY, groupBy: 'project', showClosed: false, properties: ['key', 'updated'],
  });
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  saveDisplay({ ...DEFAULT_DISPLAY, groupBy: 'priority' }, storage);
  assert.equal(readDisplay(storage).groupBy, 'priority');
  assert.deepEqual(readDisplay({ getItem: () => '{broken' }), DEFAULT_DISPLAY);
  assert.deepEqual(readDisplay(undefined), DEFAULT_DISPLAY);
  assert.doesNotThrow(() => saveDisplay(DEFAULT_DISPLAY, { setItem: () => { throw new Error('full'); } }));
});

test('without Sub-issues, an issue whose parent is gone still shows, as top-level', () => {
  const list = [issue('i1'), issue('i2', { parentId: 'i1' }), issue('i3', { parentId: 'removed' })];
  assert.deepEqual(displayedIssues(list, { showSubIssues: false, showClosed: true }).map(g => g.id), ['i1', 'i3']);
  assert.deepEqual(displayedIssues(list, { showSubIssues: true, showClosed: true }).map(g => g.id), ['i1', 'i2', 'i3']);
  assert.equal(issuesPage(list, { view: 'all', filters: {}, query: '', display: { ...DEFAULT_DISPLAY, showSubIssues: false } }, names, TODAY).shown, 2);
});

test('the page\'s own keys (F, J, K) skip modifiers, fields, menus and anything outside the list', () => {
  const root = { inside: true };
  const el = (over: { closest?: string | null; editable?: boolean; outside?: boolean } = {}) => ({
    isContentEditable: Boolean(over.editable),
    closest: (sel: string) => (over.closest && sel.includes(over.closest) ? {} : null),
    outside: Boolean(over.outside),
  });
  const ev = (target: ReturnType<typeof el>, keys: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented', boolean>> = {}) => ({
    target, currentTarget: { contains: (t: { outside: boolean }) => !t.outside && Boolean(root.inside) }, ...keys,
  }) as unknown as Parameters<typeof isPageKey>[0];
  assert.equal(isPageKey(ev(el())), true, 'a row');
  assert.equal(isPageKey(ev(el(), { metaKey: true })), false);
  assert.equal(isPageKey(ev(el(), { defaultPrevented: true })), false);
  assert.equal(isPageKey(ev(el({ closest: 'input' }))), false, 'typing in the search');
  assert.equal(isPageKey(ev(el({ closest: '[role="menu"]' }))), false, 'in a menu');
  assert.equal(isPageKey(ev(el({ editable: true }))), false);
  assert.equal(isPageKey(ev(el({ outside: true }))), false, 'from a portal (a popover) outside the list');
});

test('an Issues tab is a known kind: it survives a layout reload', () => {
  assert.ok((TAB_KINDS as readonly string[]).includes('issues'));
  assert.equal(tabKey({ kind: 'issues' }), 'issues');
  const out = knownTabs([{ id: 't1', content: { kind: 'issues' } }] as never, [{ id: 'p1', tabId: 't1' }]);
  assert.deepEqual(out.tabs.map(t => t.id), ['t1']);
  assert.deepEqual(out.panes, [{ id: 'p1', tabId: 't1' }]);
});

test('the right panel\'s Edit renames the issue: one line at ISSUE_TITLE_MAX, saving only the title, never the description', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../web/panes/SuperPanel.tsx', import.meta.url), 'utf8');
  const item = src.slice(src.indexOf('function IssueItem('), src.indexOf('export function RoutinesView'));
  assert.ok(item.length > 0, 'IssueItem found');
  // The field: an input bound to the title, capped at the title's limit.
  assert.match(item, /<input[^>]*?\n?\s*aria-label=\{`Title of \$\{named\}`\}[\s\S]*?value=\{title\}[\s\S]*?maxLength=\{ISSUE_TITLE_MAX\}/);
  // Saving sends the title alone; the description (issue.text) is never sent from here.
  assert.match(item, /api\.updateIssue\(issue\.id, \{ title: title\.trim\(\) \}\)/);
  assert.doesNotMatch(item, /api\.updateIssue\(issue\.id, \{ text:/);
  assert.doesNotMatch(item, /<textarea/);
});

test('opening an issue shows its issue view in a tab; the same issue focuses the tab it already has', async () => {
  const { getLayout } = await import('../web/layout.ts');
  const { issueTab, openIssue } = await import('../web/issues/openIssue.ts');
  assert.deepEqual(issueTab('i1'), { kind: 'issue', issueId: 'i1' });
  const issueTabs = () => getLayout().tabs.filter(t => t.content.kind === 'issue');
  const shown = () => getLayout().tabs.find(t => t.id === getLayout().panes.find(p => p.id === getLayout().focused)?.tabId)?.content;
  const before = issueTabs().length;
  openIssue('i1');
  assert.equal(issueTabs().length, before + 1);
  assert.deepEqual(shown(), { kind: 'issue', issueId: 'i1' }, 'the focused pane shows it');
  openIssue('i2');
  openIssue('i1');
  assert.equal(issueTabs().length, before + 2, 'i1 is not opened twice');
  assert.deepEqual(shown(), { kind: 'issue', issueId: 'i1' }, 'its tab is shown again');
});

test('both issue lists open the issue view on a click, Enter or Open; neither unfolds a row to show details', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const parts = read('../web/issues/issueParts.tsx');
  const row = parts.slice(parts.indexOf('export function IssueRow('), parts.indexOf('export function MenuPage'));
  assert.match(row, /onOpen = \(\) => openIssue\(issue\.id\)/, 'the page row opens the issue view by default');
  assert.doesNotMatch(row, /expanded=/, 'the page row has no expand');
  assert.match(read('../web/issues/IssuesPage.tsx'), /<IssueRow key=\{issue\.id\} issue=\{issue\} properties=\{display\.properties\} today=\{today\} now=\{now\} \/>/);
  const panel = read('../web/panes/SuperPanel.tsx');
  const item = panel.slice(panel.indexOf('function IssueItem('), panel.indexOf('export function RoutinesView'));
  assert.match(item, /onOpen=\{\(\) => openIssue\(issue\.id\)\}/, 'a panel row opens the issue view');
  assert.match(item, /title="Open" shortcut="Enter" onSelect=\{\(\) => \{ close\(\); openIssue\(issue\.id\); \}\}/, 'and so does Open in its menu');
  // It unfolds only to rename (Edit title) or to confirm a removal armed from the menu.
  assert.match(item, /expanded=\{inline \? true : undefined\}/);
  assert.match(item, /const inline = editing \|\| \(confirming && confirmInline\);/);
  assert.doesNotMatch(item, /\{issue\.text\}/, 'no description shown in the row');
  assert.match(item, /aria-label=\{`Title of \$\{named\}`\}/, 'Edit title stays');
});
