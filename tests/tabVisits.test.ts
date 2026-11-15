import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { closeTab, getLayout, getTabVisits, goBack, goForward, open, pinTab, setRightPanel, setRightView, setSuperView, type TabContent } from '../web/layout.ts';
import { shortcutFor } from '../web/shortcutMap.ts';
import { canVisitBack, canVisitForward, emptyTabVisits, MAX_VISITS, pruneVisits, recordVisit, visitBack, visitForward } from '../web/tabVisits.ts';

// ACH-31 / ACH-D69: Back and Forward through the tabs you focused, ported from MonoCode's
// tabVisitHistory. The pure model first, then the window's history as web/layout.ts keeps it.

test('the model: a visit clears forward, Back and Forward step, the same tab twice is no visit, 50 at most', () => {
  let h = emptyTabVisits('a');
  assert.equal(canVisitBack(h), false);
  h = recordVisit(h, 'b');
  h = recordVisit(h, 'c');
  assert.deepEqual(h, { back: ['a', 'b'], forward: [], current: 'c' });
  assert.equal(recordVisit(h, 'c'), h, 'the same tab again is no visit');
  h = visitBack(h)!;
  assert.deepEqual(h, { back: ['a'], forward: ['c'], current: 'b' });
  h = visitBack(h)!;
  assert.deepEqual(h, { back: [], forward: ['b', 'c'], current: 'a' });
  assert.equal(visitBack(h), null, 'nothing before the start');
  h = visitForward(h)!;
  assert.deepEqual(h, { back: ['a'], forward: ['c'], current: 'b' });
  h = recordVisit(h, 'd');
  assert.deepEqual(h, { back: ['a', 'b'], forward: [], current: 'd' }, 'a new visit clears forward');
  assert.equal(canVisitForward(h), false);
  let long = emptyTabVisits('t0');
  for (let i = 1; i <= 80; i++) long = recordVisit(long, `t${i}`);
  assert.equal(long.back.length, MAX_VISITS);
  assert.equal(long.back[0], 't30', 'the oldest steps go first');
});

test('the model: closed tabs are pruned, current moves onto the tab in focus, repeats collapse', () => {
  const h = { back: ['a', 'b', 'a'], forward: ['c', 'b'], current: 'b' };
  assert.deepEqual(pruneVisits(h, new Set(['a', 'c']), 'a'), { back: [], forward: ['c'], current: 'a' });
  const same = { back: ['a'], forward: [], current: 'b' };
  assert.equal(pruneVisits(same, new Set(['a', 'b']), 'b'), same, 'unchanged when nothing closed');
});

const agent = (agentId: string): TabContent => ({ kind: 'agent', agentId });
const tabId = (content: TabContent) => getLayout().tabs.find(t => JSON.stringify(t.content) === JSON.stringify(content))?.id;
const focusedId = () => getLayout().panes.find(p => p.id === getLayout().focused)?.tabId ?? null;
const name = (id: string | null | undefined) => {
  const c = getLayout().tabs.find(t => t.id === id)?.content;
  return c ? (c.kind === 'agent' ? c.agentId : c.kind) : null;
};
const history = () => ({ back: getTabVisits().back.map(name), current: name(getTabVisits().current), forward: getTabVisits().forward.map(name) });

function fresh() {
  for (const tab of [...getLayout().tabs]) { pinTab(tab.id, false); closeTab(tab.id); }
  // Start from a history that holds only open tabs (closing them all leaves it empty).
  open(agent('ada'));
}

test('in the app: every focused tab is a visit, pinned ones and the Issues and PR pages too; Back and Forward are not', () => {
  fresh();
  open(agent('fen'));
  pinTab(tabId(agent('fen'))!, true);
  open({ kind: 'issues' });
  open({ kind: 'pullRequests' });
  open({ kind: 'issue', issueId: 'i1' });
  assert.deepEqual(history(), { back: ['ada', 'fen', 'issues', 'pullRequests'], current: 'issue', forward: [] });

  goBack();
  assert.equal(name(focusedId()), 'pullRequests', 'Back shows the tab before');
  assert.deepEqual(history(), { back: ['ada', 'fen', 'issues'], current: 'pullRequests', forward: ['issue'] }, 'the move itself is not a new visit');
  goBack();
  goBack();
  assert.equal(name(focusedId()), 'fen', 'a pinned tab is a step like any other');
  goForward();
  assert.equal(name(focusedId()), 'issues');
  assert.deepEqual(history(), { back: ['ada', 'fen'], current: 'issues', forward: ['pullRequests', 'issue'] });

  open(agent('cy'));
  assert.deepEqual(history(), { back: ['ada', 'fen', 'issues'], current: 'cy', forward: [] }, 'a new visit clears forward');
});

test('in the app: a closed tab leaves the history; the right panel never enters it', () => {
  fresh();
  open(agent('fen'));
  open(agent('cy'));
  goBack();
  assert.deepEqual(history(), { back: ['ada'], current: 'fen', forward: ['cy'] });
  closeTab(tabId(agent('ada'))!);
  assert.deepEqual(history(), { back: [], current: 'fen', forward: ['cy'] }, 'Ada was the only step back');

  setRightPanel(true);
  setRightView('changes');
  setSuperView('issues');
  setRightView('overview');
  assert.deepEqual(history(), { back: [], current: 'fen', forward: ['cy'] }, 'right-panel views are not visits');

  closeTab(tabId(agent('fen'))!);
  const h = history();
  assert.ok(!h.back.includes('fen') && !h.forward.includes('fen') && h.current !== 'fen', 'the focused tab closing leaves no trace');
});

test('Cmd+[ and Cmd+] are Back and Forward; with Shift they still cycle tabs; the buttons use HeaderButton', () => {
  const press = (code: string, shiftKey = false) => shortcutFor({ code, metaKey: true, ctrlKey: false, altKey: false, shiftKey }, true);
  assert.deepEqual(press('BracketLeft'), { kind: 'back' });
  assert.deepEqual(press('BracketRight'), { kind: 'forward' });
  assert.deepEqual(press('BracketLeft', true), { kind: 'cycle', step: -1 });
  assert.deepEqual(press('BracketRight', true), { kind: 'cycle', step: 1 });
  assert.deepEqual(shortcutFor({ code: 'BracketLeft', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, false), { kind: 'back' }, 'Ctrl+[ off macOS');
  const app = fs.readFileSync(new URL('../web/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<HeaderButton icon=\{ChevronLeft\} label=\{`Back \(\$\{SHORTCUTS\.back\}\)`\} disabled=\{!nav\.canBack\} onClick=\{goBack\} \/>/);
  assert.match(app, /<HeaderButton icon=\{ChevronRight\} label=\{`Forward \(\$\{SHORTCUTS\.forward\}\)`\} disabled=\{!nav\.canForward\} onClick=\{goForward\} \/>/);
});
