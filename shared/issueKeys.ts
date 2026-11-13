// Issue keys (ACH-D41): a project's code and a number, ACH-25, given once per project in the order
// issues are made and never reused. Agents name branches after them (feat/ACH-25-short-title) and
// cite them in commits, PRs and reports, which is how those link back to the issue. Pure.

/**
 * A key in running text. The number comes straight after the dash, so note and decision ids
 * (ACH-N3, ACH-D41, ALL-D9) never match. Global: use with matchAll, or issueKeysIn.
 */
export const ISSUE_KEY = /(?<![A-Za-z0-9])([A-Z]{2,5})-(\d{1,6})(?![A-Za-z0-9])/g;

/** The code used for issues with no project, as notes and decisions use ALL for every project. */
export const NO_PROJECT_CODE = 'ALL';

/** Every key in a text (a branch name, a commit, a PR title or body, a report), once each, in order. */
export function issueKeysIn(text: string): string[] {
  const keys: string[] = [];
  for (const m of String(text ?? '').matchAll(ISSUE_KEY)) {
    const key = `${m[1]}-${Number(m[2])}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The next key for a project code, past every number it has ever given (counters) and any key in use. */
export function nextIssueKey(code: string, counters: Record<string, number>, keysInUse: Iterable<string> = []): { key: string; counters: Record<string, number> } {
  let top = counters[code] ?? 0;
  for (const k of keysInUse) {
    const m = /^([A-Z]{2,5})-(\d+)$/.exec(k);
    if (m && m[1] === code) top = Math.max(top, Number(m[2]));
  }
  return { key: `${code}-${top + 1}`, counters: { ...counters, [code]: top + 1 } };
}

/** A branch name for an issue: feat/ACH-25-short-title-in-words (lowercase, at most 6 words). */
export function issueBranchName(key: string, title: string, prefix = 'feat'): string {
  const words = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6);
  return `${prefix}/${key}${words.length ? `-${words.join('-')}` : ''}`;
}
