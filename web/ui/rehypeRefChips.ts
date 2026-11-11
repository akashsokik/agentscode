import type { Element, ElementContent, Root } from 'hast';
import { findRefIds } from '../../shared/refs.ts';

/* Note and decision ids in rendered Markdown become chips; no DOM here, so it is tested directly. */

/** Text under these is never a citation: code, links, drawings, form controls. */
const SKIP_TAGS = new Set(['a', 'code', 'pre', 'kbd', 'samp', 'svg', 'math', 'button', 'input', 'textarea', 'script', 'style']);

/**
 * Splits text nodes around known ids into `<span data-ref="ACH-D7">` elements, which the Markdown
 * renderer draws as chips. Text inside code, links and the like is left alone, so an id in a URL or
 * a code block never becomes one.
 */
export function rehypeRefChips(options: { known: (id: string) => boolean }) {
  return (tree: Root) => {
    const walk = (parent: Root | Element) => {
      let changed = false;
      const children: ElementContent[] = [];
      for (const child of parent.children) {
        if (child.type === 'text') {
          const found = findRefIds(child.value, options.known);
          if (!found.length) { children.push(child); continue; }
          changed = true;
          let last = 0;
          for (const match of found) {
            if (match.start > last) children.push({ type: 'text', value: child.value.slice(last, match.start) });
            children.push({ type: 'element', tagName: 'span', properties: { dataRef: match.id }, children: [{ type: 'text', value: match.id }] });
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
