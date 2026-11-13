import assert from 'node:assert/strict';
import test from 'node:test';
import type { Element, Root } from 'hast';
import { findIssueKeyChips, rehypeRefChips } from '../web/ui/rehypeRefChips.ts';
import { issueGist, updated } from '../web/ui/issueCard.ts';

// Issue keys in rendered text become chips that show the issue on the Issues page (Phase 6, ACH-23):
// only keys of issues that exist, never in code, a link, a path or a longer word.

const ISSUES = new Set(['ACH-23', 'ACH-7', 'ALL-25']);
const known = (key: string) => ISSUES.has(key);
const keys = (text: string) => findIssueKeyChips(text, known).map(m => m.key);

test('known issue keys in prose, every occurrence, with their places', () => {
  assert.deepEqual(keys('ACH-23 blocks ACH-7; see ACH-23 again and ALL-25.'), ['ACH-23', 'ACH-7', 'ACH-23', 'ALL-25']);
  const [first] = findIssueKeyChips('Fix ACH-23 now', known);
  assert.deepEqual(first, { key: 'ACH-23', start: 4, end: 10 });
});

test('never a chip: unknown or removed keys, UTF-8 and SHA-256, ACH-0, padded numbers, decision ids, paths, URLs, longer words', () => {
  for (const text of ['ACH-99 is gone', 'UTF-8 and SHA-256', 'ACH-0', 'ACH-023', 'per ACH-D23', 'feat/ACH-23-x', 'repos/ACH-23', 'https://x.dev/ACH-23', 'XACH-23', 'ACH-23B', 'ACH-23/x', 'ACH-23.md is fine?']) {
    const found = keys(text);
    if (text === 'ACH-23.md is fine?') assert.deepEqual(found, ['ACH-23'], 'a sentence end or a file stem is not a path; only / and \\ after it are');
    else assert.deepEqual(found, [], text);
  }
});

const el = (tagName: string, children: Element['children'], properties: Element['properties'] = {}): Element => ({ type: 'element', tagName, properties, children });
const txt = (value: string) => ({ type: 'text' as const, value });

test('rehypeRefChips marks issue keys beside note and decision ids, never in code or links', () => {
  const p = el('p', [txt('ACH-23 per ACH-D7, see '), el('code', [txt('ACH-23')]), txt(' or '), el('a', [txt('ACH-7')], { href: 'https://x/ACH-7' }), el('strong', [txt('ACH-7')])]);
  const tree: Root = { type: 'root', children: [p] };
  rehypeRefChips({ known: id => id === 'ACH-D7', issue: known })(tree);
  const marks: string[] = [];
  const walk = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (typeof child.properties.dataRef === 'string') marks.push(`ref:${child.properties.dataRef}`);
      if (typeof child.properties.dataIssueKey === 'string') marks.push(`issue:${child.properties.dataIssueKey}`);
      walk(child);
    }
  };
  walk(tree);
  assert.deepEqual(marks, ['issue:ACH-23', 'ref:ACH-D7', 'issue:ACH-7'], 'in prose and bold; not in code or a link');
  assert.deepEqual(p.children.slice(0, 4).map(c => (c.type === 'text' ? c.value : Object.values((c as Element).properties)[0])), ['ACH-23', ' per ', 'ACH-D7', ', see ']);
  // Without the issue option (older callers), keys stay text.
  const plain: Root = { type: 'root', children: [el('p', [txt('ACH-23')])] };
  rehypeRefChips({ known: () => false })(plain);
  assert.deepEqual((plain.children[0] as Element).children, [txt('ACH-23')]);
});

test('the issue card: the gist of a description in plain words, and when it changed (ACH-33)', () => {
  assert.equal(issueGist('## Steps\n\n- open **the** view\n- press `S`\n\n```\ncode\n```\nSee [the doc](https://x).'), 'Steps open the view press S See the doc.');
  assert.equal(issueGist('x'.repeat(400)).length, 280);
  assert.equal(updated('now'), 'Updated just now');
  assert.equal(updated('5m'), 'Updated 5m ago');
  assert.equal(updated('4h 36m'), 'Updated 4h 36m ago');
});
