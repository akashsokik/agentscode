import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { githubHtmlPlugins, isWebUrl } from '../web/ui/remoteMarkdown.ts';

// ACH-41: a GitHub PR description's HTML renders as GitHub does (sanitized with its own schema), only
// in Markdown's remote mode. Rendered here through react-markdown with the same plugins.
const remote = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: githubHtmlPlugins as never }, md));
const plain = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md));

// The shape of dependabot's PR #84 in okikorg/orca-harness.
const DEPENDABOT = `Bumps [qs](https://github.com/ljharb/qs) from 6.15.3 to 6.17.1.
<details>
<summary>Changelog</summary>
<p><em>Sourced from <a href="https://github.com/ljharb/qs/blob/main/CHANGELOG.md">qs's changelog</a>.</em></p>
<blockquote>
<h2><strong>6.17.1</strong></h2>
<ul>
<li>[Fix] <code>stringify</code>: avoid a crash</li>
</ul>
</blockquote>
</details>`;

test('a dependabot description renders: a collapsible Changelog, links and code, not literal tags', () => {
  const html = remote(DEPENDABOT);
  assert.match(html, /<details>\s*<summary>Changelog<\/summary>/, 'details and summary are real elements');
  assert.match(html, /<a href="https:\/\/github\.com\/ljharb\/qs\/blob\/main\/CHANGELOG\.md">qs&#x27;s changelog<\/a>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<code>stringify<\/code>/);
  assert.doesNotMatch(html, /&lt;details&gt;/, 'no tag shows as text');
});

test('an XSS probe comes out inert: script, img onerror, javascript: href, style, iframe, on* handlers', () => {
  const probe = [
    '<script>alert(1)</script>',
    '<img src="x" onerror="alert(2)">',
    '<a href="javascript:alert(3)">click</a>',
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.example"></iframe>',
    '<div onclick="alert(4)" style="color:red">box</div>',
    '<details open ontoggle="alert(5)"><summary onclick="alert(6)">s</summary>x</details>',
    '<svg><script>alert(7)</script></svg>',
    '<a href="https://ok.example" onmouseover="alert(8)">ok</a>',
  ].join('\n\n');
  const html = remote(probe);
  for (const bad of [/<script/i, /<style/i, /<iframe/i, /\son[a-z]+=/i, /javascript:/i, /\sstyle=/i, /alert\(1\)|alert\(7\)/]) {
    assert.doesNotMatch(html, bad, `${bad} removed`);
  }
  assert.match(html, /<a href="https:\/\/ok\.example">ok<\/a>/, 'a safe link stays, without its handler');
  assert.match(html, /<details open=""><summary>s<\/summary>/, 'details keep working without handlers');
});

test('links are followed only to http(s); images never load from another server', () => {
  assert.equal(isWebUrl('https://github.com/x'), true);
  assert.equal(isWebUrl('http://example.com'), true);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '//evil.example', undefined]) assert.equal(isWebUrl(url), false, String(url));
  const md = fs.readFileSync(new URL('../web/ui/Markdown.tsx', import.meta.url), 'utf8');
  const comps = md.slice(md.indexOf('const remoteComponents'), md.indexOf('};', md.indexOf('const remoteComponents')));
  assert.match(comps, /a: \(\{ node: _node, href, children \}\) => \(isWebUrl\(href\)/);
  assert.match(comps, /img: \(\{ src, alt \}\) =>/);
  assert.doesNotMatch(comps, /<img/, 'an image is its alt text, linked');
});

test('only the remote mode renders HTML; every other caller keeps it out (transcripts unchanged)', () => {
  assert.match(plain('<details><summary>x</summary></details>'), /^(?!.*<details>)/s, 'no raw HTML without the remote plugins');
  const md = fs.readFileSync(new URL('../web/ui/Markdown.tsx', import.meta.url), 'utf8');
  assert.match(md, /remote \? \[\.\.\.\(remoteRehypePlugins as unknown\[\]\)\] : words \?/, 'the plugins are chosen by remote only');
  assert.equal(md.match(/githubHtmlPlugins/g)?.length, 2, 'imported once, used once (the remote list)');
  assert.match(read('web/prs/PullRequestsPane.tsx'), /<Markdown text=\{pr\.body\} remote/);
});

function read(p: string) { return fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'); }
