// Goals became Issues (ACH-D38). The old command names still run (server/comms/tools.ts maps them),
// and transcripts that used them read with the new names (web/toolPresentation.ts).
export const ISSUE_TOOL_ALIASES = { list_goals: 'list_issues', add_goal: 'add_issue', update_goal: 'update_issue', complete_goal: 'complete_issue' } as const;
export type LegacyIssueTool = keyof typeof ISSUE_TOOL_ALIASES;

/** A command's current name: an old goal command as its issue command, anything else as it is. */
export function currentToolName(name: string): string {
  return (ISSUE_TOOL_ALIASES as Record<string, string>)[name] ?? name;
}
