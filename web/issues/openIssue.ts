import { open, type TabContent } from '../layout.ts';

// Opening an issue (ACH-D43 section C): the full issue view in a tab, with its properties sidebar
// (web/issues/IssueView.tsx). Both issue lists, the Issues page and the right panel's tab, open
// issues this way; a row never unfolds to show details. An issue already open in a tab is focused
// there, not opened twice (tabs are keyed issue:<id>).

export function issueTab(issueId: string): TabContent {
  return { kind: 'issue', issueId };
}

export function openIssue(issueId: string): void {
  open(issueTab(issueId));
}
