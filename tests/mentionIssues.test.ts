import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { applyMention, mentionTokenAt, pickGroup, rankIssues, rankMentions, titleWordPositions, type PickIssue } from '../web/composer/tokens.ts';
import { mentionPhrases } from '../web/composer/mentionHints.ts';
import { issueMentionLines, mentionContext } from '../shared/mentions.ts';

// @-mention issues (ACH-62, ACH-D86): issues in the @ picker, a pick writes the bare key, a sent
// message chips it, and the receiving agent is told the issue's title, status and project.

const issue = (key: string, title: string, status = 'todo', extra: Partial<PickIssue> = {}): PickIssue => ({ id: `id-${key}`, key, title, status, projectId: 'p1', ...extra });
const ISSUES: PickIssue[] = [
  issue('ACH-2', 'Picker keys'),
  issue('ACH-21', 'Back and forward history', 'in_progress'),
  issue('ACH-26', 'Issues page: Filter with submenus, chips and Display', 'in_progress'),
  issue('ACH-22', 'SuperAgent fully independent: an autonomy setting', 'in_progress'),
  issue('ACH-32', 'Duplicate handling: mark and fold duplicates', 'backlog'),
  issue('ACH-9', 'A finished one', 'done'),
  issue('OSI-4', 'Landing page hero', 'todo', { projectId: 'p2' }),
];

test('nothing for a bare @: the picker stays agents, projects and files', () => {
  assert.deepEqual(rankIssues(ISSUES, ''), []);
  assert.deepEqual(rankIssues(ISSUES, '   '), []);
  const picks = rankMentions({ agents: [{ id: 'a', name: 'Ada' }], projects: [], issues: ISSUES, files: [], query: '' });
  assert.ok(picks.every(p => p.kind !== 'issue'));
});

test('by key: the start of a key, with or without the dash, nearest number first; marks the typed part', () => {
  assert.deepEqual(rankIssues(ISSUES, 'ach-2').map(r => r.issue.key), ['ACH-2', 'ACH-21', 'ACH-22', 'ACH-26']);
  assert.deepEqual(rankIssues(ISSUES, 'ach2').map(r => r.issue.key), ['ACH-2', 'ACH-21', 'ACH-22', 'ACH-26']);
  assert.deepEqual(rankIssues(ISSUES, 'osi').map(r => r.issue.key), ['OSI-4']);
  assert.deepEqual(rankIssues(ISSUES, 'ach-26')[0].keyPositions, [0, 1, 2, 3, 4, 5]);
});

test('by title: every query word starts a title word, in order; no scattered letters', () => {
  assert.deepEqual(rankIssues(ISSUES, 'filt').map(r => r.issue.key), ['ACH-26']);
  assert.deepEqual(rankIssues(ISSUES, 'filter').map(r => r.issue.key), ['ACH-26'], 'not ACH-22 by f…ully i…ndependent');
  assert.deepEqual(rankIssues(ISSUES, 'dup hand').map(r => r.issue.key), ['ACH-32']);
  assert.deepEqual(rankIssues(ISSUES, 'fold mark').map(r => r.issue.key), [], 'words in the title\'s order (mark comes before fold)');
  assert.deepEqual(titleWordPositions('dup hand', 'Duplicate handling: mark'), [0, 1, 2, 10, 11, 12, 13]);
});

test('open issues only, at most six; an exact key still lists a closed issue, and leads as Best match', () => {
  assert.deepEqual(rankIssues(ISSUES, 'ach-9').map(r => r.issue.key), ['ACH-9'], 'exact key, even done');
  assert.deepEqual(rankIssues(ISSUES, 'finished'), [], 'a closed issue is not found by its title');
  const many = Array.from({ length: 12 }, (_, i) => issue(`ACH-${100 + i}`, `Task ${i}`));
  assert.equal(rankIssues(many, 'ach-1').length, 6);
  const picks = rankMentions({ agents: [], projects: [], issues: ISSUES, files: [], query: 'ACH-26' });
  assert.equal(picks[0].kind, 'issue');
  assert.equal(picks[0].best, true);
  assert.equal(pickGroup(picks[0]), 'Best match');
});

test('issues sit after projects and before files, under "Issues"', () => {
  const picks = rankMentions({
    agents: [{ id: 'a', name: 'Ada' }], projects: [{ id: 'p1', name: 'agent-comms-harness', path: '/x' }], issues: ISSUES,
    files: [{ relative: 'achoo.ts', name: 'achoo.ts', isDir: false, positions: [] }], query: 'ach',
  });
  assert.deepEqual([...new Set(picks.map(pickGroup))], ['Projects', 'Issues', 'Files']);
});

test('a pick writes the bare key and a space, no @; other picks keep their @', () => {
  const text = 'Can you pick up @filt today';
  const token = mentionTokenAt(text, 'Can you pick up @filt'.length)!;
  const [hit] = rankIssues(ISSUES, token.query);
  const picked = applyMention(text, token, { kind: 'issue', ...hit });
  assert.equal(picked.text, 'Can you pick up ACH-26 today');
  assert.equal(picked.caret, 'Can you pick up ACH-26 '.length);
  const atEnd = applyMention('see @ach-3', mentionTokenAt('see @ach-3', 10)!, { kind: 'issue', ...rankIssues(ISSUES, 'ach-3')[0] });
  assert.equal(atEnd.text, 'see ACH-32 ');
  const agent = applyMention('ask @ad', mentionTokenAt('ask @ad', 7)!, { kind: 'agent', agent: { id: 'a', name: 'Ada' }, positions: [] });
  assert.equal(agent.text, 'ask @Ada ');
});

