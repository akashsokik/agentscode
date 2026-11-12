import assert from 'node:assert/strict';
import test from 'node:test';
import type { SuperAction, SuperAsk, SuperIssue, SuperRoutine } from '../shared/types.ts';
import { authorLabel, cleanSummary, dayLabel, decisionGroups, decisionKind, focusAfterRemoval, isKeyboardFocus, issueGroups, issueMoves, groupByDay, isMenuKey, matches, notesSections, routineGroups, shortSchedule, shortWhen } from '../web/panelList.ts';

// The SuperAgent's right-panel tabs read alike (ACH-D37): one line per item, grouped, searched and
// filtered the same way.

const NOW = new Date(2026, 10, 12, 15, 40).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

test('times and days: "15:38" today, "11 Nov" before; Today, Yesterday, then the date', () => {
  assert.equal(shortWhen(at(12, 15, 38), NOW), '15:38');
  assert.equal(shortWhen(at(11, 9, 5), NOW), '11 Nov');
  assert.equal(dayLabel(at(12, 0, 1), NOW), 'Today');
  assert.equal(dayLabel(at(11, 23, 59), NOW), 'Yesterday');
  assert.equal(dayLabel(at(9, 12), NOW), '9 Nov');
});

test('grouping by day: newest first, one group per day, items keep newest-first order inside', () => {
  const items = [{ t: at(11, 9) }, { t: at(12, 15) }, { t: at(12, 9) }, { t: at(10, 8) }, { t: at(11, 20) }];
  const groups = groupByDay(items, i => i.t, NOW);
  assert.deepEqual(groups.map(g => g.label), ['Today', 'Yesterday', '10 Nov']);
  assert.deepEqual(groups.map(g => g.items.map(i => new Date(i.t).getHours())), [[15, 9], [20, 9], [8]]);
});

test('search: every word, any order and case, in any of the fields; an empty query matches all', () => {
  assert.equal(matches('', 'anything'), true);
  assert.equal(matches('  ', undefined), true);
  assert.equal(matches('rhea REVIEW', 'Delegated review to Rhea'), true);
  assert.equal(matches('rhea fen', 'Delegated review to Rhea', 'why: Fen is busy'), true, 'words can sit in different fields');
  assert.equal(matches('rhea cy', 'Delegated review to Rhea'), false);
});

test('Decisions: actions or answers by filter, searched over summary and why; counts ignore the search; the dots a cut summary ends in go', () => {
  const log = [
    { id: 'a', at: at(12, 15), tool: 'delegate_task', summary: 'Delegated implementation to Ada: polish...', why: 'the user asked' },
    { id: 'b', at: at(11, 9), tool: 'send_message', summary: 'Messaged Rhea: review', why: '' },
    { id: 'c', at: at(12, 9), tool: 'create_channel', summary: 'Made #ops', why: 'Fen and Cy share it' },
  ] as SuperAction[];
  const asks = [
    { id: 'q1', question: 'Restart now?', options: [], createdAt: 1, answeredAt: at(12, 10), answer: 'Yes' },
    { id: 'q2', question: 'Push?', options: [], createdAt: 1 },
  ] as SuperAsk[];
  const all = decisionGroups(log, asks, 'actions', '', NOW);
  assert.deepEqual(all.counts, { actions: 3, answers: 1 }, 'only answered questions count');
  assert.deepEqual(all.actions.map(g => [g.label, g.items.map(i => i.id)]), [['Today', ['a', 'c']], ['Yesterday', ['b']]]);
  assert.deepEqual(all.answers, []);
  const found = decisionGroups(log, asks, 'actions', 'fen', NOW);
  assert.deepEqual(found.actions.flatMap(g => g.items.map(i => i.id)), ['c'], 'found in why');
  assert.deepEqual(found.counts, { actions: 3, answers: 1 });
  const answers = decisionGroups(log, asks, 'answers', '', NOW);
  assert.deepEqual(answers.answers.flatMap(g => g.items.map(i => i.id)), ['q1']);
  assert.deepEqual(answers.actions, []);
  assert.equal(cleanSummary('Delegated implementation to Ada: polish...'), 'Delegated implementation to Ada: polish');
  assert.equal(cleanSummary('Ends with an ellipsis…'), 'Ends with an ellipsis');
  assert.deepEqual(['delegate_task', 'send_message', 'nudge_agent', 'update_issue', 'create_agent', 'create_channel', 'other'].map(decisionKind), ['delegate', 'message', 'message', 'issue', 'agent', 'channel', 'other']);
});

