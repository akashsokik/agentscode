// Issue keys (ACH-D41): a project's code and a number, ACH-25, given once per project in the order
// issues are made and never reused. Agents name branches after them (feat/ACH-25-short-title) and
// cite them in commits, PRs and reports, which is how those link back to the issue. Pure.

/** A project code: a capital letter, then one to five capitals or digits (server/projectRefs.ts). */
export const CODE_PATTERN = '[A-Z][A-Z0-9]{1,5}';

/**
 * A key in running text: a code, a dash, then digits, not inside a longer word. The number comes
 * straight after the dash, so note and decision ids (ACH-N3, ACH-D41, ALL-D9) never match.
 * Global: use with matchAll, or issueKeysIn / findIssueKeys.
 */
export const ISSUE_KEY = new RegExp(`(?<![A-Za-z0-9])(${CODE_PATTERN})-(\\d{1,6})(?![A-Za-z0-9])`, 'g');

/** The code used for issues with no project, as notes and decisions use ALL for every project. */
export const NO_PROJECT_CODE = 'ALL';

export interface IssueKeyMatch {
  /** Normalised: ACH-012 is ACH-12. */
  key: string;
  code: string;
  num: number;
  /** Where it starts in the text. */
  index: number;
}

/**
 * Every key in a text (a branch name, a commit, a PR title or body, a report), once each, in order.
 * With `codes`, only keys whose code is one of them, so "UTF-8", "ISO-9001" or "SHA-256" in a title
 * never count. Pass the projects' codes and ALL (NO_PROJECT_CODE) whenever the text is not yours.
 */
export function findIssueKeys(text: string, codes?: Iterable<string>): IssueKeyMatch[] {
  const known = codes ? new Set([...codes].map(c => c.toUpperCase())) : null;
  const seen = new Set<string>();
  const out: IssueKeyMatch[] = [];
  for (const m of String(text ?? '').matchAll(ISSUE_KEY)) {
    const code = m[1];
    if (known && !known.has(code)) continue;
    const num = Number(m[2]);
    // Keys start at 1 (nextIssueKey), so ACH-0 or ACH-000 is never an issue.
    if (num === 0) continue;
    const key = `${code}-${num}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, code, num, index: m.index ?? 0 });
  }
  return out;
}

/** The keys alone: findIssueKeys(text, codes) as strings. */
export function issueKeysIn(text: string, codes?: Iterable<string>): string[] {
  return findIssueKeys(text, codes).map(k => k.key);
}

/** The first key in the first of `texts` that has one: pass [branch, title, body], so a branch wins over a title, a title over a body. */
export function firstIssueKey(texts: (string | null | undefined)[], codes?: Iterable<string>): string | null {
  for (const text of texts) {
    const found = findIssueKeys(text ?? '', codes);
    if (found.length) return found[0].key;
  }
  return null;
}

/** The next key for a project code, past every number it has ever given (counters) and any key in use. */
export function nextIssueKey(code: string, counters: Record<string, number>, keysInUse: Iterable<string> = []): { key: string; counters: Record<string, number> } {
  let top = counters[code] ?? 0;
  for (const k of keysInUse) {
    const m = new RegExp(`^(${CODE_PATTERN})-(\\d+)$`).exec(k);
    if (m && m[1] === code) top = Math.max(top, Number(m[2]));
  }
  return { key: `${code}-${top + 1}`, counters: { ...counters, [code]: top + 1 } };
}

/** A branch name for an issue: feat/ACH-25-short-title-in-words (lowercase, at most 6 words). */
export function issueBranchName(key: string, title: string, prefix = 'feat'): string {
  const words = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6);
  return `${prefix}/${key}${words.length ? `-${words.join('-')}` : ''}`;
}
