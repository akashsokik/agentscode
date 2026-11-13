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
  assert.match(remote, /isWebUrl\(/, 'http(s) only, through remoteMarkdown.ts');
});

test('polish (ACH-23): keyboard, focus, copy and refresh feedback, errors with a retry', () => {
  const inbox = read('web/ui/Inbox.tsx');
  assert.equal(inbox.match(/onKeyDown=\{e => onTablistKey\(/g)?.length, 2, 'both tab rows move with Left/Right/Home/End');
  assert.equal(inbox.match(/tabIndex=\{value === (option|tab)\.value \? 0 : -1\}/g)?.length, 2, 'roving tabindex: only the selected tab is a Tab stop');
  assert.match(inbox, /focus-visible:bg-content\/5 focus-visible:text-content'/, 'a keyboard-focused card has its own fill, never the selected card\'s');
  assert.match(inbox, /scrollIntoView\(\{ block: 'nearest' \}\)/, 'the selected card is kept in view');
  const prs = read('web/prs/PullRequestsPane.tsx');
  assert.match(prs, /e\.key !== 'j' && e\.key !== 'k'/, 'J/K walk the list');
  assert.match(prs, /closest\('input, textarea, \[contenteditable="true"\]'\)/, 'never while typing');
  assert.match(prs, /e\.key !== 'Escape'/, 'Escape in the detail returns to the card');
  assert.match(prs, /'Copy failed'/, 'a refused clipboard says so');
  assert.match(prs, /aria-live="polite"/);
  assert.match(prs, /\[&_svg\]:animate-spin motion-reduce:\[&_svg\]:animate-none/, 'Refresh spins while it reads');
  assert.equal(prs.match(/action=\{retry\}/g)?.length, 2, 'both error states offer Try again');
  assert.match(prs, /Could not refresh \(\{error\}\)/, 'a failed refresh keeps the old list and says so, above it');
  assert.match(prs, /setState\(prev => \(\{ detail: prev\.detail, error/, 'a failed re-read keeps the detail shown');
  assert.match(prs, /t === 'now' \? 'just now'/);
  assert.match(prs, /const \[tab, setTab\] = useState<PrTab>\('summary'\)/, 'the detail tab is kept across PRs (held by the page)');
  assert.match(prs, /api\.prDetail\(pr\.repo, pr\.number, fresh !== first\.current\)/, 'Refresh reads the shown PR again too');
});

test('Hal\'s audit (ACH-23): no blank narrow pane, a picked PR survives search, Back hands focus back', () => {
  const inbox = read('web/ui/Inbox.tsx');
  assert.match(inbox, /detailOpen && Boolean\(detail\) && .@max-\[40rem\]\/inbox:hidden'/, 'the rail hides only while a detail shows');
  const prs = read('web/prs/PullRequestsPane.tsx');
  assert.match(prs, /const selected = \(data\?\.pullRequests \?\? \[\]\)\.find\(pr => pr\.id === prId\)/, 'selection from the full list, as Comms');
  assert.match(prs, /onBack=\{\(\) => \{ open\(\{ kind: 'pullRequests' \}\); focusCard\(pr\.id\); \}\}/);
});

test('InboxHero can draw an editor in its heading, for the issue title (ACH-23)', () => {
  const inbox = read('web/ui/Inbox.tsx');
  assert.match(inbox, /<h1 title=\{title\} className=\{cx\('font-sans text-\[18px\] font-semibold leading-tight text-content', heading === undefined && 'line-clamp-2'\)\}>\{heading \?\? title\}<\/h1>/);
});

test('a picked PR that is gone shows the list in a narrow pane, not another PR (ACH-23)', () => {
  assert.match(read('web/prs/PullRequestsPane.tsx'), /detailOpen=\{Boolean\(prId\) && selected\?\.id === prId\}/);
});

test('every issue key on the PR page is the shared IssueKeyChip (ACH-40, ACH-D57, ACH-D58)', () => {
  const prs = read('web/prs/PullRequestsPane.tsx');
  assert.match(prs, /import \{ IssueKeyChip \} from '\.\.\/ui\/IssueKeyChip\.tsx'/);
  assert.match(prs, /<IssueKeyChip issueKey=\{pr\.issueKey\} inert \/>/, 'on the card, which is itself a button');
  assert.match(prs, /<IssueKeyChip issueKey=\{pr\.issueKey\} \/>/, 'in the detail');
  assert.doesNotMatch(prs, /text-\[var\(--link-color\)\]">\{pr\.issueKey\}/, 'no coloured span left');
  assert.match(read('web/ui/IssueKeyChip.tsx'), /if \(!issue\) return <>\{issueKey\}<\/>/, 'an unknown key stays plain text');
});
