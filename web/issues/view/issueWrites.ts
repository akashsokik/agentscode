// Every change the issue view makes goes through the issue API (api.updateIssue, the user's
// PATCH /api/super/issues/:id). A field that route does not take is listed as not writable, and
// its control stays read-only rather than doing nothing silently.
import type { IssuePriority, IssueRelationType, IssueStatus } from '../../../shared/types.ts';
import { api } from '../../api.ts';
import { attempt } from '../../store.ts';

export { WRITABLE, type IssueField } from './issueWritable.ts';

export interface IssuePatch {
  title?: string;
  text?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  dueDate?: string | null;
  labels?: string[];
  projectId?: string | null;
  /** An agent's id, 'user' for you, or null for nobody. */
  assignee?: string | null;
  parentId?: string | null;
  /** The issue's own relations, whole: the list replaces the old one. */
  relations?: { type: IssueRelationType; issueId: string }[];
  /** A comment added to its activity (Markdown). */
  comment?: string;
}

/** Save a change; true when it went through (an error shows as a toast through `attempt`). */
export async function writeIssue(id: string, patch: IssuePatch): Promise<boolean> {
  return Boolean(await attempt(() => api.updateIssue(id, patch)));
}