test('title words keep the @ token open past a space; other words close it', () => {
  const phrases = mentionPhrases(ISSUES.map(i => ({ title: i.title, status: i.status })));
  assert.ok(!phrases.includes('A finished one'), 'closed titles do not hold the picker open');
  const text = 'look at @dup hand';
  assert.deepEqual(mentionTokenAt(text, text.length, [], phrases), { start: 8, end: text.length, query: 'dup hand' });
  assert.equal(mentionTokenAt('look at @dup zzz', 16, [], phrases), null);
  assert.equal(mentionTokenAt(text, text.length, [], []), null, 'without the titles, a space ends the token as before');
});

const PROJECTS = [{ id: 'p1', name: 'agent-comms-harness', path: '/w/ach' }, { id: 'p2', name: 'orca-site', path: '/w/osi' }];
const LOOKUP_ISSUES = [
  { key: 'ACH-26', title: 'Issues page: "Filter" with\nsubmenus', status: 'in_progress' as const, projectId: 'p1' },
  { key: 'ALL-3', title: 'No home', status: 'todo' as const, projectId: null },
];

test('the context line: key, title, status and project; each key once, in order; unknown keys skipped', () => {
  assert.deepEqual(issueMentionLines('ACH-26 and ALL-3, then ACH-26 again, UTF-8 and ACH-999', LOOKUP_ISSUES, PROJECTS), [
    `- ACH-26: the issue "Issues page: 'Filter' with submenus" (In progress, project agent-comms-harness).`,
    '- ALL-3: the issue "No home" (Todo, no project).',
  ]);
  assert.deepEqual(issueMentionLines('nothing here', LOOKUP_ISSUES, PROJECTS), []);
  assert.deepEqual(issueMentionLines('ACH-26', undefined, PROJECTS), []);
});

test('the lines join the existing note, with its heading, in agent messages and channel posts', () => {
  const lookup = { agents: [], projects: PROJECTS, issues: LOOKUP_ISSUES };
  assert.equal(mentionContext([], lookup, 'Pick up ACH-26 please'),
    'Mentioned in this message (references to help you; mentioning an agent here does not message it):\n'
    + `- ACH-26: the issue "Issues page: 'Filter' with submenus" (In progress, project agent-comms-harness).`);
  assert.match(mentionContext([], { ...lookup, channel: true }, 'ACH-26'), /^Mentioned in this post \(who and what it refers to\):\n- ACH-26: /);
  assert.equal(mentionContext([], lookup, 'no keys'), '');
  assert.equal(mentionContext([], lookup), '', 'without the text, nothing about issues');
});

test('wired everywhere: the three composers, the picker row, the sent chip and both server paths', () => {
  const read = (path: string) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const file of ['../web/panes/Composer.tsx', '../web/panes/ChannelComposer.tsx', '../web/quick/QuickComposer.tsx']) {
    const src = read(file);
    assert.match(src, /applyMention\(/, `${file} applies picks with applyMention`);
    assert.match(src, /issues: [^,]*issues \?\? \[\]/i, `${file} passes issues to rankMentions`);
    assert.match(src, /mentionPhrases\(/, `${file} keeps title words open`);
  }
  const picker = read('../web/composer/Pickers.tsx');
  assert.match(picker, /pick\.kind === 'issue'[\s\S]*?<StatusIcon status=\{pick\.issue\.status as IssueStatus\} className="size-3\.5" \/>/);
  assert.match(read('../web/ui/MentionText.tsx'), /<IssueKeyChip key=/, 'a sent message chips known keys with the existing IssueKeyChip');
  assert.match(read('../server/manager.ts'), /mentionContext\(mentions, \{[^\n]*\}, text\);/);
  assert.match(read('../server/comms/channels.ts'), /mentionContext\(post\.mentions \?\? \[\], \{[^\n]*\}, post\.text\);/);
});

test('end to end: an agent message and a channel post tell the agent about the issue keys in them, and start nobody else', async () => {
  const { harness, projectDir } = await import('./helpers.ts');
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const bo = await h.manager.create({ name: 'Bo', engine: 'claude', projectId: web.id });
  const state = h.manager.addIssue({ text: 'Fix the login redirect', projectId: web.id });
  const key = state.issues[state.issues.length - 1].key;
  h.manager.send(ada.id, `Please take ${key} next, and ignore UTF-8.`);
  const sent = h.runner(ada.id).sent[0].text;
  assert.match(sent, new RegExp(`- ${key}: the issue "Fix the login redirect" \\(Todo, project web\\)\\.`));
  assert.equal(sent.match(new RegExp(`- ${key}:`, 'g'))?.length, 1);
  // A fresh member (Ada is still on the first message, so a post to her would wait).
  const cy = await h.manager.create({ name: 'Cy', engine: 'claude', projectId: web.id });
  const channel = h.manager.createChannel({ name: 'ship', memberIds: [cy.id, bo.id] });
  h.manager.postToChannel(channel.id, `@Cy can you check ${key}?`, [cy.id]);
  assert.match(h.runner(cy.id).sent[0].text, new RegExp(`Mentioned in this post \\(who and what it refers to\\):[\\s\\S]*- ${key}: the issue "Fix the login redirect"`));
  assert.ok(!h.manager.entries(bo.id).some(e => e.kind === 'user' || e.kind === 'peer'), 'a key starts nobody: only the members picked are delivered to');
});
