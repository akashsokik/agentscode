// Issue keys (ACH-12): a project code, a hyphen and a number, as Linear writes them (ACH-D41).
// A decision or note id (ACH-D7, ACH-N3) is never a key: after the hyphen a key has digits only.
// Shared by everything that links work to an issue by key: branch names, PR titles and bodies,
// commit messages.

/** A key anywhere in text: not inside a longer word, and never followed by more letters or digits. */
const KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,5})-([1-9]\d{0,5})(?![A-Za-z0-9])/g;

export interface IssueKeyMatch {
  key: string;
  code: string;
  num: number;
  index: number;
}

/**
 * Every issue key in `text`, in order, without repeats. With `codes`, only keys whose project code
 * is one of them (so "UTF-8" or "ISO-9001" in a title is not a key). Branch names write the key
 * the same way (feat/ACH-12-short-title).
 */
export function findIssueKeys(text: string, codes?: Iterable<string>): IssueKeyMatch[] {
  const known = codes ? new Set([...codes].map(c => c.toUpperCase())) : null;
  const seen = new Set<string>();
  const out: IssueKeyMatch[] = [];
  for (const m of String(text ?? '').matchAll(KEY)) {
    const code = m[1];
    if (known && !known.has(code)) continue;
    const key = `${code}-${Number(m[2])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, code, num: Number(m[2]), index: m.index ?? 0 });
  }
  return out;
}

/** The first key in the first of `texts` that has one: a branch name wins over a title, a title over a body. */
export function firstIssueKey(texts: (string | undefined)[], codes?: Iterable<string>): string | null {
  for (const text of texts) {
    const found = findIssueKeys(text ?? '', codes);
    if (found.length) return found[0].key;
  }
  return null;
}
