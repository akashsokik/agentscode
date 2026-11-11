import type { Element, ElementContent, Root } from 'hast';

/* The word-wrapping half of wordFade.ts, with no DOM in it, so it is tested directly. */

/** Text here is not prose (code, drawings) or reads whole (links): it fades as one unit. */
const UNIT_TAGS = new Set(['a', 'code', 'pre', 'svg', 'math', 'kbd', 'img', 'input']);

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 9 || code === 13;
}

/** Wraps every word in a span that fades in as it is added to the page. */
export function rehypeWordFade() {
  return (tree: Root) => {
    const wrap = (value: string): ElementContent[] =>
      value
        .split(/(\s+)/)
        .filter(Boolean)
        .map(part =>
          isSpace(part.charCodeAt(0))
            ? { type: 'text', value: part }
            : { type: 'element', tagName: 'span', properties: { dataWordFade: '' }, children: [{ type: 'text', value: part }] },
        );

    const walk = (parent: Root | Element) => {
      const children: ElementContent[] = [];
      for (const child of parent.children) {
        if (child.type === 'text') {
          children.push(...wrap(child.value));
        } else if (child.type === 'element' && (UNIT_TAGS.has(child.tagName) || child.properties?.dataRef !== undefined)) {
          // A note or decision chip (rehypeRefChips) fades as one word.
          child.properties = { ...child.properties, dataWordFade: '' };
          children.push(child);
        } else {
          if (child.type === 'element') walk(child);
          children.push(child as ElementContent);
        }
      }
      parent.children = children as typeof parent.children;
    };

    walk(tree);
  };
}
