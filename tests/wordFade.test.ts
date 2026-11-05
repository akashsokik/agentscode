import assert from 'node:assert/strict';
import test from 'node:test';
import type { Element, Root } from 'hast';
import { rehypeWordFade } from '../web/ui/rehypeWordFade.ts';

const el = (tagName: string, children: Element['children'], properties: Element['properties'] = {}): Element => ({ type: 'element', tagName, properties, children });
const text = (value: string) => ({ type: 'text' as const, value });

test('every word gets its own fading span and spaces stay text', () => {
  const tree: Root = { type: 'root', children: [el('p', [text('Fixed the  fold.'), el('strong', [text('Done now')])])] };
  rehypeWordFade()(tree);
  const p = tree.children[0] as Element;
  const words = p.children.filter((c): c is Element => c.type === 'element' && 'dataWordFade' in c.properties);
  assert.deepEqual(words.map(w => (w.children[0] as { value: string }).value), ['Fixed', 'the', 'fold.']);
  assert.deepEqual(p.children.filter(c => c.type === 'text').map(c => (c as { value: string }).value), [' ', '  '], 'whitespace is left as text');
  const strong = p.children.at(-1) as Element;
  assert.equal(strong.tagName, 'strong');
  assert.equal(strong.children.length, 3, 'words inside inline formatting are wrapped too');
});

test('code, links and blocks of code fade as one unit, their text untouched', () => {
  const code = el('pre', [el('code', [text('npm test')])]);
  const link = el('a', [text('the docs')], { href: 'https://example.com' });
  const tree: Root = { type: 'root', children: [code, el('p', [link])] };
  rehypeWordFade()(tree);
  assert.ok('dataWordFade' in code.properties);
  assert.deepEqual((code.children[0] as Element).children, [text('npm test')], 'no spans inside code');
  assert.ok('dataWordFade' in link.properties);
  assert.equal(link.properties.href, 'https://example.com', 'the link keeps its own properties');
  assert.deepEqual(link.children, [text('the docs')]);
});
