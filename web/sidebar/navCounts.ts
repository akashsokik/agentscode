import type { SuperIssue } from '../../shared/types.ts';

// The counts beside the navigation's Issues and Pull requests rows (ACH-D42).

/** Issues not done or canceled. Canceled arrives with Fen's issue model (ACH-D43 phase 1), so the status is compared as text. */
export function openIssueCount(issues: readonly SuperIssue[] | undefined): number {
  return (issues ?? []).filter(i => (i.status as string) !== 'done' && (i.status as string) !== 'canceled').length;
}
