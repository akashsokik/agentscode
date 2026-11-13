// How much the SuperAgent does without asking (ALL-D9): one level, Ask / Standard / Full, and four
// ask-first switches for what cannot be undone. Pure: the server enforces it (take_action), the
// SuperAgent's instructions are built from it, and Settings shows it.

export type SuperAutonomy = 'ask' | 'standard' | 'full';
export const SUPER_AUTONOMY: readonly SuperAutonomy[] = ['ask', 'standard', 'full'];

/** What still needs the user's yes even on Full: each true means "ask me first". */
export interface AskFirst {
  /** Deleting files or data: unmerged branches, folders with uncommitted work, an agent's files, a backup. */
  deleteData: boolean;
  /** Outside accounts: Railway, Vercel, GitHub settings, anything with billing or other people. */
  outsideAccounts: boolean;
  /** Removing agents the user made (its own new agents it may remove). */
  removeUserAgents: boolean;
  /** Force-pushing a branch that was never pushed. Shared history is never force-pushed at any level. */
  forcePush: boolean;
}
export const ASK_FIRST_KEYS: readonly (keyof AskFirst)[] = ['deleteData', 'outsideAccounts', 'removeUserAgents', 'forcePush'];
export const ALL_ASK_FIRST: AskFirst = { deleteData: true, outsideAccounts: true, removeUserAgents: true, forcePush: true };

/** The things take_action does (through an agent, or the app for removals). */
export type ActionKind =
  | 'merge' | 'restart' | 'push' | 'release' | 'deploy' | 'cleanup' | 'project' | 'costly'
  | 'delete_data' | 'outside_account' | 'remove_user_agent' | 'force_push'
  | 'rewrite_history';
export const ACTION_KINDS: readonly ActionKind[] = ['merge', 'restart', 'push', 'release', 'deploy', 'cleanup', 'project', 'costly', 'delete_data', 'outside_account', 'remove_user_agent', 'force_push', 'rewrite_history'];

/** The undoable actions, what Full does without asking, with how each is undone. */
export const FULL_ACTIONS: { kind: ActionKind; label: string; undo: string }[] = [
  { kind: 'merge', label: 'Merge approved branches into main', undo: 'Not pushed: reset main to the backup ref. Pushed: a revert commit.' },
  { kind: 'restart', label: 'Rebuild and restart PodCode', undo: 'Restart onto the previous build (kept as the backup app).' },
  { kind: 'push', label: 'Push main (fast-forward only)', undo: 'A revert commit, pushed. History is never rewritten.' },
  { kind: 'release', label: 'Tag and publish a release', undo: 'Delete the tag and unpublish the release (back to a draft).' },
  { kind: 'deploy', label: 'Deploy', undo: 'Redeploy the previous version.' },
  { kind: 'cleanup', label: 'Clean up merged branches and worktrees', undo: 'Restore the branch (and a clean worktree) from its backup ref, kept 7 days.' },
  { kind: 'project', label: 'Add a project you named', undo: 'Remove it from PodCode (no files touched).' },
  { kind: 'costly', label: 'Start large or costly work (within your budget)', undo: 'Stop the agents it started.' },
];

/** Standard is ALL-D1 as written: merge locally after review, rebuild and restart, delete merged branches. */
const STANDARD_ACTS: readonly ActionKind[] = ['merge', 'restart', 'cleanup'];
const ASK_FIRST_KIND: Partial<Record<ActionKind, keyof AskFirst>> = { delete_data: 'deleteData', outside_account: 'outsideAccounts', remove_user_agent: 'removeUserAgents', force_push: 'forcePush' };

export type Verdict = 'act' | 'ask' | 'never';

/**
 * Whether the SuperAgent may do this now: act (no asking), ask (only with the user's yes to an
 * ask_user question), or never (refused at every level: rewriting or force-pushing shared history).
 * Ask-first kinds follow their switch at every level; Ask asks for everything else too.
 */
export function actionVerdict(kind: ActionKind, level: SuperAutonomy, askFirst: AskFirst): Verdict {
  if (kind === 'rewrite_history') return 'never';
  const gated = ASK_FIRST_KIND[kind];
  if (gated) return askFirst[gated] || level === 'ask' ? 'ask' : 'act';
  if (level === 'full') return 'act';
  if (level === 'standard') return STANDARD_ACTS.includes(kind) ? 'act' : 'ask';
  return 'ask';
}

/** Kinds that must name where the backup is before anything is removed or rewritten. */
export const NEEDS_BACKUP: readonly ActionKind[] = ['cleanup', 'delete_data'];

/** The settings as stored, made whole: unknown levels fall back to Full, missing switches to "ask". */
export function cleanAutonomy(raw: { superAutonomy?: unknown; superAskFirst?: unknown }): { superAutonomy: SuperAutonomy; superAskFirst: AskFirst } {
  const level = SUPER_AUTONOMY.includes(raw.superAutonomy as SuperAutonomy) ? raw.superAutonomy as SuperAutonomy : 'full';
  const given = raw.superAskFirst && typeof raw.superAskFirst === 'object' ? raw.superAskFirst as Record<string, unknown> : {};
  const askFirst = Object.fromEntries(ASK_FIRST_KEYS.map(k => [k, typeof given[k] === 'boolean' ? given[k] : true])) as unknown as AskFirst;
  return { superAutonomy: level, superAskFirst: askFirst };
}

