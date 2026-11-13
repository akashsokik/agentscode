// What the SuperAgent may never ask an agent to do, at any Autonomy level (ALL-D9): rewrite or
// force-push shared history. Checked on every task text it sends (take_action, delegate_task,
// send_message, create_agent). Kept narrow, so everyday work that mentions merge, push or branch -D
// still goes; those are noted in Decisions instead (gatedVerbs).

const RULES: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*(\s-f\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s--force(-with-lease|-if-includes)?\b|\s\+[\w./-]+)/i, why: 'a force-push' },
  { pattern: /\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*(\s--delete\b|\s-d\b|\s:[\w./-]+|\s:refs\/)/i, why: 'deleting a pushed branch or tag' },
  { pattern: /\bgit\b[^\n;|&]*\b(filter-branch|filter-repo)\b/i, why: 'rewriting history (filter-branch / filter-repo)' },
  { pattern: /\bgit\b[^\n;|&]*\btag\b[^\n;|&]*\s(-d|--delete)\b[\s\S]*\bpush\b/i, why: 'deleting and re-pushing a tag' },
  { pattern: /\breset\s+--hard\b[\s\S]*\bgit\b[^\n;|&]*\bpush\b/i, why: 'a hard reset that is then pushed' },
  { pattern: /\brebase\b[^\n;|&]*\b(origin\/)?(main|master)\b[\s\S]*\bpush\b[^\n;|&]*\b(main|master)\b/i, why: 'rebasing and pushing main' },
];

/** Why this text asks for a shared-history rewrite, or null when it does not. */
export function forbiddenGit(text: string): string | null {
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.why;
  return null;
}

const GATED: { verb: string; pattern: RegExp }[] = [
  { verb: 'merge', pattern: /\bgit\s+merge\b|\bmerge\b[^.\n]*\binto\s+(local\s+)?main\b/i },
  { verb: 'push', pattern: /\bgit\s+push\b|\bpush\b[^.\n]*\b(main|origin)\b/i },
  { verb: 'delete', pattern: /\bbranch\s+-D\b|\bworktree\s+remove\b|\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\b|\bdelete\b[^.\n]*\b(branch|worktree|folder|project|data)\b/i },
  { verb: 'release', pattern: /\bgit\s+tag\b|\bgh\s+release\b|\brelease\s+v?\d/i },
  { verb: 'deploy', pattern: /\bdeploy\b/i },
];

/** The gated steps a free-form task mentions (merge, push, delete, release, deploy), for Decisions. */
export function gatedVerbs(text: string): string[] {
  return GATED.filter(g => g.pattern.test(text)).map(g => g.verb);
}
