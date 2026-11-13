// Which issue fields the user's issue route takes today (pure, so tests read it without the store).
// issueWrites.ts re-exports it with the write itself.
export type IssueField = 'title' | 'text' | 'status' | 'priority' | 'dueDate' | 'labels' | 'projectId' | 'assignee' | 'parent' | 'relations' | 'comment';

/** What the user's issue route takes today. */
export const WRITABLE: Readonly<Record<IssueField, boolean>> = {
  title: true, text: true, status: true, priority: true, dueDate: true, labels: true, projectId: true,
  assignee: false, parent: false, relations: false, comment: false,
};
