import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { whileBusy } from '../web/panelList.ts';
import { byYou, superTabCounts, superTabLatest } from '../web/superText.ts';
import { harness } from './helpers.ts';

// The Issues tab after Rhea's end-to-end test (B1 to B4): focus never falls to the page while a
// request runs, and removing an issue yourself can be undone from Decisions.

test('a busy button keeps focus: no disabled attribute, says it is busy, ignores presses until done', () => {
  let presses = 0;
  const busy = whileBusy(true, () => { presses++; });
  assert.equal('disabled' in busy, false, 'never disabled: Chromium blurs a disabled control');
  assert.equal(busy['aria-disabled'], true);
  assert.equal(busy['aria-busy'], true);
  busy.onClick();
  assert.equal(presses, 0, 'a second press while busy does nothing');
  const idle = whileBusy(false, () => { presses++; });
  assert.equal(idle['aria-disabled'], undefined);
  idle.onClick();
  assert.equal(presses, 1);
});

test('no control in the SuperAgent tabs is disabled just for being busy, and moved or changed rows get focus back', () => {
  const src = fs.readFileSync(new URL('../web/panes/SuperPanel.tsx', import.meta.url), 'utf8');
  for (const comp of ['RowAction', 'RowIcon', 'DetailButton']) {
    assert.doesNotMatch(src, new RegExp(`<${comp}\\b[^>]*disabled=\\{busy`), `${comp} uses busy=, not disabled={busy}`);
  }
  const composer = src.slice(src.indexOf('function Composer('), src.indexOf('export function IssuesView'));
  assert.doesNotMatch(composer, /disabled=\{busy\}/, 'B1: the composer input stays enabled while adding');
  assert.match(composer, /readOnly=\{busy\}/);
  assert.doesNotMatch(src, /<select[^>]*\n?[^>]*disabled=\{busy\}/, 'the status select stays enabled');
  assert.match(src, /api\.moveIssue\(issue\.id, to\)\)\.then\(onSettled\)/, 'B2: a move puts focus back on the row');
  // B3: status (and priority) change through the row menu's submenus, which put focus back on the row.
  assert.match(src, /<StatusPriorityRows issue=\{issue\} close=\{close\} onChanged=\{onSettled\} \/>/, 'B3: a status change puts focus back on the row');
  const parts = fs.readFileSync(new URL('../web/issues/issueParts.tsx', import.meta.url), 'utf8');
  assert.match(parts, /api\.updateIssue\(issue\.id, patch\)\)\.then\(\(\) => onChanged\?\.\(\)\)/);
  assert.match(src, /onSettled=\{\(\) => focusRow\(root\.current, issue\.id\)\}/);
});

test('B4: removing an issue yourself is logged with Undo, which puts it back as it was, once', async () => {
  const h = harness();
  h.manager.addIssue({ text: 'Ship dark mode', projectId: null });
  const issue = h.manager.superView().issues[0];
  h.manager.updateIssue(issue.id, { status: 'in_progress' });
  const before = h.manager.superView().issues[0];
  const state = h.manager.removeIssue(issue.id);
  assert.deepEqual(state.issues, []);
  const entry = state.log[0];
  assert.equal(entry.tool, 'remove_issue');
  assert.equal(entry.summary, 'You removed the issue "Ship dark mode"');
  assert.deepEqual(entry.undo, { kind: 'issue', issueId: issue.id, before, removed: true });
  const undone = await h.manager.undoSuper(entry.id);
  assert.deepEqual(undone.issues.map(i => [i.id, i.text, i.status]), [[issue.id, 'Ship dark mode', 'in_progress']], 'back with its status');
  assert.ok(undone.log[0].undoneAt, 'marked undone');
  await assert.rejects(h.manager.undoSuper(entry.id), 'undone once only');
  // Your own removal is not "new" on the Decisions tab: no count, no dot.
  const log = [{ ...entry, undoneAt: undefined }];
  assert.equal(byYou(entry), true);
  assert.equal(superTabCounts({ log, issues: [], routines: [] }, Date.now()).decisions, 0);
  assert.equal(superTabLatest({ log, issues: [], routines: [] }).decisions, 0);
});

test('B4: undoing a removal is refused when a same-text issue is open again', async () => {
  const h = harness();
  h.manager.addIssue({ text: 'Fix the flaky test', projectId: null });
  const id = h.manager.superView().issues[0].id;
  const entry = h.manager.removeIssue(id).log[0];
  h.manager.addIssue({ text: 'Fix the flaky test', projectId: null });
  await assert.rejects(h.manager.undoSuper(entry.id), /same thing/);
  assert.equal(h.manager.superView().issues.length, 1, 'nothing doubled');
});
