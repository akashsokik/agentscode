// Which issue fields the user's issue route takes today (pure, so tests read it without the store).
// issueWrites.ts re-exports it with the write itself.
export type IssueField = 'title' | 'text' | 'status' | 'priority' | 'dueDate' | 'labels' | 'projectId' | 'assignee' | 'parent' | 'relations' | 'comment';

/** What the user's issue route takes today. */
export const WRITABLE: Readonly<Record<IssueField, boolean>> = {
  title: true, text: true, status: true, priority: true, dueDate: true, labels: true, projectId: true,
  // Fen's feat/issues-api (68f9969): the assignee (an agent, you or nobody), the parent, the
  // relations and comments too.
  assignee: true, parent: true, relations: true, comment: true,
};