test('Issues: open issues by status (needs you, in progress, queued) in backlog order; done newest first; search and filter', () => {
  const g = (id: string, status: SuperIssue['status'], order: number, extra: Partial<SuperIssue> = {}) => ({ id, text: `issue ${id}`, status, order, updatedAt: order, ...extra }) as SuperIssue;
  const issues = [g('q2', 'queued', 3), g('p', 'in_progress', 1), g('q1', 'queued', 2), g('b', 'blocked', 4, { notes: 'needs a key' }), g('d1', 'done', 0, { doneAt: 10 }), g('d2', 'done', 5, { doneAt: 20 })];
  const open = issueGroups(issues, 'open', '');
  assert.deepEqual(open.counts, { open: 4, done: 2 });
  assert.deepEqual(open.open.map(s => [s.label, s.items.map(i => i.id)]), [['Needs you', ['b']], ['In progress', ['p']], ['Queued', ['q1', 'q2']]]);
  assert.deepEqual(open.done.map(i => i.id), ['d2', 'd1'], 'done issues stay listed (folded) under open');
  const done = issueGroups(issues, 'done', '');
  assert.deepEqual(done.open, [], 'the Done filter shows only done issues');
  assert.deepEqual(done.done.map(i => i.id), ['d2', 'd1']);
  const key = issueGroups(issues, 'open', 'KEY');
  assert.deepEqual(key.open.flatMap(s => s.items.map(i => i.id)), ['b'], 'searched in notes too');
  assert.deepEqual(key.counts, { open: 4, done: 2 });
  assert.deepEqual(issueGroups(undefined, 'open', '').open, []);
});

test('Routines: proposals wait first, then yours; empty groups are left out; schedules read short', () => {
  const r = (id: string, extra: Partial<SuperRoutine>) => ({ id, name: id, instruction: `do ${id}`, enabled: true, schedule: { kind: 'daily', at: '09:00' }, ...extra }) as SuperRoutine;
  const groups = routineGroups([r('ci', {}), r('nightly', { proposed: true, enabled: false, why: 'branches pile up' }), r('weekly', { enabled: false })], '');
  assert.deepEqual(groups.map(g => [g.label, g.items.map(i => i.id)]), [['Waiting for you', ['nightly']], ['Routines', ['ci', 'weekly']]]);
  assert.deepEqual(routineGroups([r('ci', {})], 'pile').map(g => g.key), [], 'a search with no match leaves no groups');
  assert.deepEqual(routineGroups([r('nightly', { proposed: true, why: 'branches pile up' })], 'pile').map(g => g.key), ['proposed'], 'why is searched');
  assert.deepEqual(routineGroups([], ''), []);
  assert.equal(shortSchedule({ kind: 'daily', at: '09:00' }), 'Daily 09:00');
  assert.equal(shortSchedule({ kind: 'every', hours: 6 }), 'Every 6 h');
});

test('Notes: decisions, notes, then replaced (folded); the filter narrows them, counts stay whole; the author only when not you', () => {
  const e = (id: string, kind: 'D' | 'N', state: string) => ({ id, kind, state });
  const entries = [e('D3', 'D', 'active'), e('N1', 'N', 'note'), e('D1', 'D', 'replaced'), e('D2', 'D', 'active'), e('N0', 'N', 'replaced')];
  const all = notesSections(entries, 'all');
  assert.deepEqual([all.decisions, all.notes, all.replaced].map(s => s.map(x => x.id)), [['D3', 'D2'], ['N1'], ['D1', 'N0']]);
  assert.deepEqual(all.counts, { all: 5, D: 3, N: 2 });
  const notes = notesSections(entries, 'N');
  assert.deepEqual([notes.decisions, notes.notes, notes.replaced].map(s => s.map(x => x.id)), [[], ['N1'], ['N0']]);
  assert.deepEqual(notes.counts, { all: 5, D: 3, N: 2 });
  assert.equal(authorLabel('You'), null);
  assert.equal(authorLabel(' you '), null);
  assert.equal(authorLabel(''), null);
  assert.equal(authorLabel(undefined), null);
  assert.equal(authorLabel('Fen'), 'Fen');
  assert.equal(authorLabel('Younes'), 'Younes', 'only the word "You" itself is hidden');
});

