import assert from 'node:assert/strict';
import test from 'node:test';
import type { SuperIssue } from '../shared/types.ts';
import {
  activeFilters, chipText, clearFilter, DEFAULT_DISPLAY, displayedIssues, displayFrom, dueBucket, filterOptions, groupIssues, inView, issuesPage, localDay,
  matchesFilters, matchesQuery, NONE, readDisplay, saveDisplay, sortIssues, toggleFilter, YOU, type IssuesDisplay,
  neighbourAfterLeaving, revealIssue, issueToShow,
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

test('the Issues page is the shared inbox layout: a card click selects the issue and its detail shows beside the list (ACH-D54)', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const page = read('../web/issues/IssuesPage.tsx');
  assert.match(page, /from '\.\.\/ui\/Inbox\.tsx'/, 'it imports the shared layout, not a copy');
  assert.match(page, /<InboxLayout\b/);
  assert.match(page, /<InboxList label="Issues" onMove=\{move\}/, 'the arrow keys move the selection');
  assert.match(page, /onRailKeyDown=\{onRailKeyDown\}/, 'J and K move it too, only from the rail (Cy\'s onRailKeyDown), not from the detail');
  assert.match(page, /detail=\{selected && issues \? <IssueInboxDetail key=\{selected\.id\}/, 'the selected issue (or the first, as Comms) shows on the right');
  assert.match(page, /detailOpen=\{detailOpen\}/);
  assert.match(page, /const detailOpen = Boolean\(asked\) && !peek;/, 'in a narrow pane, the detail replaces the list once one is picked on purpose, not while the arrows move (ACH-23)');
  assert.match(page, /const select = \(id: string\) => \{ movedTo\.current = undefined; setPeek\(false\); showIssueInList\(id\); \};/, 'a click selects the issue in the page and opens its detail');
  assert.match(page, /onSelect=\{\(\) => select\(issue\.id\)\}/);
  assert.match(page, /\{!issues \? <Loading \/>/, 'while the issues load, Loading, not "Nothing is active" (ACH-23)');
  assert.doesNotMatch(page, /PanelRow|IssueRow|openIssue\(/, 'no inline rows, no jump to a tab');
  const inbox = read('../web/issues/IssueInbox.tsx');
  assert.match(inbox, /<InboxCard\b[\s\S]*?onSelect=\{select\}/);
  assert.match(inbox, /const select = onSelect;/, 'a click selects through the page');
  assert.match(inbox, /isMenuKey\(e\)[\s\S]*?setMenu\(e\.target as HTMLElement\)/, 'the card menu opens from the keyboard (ACH-23)');
  assert.match(inbox, /<InboxBarButton\b[\s\S]*?label=\{copied \? 'Copied' : 'Copy key'\}/, 'Copy key sits in the bar, as Comms\' Stop (ACH-23)');
  assert.match(inbox, /heading=\{<IssueTitle id=\{issue\.id\} title=\{issue\.title\} size="text-\[18px\]" \/>\}/, 'the title edits in place in the hero (Cy\'s heading slot, ACH-23)');
  assert.match(inbox, /copyKey=\{false\}/, 'and not twice: the properties leave their Copy key row out here');
  assert.match(inbox, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); onBack\(\); return; \}/, 'Esc in the detail goes back to the list (MonoCode closes its detail on Esc)');
  assert.match(inbox, /<InboxDetail\b/);
  // Only CommsPane's own parts (the user, via Cy): stacked sections, no tabs, no MonoCode action buttons.
  assert.doesNotMatch(inbox, /InboxTabs|ACTION_(FILLED|OUTLINE|GHOST)/, 'nothing Comms does not use');
  assert.match(inbox, /<InboxSection title="Description">[\s\S]*<InboxSection title="Properties">/, 'Description, then Properties, as stacked sections');
  for (const piece of ['PropertySidebar', 'IssueDescription', 'SubIssues', 'Relations', 'InGit', 'Decisions', 'Activity']) assert.match(inbox, new RegExp(`<${piece}\\b`), `Ada's ${piece}`);
  const panel = read('../web/panes/SuperPanel.tsx');
  const item = panel.slice(panel.indexOf('function IssueItem('), panel.indexOf('export function RoutinesView'));
  assert.match(item, /onOpen=\{\(\) => showIssueInList\(issue\.id\)\}/, 'a panel row shows the issue on the Issues page');
  assert.match(item, /title="Open" shortcut="Enter" onSelect=\{\(\) => \{ close\(\); showIssueInList\(issue\.id\); \}\}/, 'and so does Open in its menu');
  // It unfolds only to rename (Edit title) or to confirm a removal armed from the menu.
  assert.match(item, /expanded=\{inline \? true : undefined\}/);
  assert.doesNotMatch(item, /\{issue\.text\}/, 'no description shown in the row');
  assert.match(item, /aria-label=\{`Title of \$\{named\}`\}/, 'Edit title stays');
});

test('the right panel opens the Issues page with the issue selected; one Issues tab keeps the newest selection', async () => {
  const { getLayout } = await import('../web/layout.ts');
  const { showIssueInList } = await import('../web/issues/openIssue.ts');
  const issuesTabs = () => getLayout().tabs.filter(t => t.content.kind === 'issues');
  const before = issuesTabs().length;
  showIssueInList('a');
  showIssueInList('b');
  assert.equal(issuesTabs().length, Math.max(before, 1), 'one Issues tab');
  assert.deepEqual(issuesTabs()[0].content, { kind: 'issues', issueId: 'b' });
  const shown = getLayout().tabs.find(t => t.id === getLayout().panes.find(p => p.id === getLayout().focused)?.tabId)?.content;
  assert.deepEqual(shown, { kind: 'issues', issueId: 'b' }, 'and it is the one shown');
});

test('an issue opened from elsewhere is revealed: All when the view leaves it out, filters and search cleared when they hide it', () => {
  const base = { view: 'active' as const, filters: {}, query: '', display: DEFAULT_DISPLAY };
  assert.equal(revealIssue(issue('i1', { status: 'todo' }), base, TODAY), null, 'already shown');
  assert.deepEqual(revealIssue(issue('i2', { status: 'backlog' }), base, TODAY), { view: 'all' });
  assert.deepEqual(revealIssue(issue('i3', { status: 'done' }), base, TODAY), { view: 'all' });
  assert.deepEqual(revealIssue(issue('i4', { status: 'todo', labels: ['ui'] }), { ...base, filters: { labels: ['git'] }, query: 'nothing like it' }, TODAY), { filters: {}, query: '' });
  assert.deepEqual(revealIssue(issue('i5', { status: 'canceled' }), { ...base, view: 'all' }, TODAY), null, 'All shows closed issues too');
});

test('the right panel keeps the SuperAgent\'s tabs while the Issues page, an issue or the Pull requests page is in front (ACH-D55)', async () => {
  const { keepsSuperPanel } = await import('../web/layout.ts');
  for (const kind of ['issues', 'issue', 'pullRequests'] as const) assert.equal(keepsSuperPanel(kind), true, kind);
  for (const kind of ['agent', 'comms', 'file', 'channel', 'work', 'browser'] as const) assert.equal(keepsSuperPanel(kind), false, kind);
  assert.equal(keepsSuperPanel(null), false, 'no tab');
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../web/right/RightPanel.tsx', import.meta.url), 'utf8');
  assert.match(panel, /const followsSuper = keepsSuperPanel\(focusedKind\(layout\)\);/);
  assert.match(panel, /followsSuper \? s\.snapshot\?\.agents\.find\(a => a\.role === 'super'\)/, 'the panel takes the SuperAgent as its agent then');
});

test('the detail keeps its issue: the asked one while it exists, else the last shown while listed, else the first (ACH-23)', () => {
  assert.equal(issueToShow(['a', 'b'], 'x', true, 'a'), 'x', 'asked for, even if a filter hides it');
  assert.equal(issueToShow(['b', 'a'], undefined, false, 'a'), 'a', 'a live update reorders the list: the detail stays');
  assert.equal(issueToShow(['b', 'c'], 'gone', false, 'a'), 'b', 'the last shown left: the first listed');
  assert.equal(issueToShow([], undefined, false, 'a'), undefined);
});

test('when the shown issue leaves the list, the selection goes to its neighbour as the list stood (ACH-23)', () => {
  assert.equal(neighbourAfterLeaving(['a', 'b', 'c'], ['a', 'c'], 'b'), 'c', 'the next one');
  assert.equal(neighbourAfterLeaving(['a', 'b', 'c'], ['a', 'b'], 'c'), 'b', 'the last: the one before');
  assert.equal(neighbourAfterLeaving(['a', 'b', 'c'], ['a'], 'b'), 'a', 'the next left too: the nearest before');
  assert.equal(neighbourAfterLeaving(['a', 'b'], ['a', 'b'], 'b'), null, 'still listed');
  assert.equal(neighbourAfterLeaving(['a'], [], 'a'), null, 'nothing left');
  assert.equal(neighbourAfterLeaving(['a'], ['a'], 'z'), null, 'was not listed');
});

test('a title left mid-edit saves only what was typed: a stored title is never tidied by passing through (ACH-23)', async () => {
  const { titleToSaveOnLeave } = await import('../web/issues/view/issueViewModel.ts');
  assert.equal(titleToSaveOnLeave('a  b', 'a  b'), null, 'untouched, even if it has a double space');
  assert.equal(titleToSaveOnLeave('New name', 'Old name'), 'New name');
  assert.equal(titleToSaveOnLeave('', 'Old name'), null, 'emptied: nothing saved');
  const { readFileSync } = await import('node:fs');
  const sections = readFileSync(new URL('../web/issues/view/Sections.tsx', import.meta.url), 'utf8');
  const line = sections.slice(sections.indexOf('export function IssueLine('), sections.indexOf('export function IssueLine(') + 900);
  assert.match(line, /onClick=\{\(\) => showIssueInList\(issue\.id\)\}/, 'sub-issue and relation lines select on the Issues page, no issue tab (ACH-D54)');
});

test('Hal\'s audit: focus follows the selection to the detail when a narrow pane hides its card; the issue tab stacks when narrow (ACH-23)', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const page = read('../web/issues/IssuesPage.tsx');
  assert.match(page, /if \(card && card\.offsetParent !== null\) card\.focus\(/, 'the card only when it shows');
  assert.match(page, /querySelector<HTMLElement>\('\[data-issue-detail\]'\)\?\.focus\(/, 'else the detail');
  assert.match(read('../web/issues/IssueInbox.tsx'), /data-issue-detail\s+tabIndex=\{-1\}/);
  const view = read('../web/issues/IssueView.tsx');
  assert.match(view, /<div className="@container\/issueview flex min-h-0 flex-1 flex-col">\s*<div\b/, 'the container is a wrapper: a container query cannot ask its own element');
  assert.match(view, /className="flex min-h-0 flex-1 flex-col overflow-y-auto @min-\[44rem\]\/issueview:flex-row/, 'stacked below 44rem, side by side above');
  assert.match(view, /onClick=\{\(\) => showIssueInList\(parent\.id\)\}/, 'the parent crumb selects on the Issues page, no new tab');
});

test('In git reads loading, failed and found-nothing apart: only a server read says nothing names the issue (Hal\'s audit, ACH-23)', async () => {
  const { linksStatus } = await import('../web/issues/view/issueLinks.ts');
  const server = { git: { commits: [] }, decisions: [], source: 'server' as const };
  const local = { git: { commits: [] }, decisions: ['ACH-D1'], source: 'local' as const };
  assert.equal(linksStatus({ id: 'a', links: null, failed: false }, 'a'), 'loading', 'in flight');
  assert.equal(linksStatus({ id: 'a', links: server, failed: false }, 'b'), 'loading', 'another issue\'s links: this one is loading');
  assert.equal(linksStatus({ id: 'a', links: server, failed: false }, 'a'), 'ready', 'read: an empty answer may say nothing names it');
  assert.equal(linksStatus({ id: 'a', links: local, failed: false }, 'a'), 'failed', 'the server did not answer: the local stand-in is not a read');
  assert.equal(linksStatus({ id: 'a', links: null, failed: true }, 'a'), 'failed', 'rejected');
  assert.equal(linksStatus({ id: 'a', links: server, failed: true }, 'a'), 'ready', 'a failed refresh keeps the last read');
});

test('the issue view sections sit on the shared primitives, with no hand-built copies (ACH-36)', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const sections = read('../web/issues/view/Sections.tsx');
  assert.match(sections, /<Segmented label="Relation"/, 'the relation chooser is the settings\' Segmented');
  assert.doesNotMatch(sections, /role="radiogroup"|role="radio"/, 'no hand-built radio row left');
  assert.match(sections, /<KeyValueList\s+labelWidth="6rem"/, 'In git is the shared label/value list');
  assert.doesNotMatch(sections, /w-24 shrink-0 text-content\/45">(Branch|Closes)/, 'no hand-built label column left in In git');
  const activity = read('../web/issues/view/Activity.tsx');
  assert.match(activity, /<TimelineStop first=\{first\} last=\{last\}/, 'each event is a stop on the shared timeline');
  assert.match(activity, /embedded \? <InboxSection title="Activity"/, 'an InboxSection on the Issues page; the issue tab keeps its section header');
  assert.match(read('../web/issues/IssueInbox.tsx'), /<Activity issue=\{issue\} embedded \/>/);
  assert.match(read('../web/ui/KeyValueList.tsx'), /<dt className="[^"]*self-start/, 'a label stays on the first line of a value of several lines');
});
