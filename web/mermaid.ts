import type { Element, ElementContent } from 'hast';

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(textOf).join('') : '';
}

/** The source of a fenced block in one of these languages, or null for any other block. */
export function fencedSource(pre: Element | undefined, languages: readonly string[]): string | null {
  const code = pre?.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes.map(String) : String(classes ?? '').split(/\s+/);
  return code && languages.some(lang => list.includes(`language-${lang}`)) ? code.children.map(textOf).join('').replace(/\n$/, '') : null;
}

/** The source of a ```mermaid fence, or null for any other block. */
export function mermaidSource(pre: Element | undefined): string | null {
  return fencedSource(pre, ['mermaid']);
}
