// An early warning for what the SuperAgent may never ask an agent to do (ALL-D9): rewrite or
// force-push shared history. The real gate is server/pushGuard.ts, the pre-push check every
// agent's git runs; this catches the request earlier, in the text of any task or message the
// SuperAgent sends. Kept narrow, so everyday work that mentions merge, push or branch -D still
// goes (those are noted in Decisions: gatedVerbs), and a sentence that forbids it ("do not run
// git push --force") is not taken as asking for it.

/** The text as a shell would see it: continuations joined, quotes and escapes dropped. */
function normalise(text: string): string {
  return text.replace(/\\\r?\n/g, ' ').replace(/["'`\\]/g, '').replace(/[ \t]+/g, ' ');
}

/** Sentences and clauses that forbid something ("do not …", "never …", "don't …") are left out. */
function withoutNegations(text: string): string {
  return text.split(/(?<=[.!?;\n])\s*|\s+(?=but\b)/i).filter(part => !/\b(do not|don'?t|dont|never|must not|mustn'?t|no need to|avoid|without)\b/i.test(part)).join('\n');
}

const RULES: { pattern: RegExp; why: string }[] = [
  { pattern: /\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*(\s-[a-zA-Z]*f[a-zA-Z]*\b|\s--force(-with-lease|-if-includes)?\b|\s\+[\w./-]+|\s--mirror\b|\s--prune\b)/i, why: 'a force-push' },
  { pattern: /\bgit\b[^\n;|&]*\bpush\b[^\n;|&]*(\s--delete\b|\s-d\b|\s:[\w./-]+|\s:refs\/)/i, why: 'deleting a pushed branch or tag' },
  { pattern: /\bgit\b[^\n;|&]*\b(filter-branch|filter-repo)\b/i, why: 'rewriting history (filter-branch / filter-repo)' },
  { pattern: /\bforce[- ]?push(ing|ed)?\b/i, why: 'a force-push' },
  { pattern: /\bforce\b[^.\n]{0,40}\b(push|main|master|origin|tag)\b/i, why: 'a force-push' },
  { pattern: /\boverwrite\b[^.\n]{0,40}\b(origin\/|remote|main\b|master\b|tag)/i, why: 'overwriting pushed history' },
  { pattern: /\breset\s+--hard\b[^\n]*\bpush\b[^\n;|&]*\b(main|master)\b/i, why: 'a hard reset of main that is then pushed' },
  { pattern: /\brebase\b[^\n;|&]*\b(origin\/)?(main|master)\b[\s\S]*\bpush\b[^\n;|&]*\b(main|master)\b/i, why: 'rebasing and pushing main' },
  { pattern: /refs\/heads\/(main|master)\b[^\n]*\b(force|PATCH)\b|\b(force|PATCH)\b[^\n]*refs\/heads\/(main|master)\b/i, why: 'moving main through the API' },
];

/** Why this text asks for a shared-history rewrite, or null when it does not. */
export function forbiddenGit(text: string): string | null {
  const asked = withoutNegations(normalise(text));
  for (const rule of RULES) if (rule.pattern.test(asked)) return rule.why;
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