test('the row menu opens from the keyboard with ⇧F10 or the menu key, not with plain F10', () => {
  assert.equal(isMenuKey({ key: 'F10', shiftKey: true }), true);
  assert.equal(isMenuKey({ key: 'ContextMenu', shiftKey: false }), true);
  assert.equal(isMenuKey({ key: 'F10', shiftKey: false }), false);
  assert.equal(isMenuKey({ key: 'Enter', shiftKey: true }), false);
});

test('Up and Down move within the section (Rhea\'s probe: A, B, C queued, then C in progress); off at section ends', async () => {
  const { SuperStore } = await import('../server/superAgent.ts');
  const { tempDir } = await import('./helpers.ts');
  const store = new SuperStore(tempDir('moves'));
  const a = store.addIssue({ text: 'A', projectId: null, by: 'user' });
  const b = store.addIssue({ text: 'B', projectId: null, by: 'user' });
  const c = store.addIssue({ text: 'C', projectId: null, by: 'user' });
  store.updateIssue(c.id, { status: 'in_progress' });
  const view = () => {
    const issues = store.issues();
    const { open } = issueGroups(issues, 'open', '');
    const backlog = issues.filter(i => i.status !== 'done').sort((x, y) => x.order - y.order);
    return { open, moves: issueMoves(open, backlog), shown: open.map(s => `${s.label}: ${s.items.map(i => i.text).join(', ')}`).join(' | ') };
  };
  let v = view();
  assert.equal(v.shown, 'In progress: C | Queued: A, B');
  assert.deepEqual(v.moves.get(c.id), { up: null, down: null }, 'C is alone in its section: both off');
  assert.equal(v.moves.get(b.id)!.down, null, 'B is last in Queued: Down off');
  assert.equal(v.moves.get(a.id)!.up, null, 'A is first in Queued: Up off');
  // Every enabled move changes what the section shows.
  store.moveIssue(b.id, v.moves.get(b.id)!.up!);
  v = view();
  assert.equal(v.shown, 'In progress: C | Queued: B, A');
  store.moveIssue(b.id, v.moves.get(b.id)!.down!);
  assert.equal(view().shown, 'In progress: C | Queued: A, B');
  // With another status between them in the backlog, the move still lands next to the neighbour.
  store.moveIssue(c.id, 1);
  v = view();
  store.moveIssue(a.id, v.moves.get(a.id)!.down!);
  assert.equal(view().shown, 'In progress: C | Queued: B, A');
});

test('after a row is removed, focus goes to the next row, else the one before, else nowhere', () => {
  assert.equal(focusAfterRemoval(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(focusAfterRemoval(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(focusAfterRemoval(['a'], 'a'), null);
  assert.equal(focusAfterRemoval(['a'], 'zz'), null);
});

test('a row shows its actions for keyboard focus only: :focus-visible, not a mouse click', () => {
  const el = (visible: boolean) => ({ matches: (s: string) => s === ':focus-visible' && visible });
  assert.equal(isKeyboardFocus(el(true)), true, 'Tab or the arrow keys');
  assert.equal(isKeyboardFocus(el(false)), false, 'a click: hover already shows it, and a row the click closed looks closed');
  assert.equal(isKeyboardFocus(null), false);
  assert.equal(isKeyboardFocus({ matches: () => { throw new SyntaxError('unknown pseudo-class'); } }), true, 'an engine without :focus-visible keeps the keyboard working');
});
