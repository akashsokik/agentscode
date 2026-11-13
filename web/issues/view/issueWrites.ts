// Every change the issue view makes goes through the existing issue API (api.updateIssue, the
// user's PATCH /api/super/issues/:id). A field that route does not take yet is listed as not
// writable, and its control stays read-only rather than doing nothing silently. The assignee,
// parent, relations and comments become writable when the route takes them (Fen's issue API).
import type { IssuePriority, IssueStatus } from '../../../shared/types.ts';
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
}

/** Save a change; true when it went through (an error shows as a toast through `attempt`). */
export async function writeIssue(id: string, patch: IssuePatch): Promise<boolean> {
  return Boolean(await attempt(() => api.updateIssue(id, patch)));
}