const ASK_FIRST_TEXT: Record<keyof AskFirst, string> = {
  deleteData: 'deleting files or data (unmerged branches, folders with uncommitted work, an agent\'s files, a backup)',
  outsideAccounts: 'changing outside accounts (Railway, Vercel, GitHub settings, anything with billing or other people)',
  removeUserAgents: 'removing agents the user made',
  forcePush: 'force-pushing a branch that was never pushed',
};

/**
 * The SuperAgent's instructions for its level. It replaces the old "Always ask the user first" rule
 * in its role text, so a session started before reads the change as it happens.
 */
export function autonomyInstructions(level: SuperAutonomy, askFirst: AskFirst, paused: boolean): string {
  const asks = ASK_FIRST_KEYS.filter(k => askFirst[k]).map(k => ASK_FIRST_TEXT[k]);
  const acts = level === 'full' ? FULL_ACTIONS.map(a => a.label.toLowerCase())
    : level === 'standard' ? ['merge approved branches into local main', 'rebuild and restart PodCode', 'clean up merged branches'] : [];
  return [
    `Autonomy (Settings, SuperAgent): ${level === 'full' ? 'Full' : level === 'standard' ? 'Standard' : 'Ask'}. This replaces the "Always ask the user first" rule in your role instructions.`,
    paused ? 'The user PAUSED you: start nothing on your own (no take_action, no new agents, no handing out issues) until they resume. Their own messages and the work they asked for still go.' : '',
    acts.length ? `Do these yourself, without ask_user, through take_action (it hands the step to an agent, checks the rules and logs it in Decisions with how to undo it): ${acts.join('; ')}.` : 'Ask the user with ask_user before every merge, restart, push, release, deploy, cleanup, new project or costly work; then do it with take_action and the answered question id.',
    level !== 'full' && acts.length ? 'Ask with ask_user before anything else of that kind (push, release, deploy, new projects, costly work); then use take_action with the answered question id.' : '',
    asks.length ? `Always ask first, before: ${asks.join('; ')}. Use ask_user with for_action {kind, target, task}; PodCode adds Yes and No and shows the task; the user\'s Yes is good for that one step and task text, once, within a day; then take_action with approved_ask_id and the same task.` : '',
    'At every level, never: rewrite or force-push shared history (main, tags, any pushed branch). Every agent\'s git runs PodCode\'s push check, which refuses a push that overwrites or deletes what the remote has; only a force_push the user approved gets a one-time pass (take_action gives the agent the token). Tasks you send that ask for it are refused early too. Before cleanup or deletion, make a backup (a backup/… ref that holds the commit, or a copy in a backups folder) and name it; take_action checks it. A merge names its project, branch and the exact commit a reviewer the user made passed, in answer to a review request for that branch and commit; take_action checks the branch is still at that commit. Never restart an agent the user stopped; stay within the daily budget, which counts the work you start on your own. Push fast-forward only.',
    'Log nothing yourself: take_action records each step in Decisions, with why and how to undo it, and the user can undo it or pause you there.',
  ].filter(Boolean).join('\n');
}

/**
 * soul.md is the user's own (only they edit it). The line they would change for Full, shown in
 * Settings with a copy button: the role preset's first line, as the SuperAgent's soul.md has it.
 */
export const SOUL_LINE_FROM = 'act on your own where you may, and ask the user about the rest.';
export const SOUL_LINE_TO = 'act on your own on everything the Autonomy setting allows; ask the user only about what it lists as ask-first.';
/** The same soul text with the suggestion made; unchanged when the line is not there (already edited). */
export function suggestedSoul(soul: string): string {
  return soul.includes(SOUL_LINE_FROM) ? soul.replace(SOUL_LINE_FROM, SOUL_LINE_TO) : soul;
}

/** What holds at every level, worded as the server enforces it (ALL-D9). */
export const ALWAYS_SAFE: readonly string[] = [
  'Agents\' ordinary force-pushes and deletes of pushed history are refused on this Mac (one you approved goes, once). The hard lock is GitHub\'s branch protection on main, where your plan has it',
  'Cleanup and deletion name a backup that exists',
  'Merges only the commit a reviewer you made passed',
  'Your Stop on an agent is final',
  'Its own work, and the agents it starts, stay within your daily budget',
  'Paused, it starts nothing on its own: here or in Decisions',
];

/** The agents-a-day row in Settings: not used on Full (ALL-D10); the daily spending cap still is. */
export function createCapText(level: SuperAutonomy): string {
  return level === 'full'
    ? 'Not used on Full: it creates the agents the work needs (your call, ALL-D10). The daily budget still holds.'
    : 'Past this, it asks you before creating more. Not used on Full.';
}
