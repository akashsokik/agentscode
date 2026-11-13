import type { CSSProperties } from 'react';
import { ISSUE_STATUS_LABEL } from '../../shared/issues.ts';
import { showIssueInList } from '../issues/openIssue.ts';
import { StatusIcon } from '../issues/issueParts.tsx';
import { getState, useApp } from '../store.ts';

/**
 * An issue key in text (ACH-23 in a transcript, a message, a PR description) as a chip: the
 * reference chip's look (.ref-chip, as notes and decisions), in the content colour, with the
 * issue's status mark. A click shows the issue on the Issues page, selected (showIssueInList,
 * ACH-D52); the right panel keeps its tabs (ACH-D55). Only keys of issues that exist become chips,
 * so "UTF-8", "SHA-256", ACH-0 or a removed issue's key stay text.
 */

/** Whether a key names an issue PodCode has now (for the Markdown chip pass). */
export function isKnownIssueKey(key: string): boolean {
  return Boolean(getState().snapshot?.super.issues.some(i => i.key === key));
}

/** The issue keys there are, as one string: Markdown parses again when it changes. */
export function useIssueKeysKey(): string {
  return useApp(s => (s.snapshot?.super.issues ?? []).map(i => i.key).join(' '));
}

const NEUTRAL = { '--ref-hue': 'var(--color-content)' } as CSSProperties;

export function IssueKeyChip({ issueKey, fade }: { issueKey: string; fade?: boolean }) {
  const issue = useApp(s => s.snapshot?.super.issues.find(i => i.key === issueKey));
  if (!issue) return <>{issueKey}</>;
  const words = `Issue ${issue.key}, ${ISSUE_STATUS_LABEL[issue.status]}: ${issue.title}`;
  return (
    <button
      type="button"
      className="ref-chip"
      style={NEUTRAL}
      {...(fade ? { 'data-word-fade': '' } : {})}
      aria-label={`${words}. Show it on the Issues page.`}
      title={words}
      onClick={event => { event.stopPropagation(); showIssueInList(issue.id); }}
    >
      <StatusIcon status={issue.status} className="size-3" />
      {issue.key}
    </button>
  );
}
