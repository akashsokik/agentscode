import assert from 'node:assert/strict';
import test from 'node:test';
import { shownIssueId } from '../web/issues/openIssue.ts';
import type { Layout } from '../web/layout.ts';

// Which issue is in front, for the right panel's list to mark its row (Phase 6, ACH-23).

const layout = (contents: Layout['tabs'][number]['content'][], focusedTab: number): Layout => {
  const tabs = contents.map((content, i) => ({ id: `t${i}`, content }));
  return { tabs, panes: [{ id: 'p0', tabId: `t${focusedTab}` }, { id: 'p1', tabId: 't0' }], focused: 'p0' } as unknown as Layout;
};

test('the issue in front: selected on the Issues page, or open in its own tab, in the focused pane only', () => {
  assert.equal(shownIssueId(layout([{ kind: 'comms' }, { kind: 'issues', issueId: 'i1' }], 1)), 'i1');
  assert.equal(shownIssueId(layout([{ kind: 'comms' }, { kind: 'issue', issueId: 'i2' }], 1)), 'i2');
  assert.equal(shownIssueId(layout([{ kind: 'comms' }, { kind: 'issues' }], 1)), null, 'the page with nothing selected');
  assert.equal(shownIssueId(layout([{ kind: 'issues', issueId: 'i1' }, { kind: 'comms' }], 1)), null, 'an Issues tab in another pane is not in front');
});
