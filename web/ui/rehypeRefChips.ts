import type { Element, ElementContent, Root } from 'hast';
import { ISSUE_KEY } from '../../shared/issueKeys.ts';
import { findRefIds } from '../../shared/refs.ts';

/* Note and decision ids, and issue keys, in rendered Markdown become chips; no DOM here, so it is tested directly. */

/**
 * Known issue keys in a text, every occurrence (ACH-23): not inside a URL, a path or a longer word.
 * A key is written as the app shows it (ACH-012 is not ACH-12's chip).
 */
export function findIssueKeyChips(text: string, known: (key: string) => boolean): { key: string; start: number; end: number }[] {
  const out: { key: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(ISSUE_KEY)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const key = m[0];
    if (`${m[1]}-${Number(m[2])}` !== key || !known(key)) continue;
    // Part of a path or URL (repos/ACH-23, feat/ACH-23-x, https://x/ACH-23): left as text.
    if ((start > 0 && /[/\\:._@#-]/.test(text[start - 1])) || (end < text.length && /[/\\]/.test(text[end]))) continue;
    out.push({ key, start, end });
  }
  return out;
}

/** Text under these is never a citation: code, links, drawings, form controls. */
const SKIP_TAGS = new Set(['a', 'code', 'pre', 'kbd', 'samp', 'svg', 'math', 'button', 'input', 'textarea', 'script', 'style']);

/**
 * Splits text nodes around known ids into `<span data-ref="ACH-D7">` elements, which the Markdown
 * renderer draws as chips. Text inside code, links and the like is left alone, so an id in a URL or
 * a code block never becomes one.
 */
export function rehypeRefChips(options: { known: (id: string) => boolean; issue?: (key: string) => boolean }) {
  return (tree: Root) => {
    const walk = (parent: Root | Element) => {
      let changed = false;
      const children: ElementContent[] = [];
      for (const child of parent.children) {
        if (child.type === 'text') {
          const found = [
            ...findRefIds(child.value, options.known).map(m => ({ start: m.start, end: m.end, text: m.id, properties: { dataRef: m.id } })),
            ...(options.issue ? findIssueKeyChips(child.value, options.issue) : []).map(m => ({ start: m.start, end: m.end, text: m.key, properties: { dataIssueKey: m.key } })),
          ].sort((a, b) => a.start - b.start);
          if (!found.length) { children.push(child); continue; }
          changed = true;
          let last = 0;
          for (const match of found) {
            if (match.start < last) continue;
            if (match.start > last) children.push({ type: 'text', value: child.value.slice(last, match.start) });
            children.push({ type: 'element', tagName: 'span', properties: match.properties, children: [{ type: 'text', value: match.text }] });
            last = match.end;
          }
          if (last < child.value.length) children.push({ type: 'text', value: child.value.slice(last) });
        } else {
          if (child.type === 'element' && !SKIP_TAGS.has(child.tagName)) walk(child);
          children.push(child as ElementContent);
        }
      }
      if (changed) parent.children = children as typeof parent.children;
    };
    walk(tree);
  };
}
