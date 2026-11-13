import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ACH-D52, ACH-D54: Comms, Pull requests (and next, Issues) share one list/detail layout,
// web/ui/Inbox.tsx, lifted out of CommsPane (PodCode's port of MonoCode's Inbox). Source checks:
// node cannot render the .tsx here.
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Comms and Pull requests both use the shared inbox layout, not their own', () => {
  for (const file of ['web/panes/CommsPane.tsx', 'web/prs/PullRequestsPane.tsx']) {
    const src = read(file);
    assert.match(src, /from '\.\.\/ui\/Inbox\.tsx'/, file);
    assert.match(src, /<InboxLayout/, file);
    assert.match(src, /<InboxCard/, file);
    assert.match(src, /<InboxDetail/, file);
    assert.doesNotMatch(src, /function TimelineStop/, `${file} keeps no copy of TimelineStop`);
    assert.doesNotMatch(src, /@container\/(comms|prs|thread)/, `${file} uses the shared container names`);
  }
  const prs = read('web/prs/PullRequestsPane.tsx');
  assert.doesNotMatch(prs, /PanelToolbar|PanelList|PanelRow/, 'the right-panel list style is not the inbox rail');
});

test('the PR detail matches the inbox screenshot: actions, Summary / Code / Checks tabs, and an activity timeline', () => {
  const prs = read('web/prs/PullRequestsPane.tsx');
  assert.match(prs, /'Copy link'/);
  assert.match(prs, /'Review on GitHub' : 'Open on GitHub'/);
  assert.match(prs, /value: 'summary', label: 'Summary'[\s\S]*value: 'code', label: 'Code'[\s\S]*value: 'checks', label: 'Checks'/);
  assert.match(prs, /<InboxSection title="Activity"/);
  assert.match(prs, /<Markdown text=\{pr\.body\} remote/, 'the description renders as remote, inert Markdown');
  const inbox = read('web/ui/Inbox.tsx');
  assert.doesNotMatch(inbox, /shadow-/, 'flat: no shadows');
});

test('remote Markdown never loads an image from someone else\'s server and links only to http(s)', () => {
  const md = read('web/ui/Markdown.tsx');
  const remote = md.slice(md.indexOf('const remoteComponents'), md.indexOf('};', md.indexOf('const remoteComponents')));
  assert.match(remote, /img: \(\{ src, alt \}\) =>/);
  assert.doesNotMatch(remote, /<img/, 'an image is its alt text, linked');
  assert.match(remote, /\^https\?:/);
});
