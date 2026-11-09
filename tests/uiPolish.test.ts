import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, PeerMessage } from '../shared/types.ts';
import { APPROVAL_KEY_GUARD_MS, approvalKeyAction, approvalText, inputSummary, tildePath, type ApprovalKey } from '../web/approvalText.ts';
import { messagePhrase, trailPhrase } from '../web/peerText.ts';
import { homeRecent, homeTarget } from '../web/quick/route.ts';
import { emptySections } from '../web/right/overviewText.ts';
import { agentGroup, groupAgents } from '../web/sidebar/agentRail.ts';

const message = (fields: Partial<PeerMessage>): PeerMessage => ({ id: 'm1', fromAgentId: 'super', fromName: 'SuperAgent', toAgentId: 'ada', toName: 'Ada', text: 'hello', ts: 1, ...fields }) as PeerMessage;

test('a teammate header reads as a sentence after the sender\'s name', () => {
  assert.equal(messagePhrase(message({ delegation: { kind: 'implementation', task: 't', acceptanceCriteria: '' } as PeerMessage['delegation'] })), 'asked for an implementation');
  assert.equal(messagePhrase(message({ delegation: { kind: 'review', task: 't', acceptanceCriteria: '' } as PeerMessage['delegation'] })), 'asked for a review');
  assert.equal(messagePhrase(message({ report: { outcome: 'done', summary: 's', evidence: '' } as PeerMessage['report'], replyTo: 'm0' })), 'reported back');
  assert.equal(messagePhrase(message({ replyTo: 'm0' })), 'replied');
  assert.equal(messagePhrase(message({ expectsReply: true })), 'asked');
  assert.equal(messagePhrase(message({})), 'sent a note');
  assert.equal(messagePhrase(message({ channelId: 'c1' }), 'release'), 'posted in #release');
  assert.equal(messagePhrase(message({ channelId: 'c1', replyTo: 'm0' }), 'release'), 'answered in #release');
});

test('a message in an agent\'s own trail is told from that agent\'s side', () => {
  const sent = { fromAgentId: 'ada', fromName: 'Ada', toAgentId: 'super', toName: 'SuperAgent' };
  assert.equal(trailPhrase(message({ ...sent, report: { outcome: 'done', summary: 's', evidence: '' } as PeerMessage['report'] }), 'ada'), 'Reported to SuperAgent');
  assert.equal(trailPhrase(message({ ...sent, replyTo: 'm0' }), 'ada'), 'Replied to SuperAgent');
  assert.equal(trailPhrase(message({ ...sent, expectsReply: true }), 'ada'), 'Asked SuperAgent');
  assert.equal(trailPhrase(message({ ...sent }), 'ada'), 'Note to SuperAgent');
  assert.equal(trailPhrase(message({ replyTo: 'm0' }), 'ada'), 'Reply from SuperAgent');
  assert.equal(trailPhrase(message({ ...sent, channelId: 'c1' }), 'ada', 'release'), 'Posted in #release');
});

test('a read-only lookup names its file and tucks its raw input away', () => {
  const detail = '{\n  "file_path": "/Users/me/work/demo-shot.png"\n}';
  assert.deepEqual(approvalText({ toolName: 'Read', title: 'Use Read?', detail }), { lead: 'Read', target: 'demo-shot.png', path: '~/work/demo-shot.png', shown: '', hidden: detail });
  const grep = approvalText({ toolName: 'Grep', title: 'Use Grep?', detail: '{"pattern":"TODO","path":"/Users/me/src"}' });
  assert.deepEqual([grep.lead, grep.target, grep.path, grep.shown], ['Grep', 'src', '~/src', '']);
  assert.equal(approvalText({ toolName: 'LS', title: 'Use LS?', detail: '{"path":"/tmp/x"}' }).lead, 'List');
});

test('every other tool keeps its input in sight, whatever shape it has', () => {
  // A command or a diff is what you are allowing.
  assert.deepEqual(approvalText({ toolName: 'Bash', title: 'Run npm test?', detail: 'npm test\n# run the suite' }), { lead: 'Run', target: 'npm test', path: '', shown: 'npm test\n# run the suite', hidden: '' });
  // A file being written that happens to be JSON is content, not input: shown as is, no path pulled out of it.
  const content = '{\n  "path": "/etc/hosts",\n  "enabled": true\n}';
  assert.deepEqual(approvalText({ toolName: 'Write', title: 'Write config.json?', detail: content }), { lead: 'Write', target: 'config.json', path: '', shown: content, hidden: '' });
  // An MCP tool's input is shown one key a line, nothing hidden or dropped.
  const mcp = approvalText({ toolName: 'mcp__github__create_issue', title: 'Use github create_issue?', detail: '{\n  "repo": "acme/web",\n  "title": "x",\n  "labels": ["bug"],\n  "body": "secret"\n}' });
  assert.deepEqual(mcp, { lead: 'Use', target: 'github create_issue', path: '', shown: 'repo: acme/web\ntitle: x\nlabels: [\n  "bug"\n]\nbody: secret', hidden: '' });
  // Tools with a title of their own keep the server's detail untouched.
  const notebook = '{\n  "notebook_path": "/Users/me/a.ipynb",\n  "new_source": "import os"\n}';
  assert.deepEqual(approvalText({ toolName: 'NotebookEdit', title: 'Edit a.ipynb?', detail: notebook }), { lead: 'Edit', target: 'a.ipynb', path: '', shown: notebook, hidden: '' });
  const fetch = '{\n  "url": "https://example.com/x?token=1",\n  "prompt": "p"\n}';
  assert.deepEqual(approvalText({ toolName: 'WebFetch', title: 'Fetch example.com?', detail: fetch }), { lead: 'Fetch', target: 'example.com', path: '', shown: fetch, hidden: '' });
  // A tool that merely shares a read-only tool's JSON shape is not read-only.
  assert.equal(approvalText({ toolName: 'mcp__x__delete', title: 'Use x delete?', detail: '{"file_path":"/Users/me/a"}' }).hidden, '');
  // A title that is not "Verb target?" is shown as it is.
  assert.deepEqual(approvalText({ toolName: 'ExitPlanMode', title: 'Plan ready', detail: '' }), { lead: 'Plan ready', target: '', path: '', shown: '', hidden: '' });
});

test('a tool\'s input reads one key a line', () => {
  assert.equal(inputSummary({ to: 'ada', urgent: true, n: 2 }), 'to: ada\nurgent: true\nn: 2');
  assert.equal(inputSummary({}), '');
});

test('the home folder shows as ~', () => {
  assert.equal(tildePath('/Users/me/a/b.ts'), '~/a/b.ts');
  assert.equal(tildePath('/home/me'), '~');
  assert.equal(tildePath('/var/log/x'), '/var/log/x');
});

const press = (fields: Partial<ApprovalKey>): ApprovalKey => ({ key: 'Enter', modified: false, focus: 'pane', paneFocused: true, onScreen: true, first: true, settledForMs: 5000, typing: false, overlay: false, ...fields });

test('Enter allows and Esc denies the approval you are looking at', () => {
  assert.equal(approvalKeyAction(press({})), 'allow');
  assert.equal(approvalKeyAction(press({ key: 'Escape' })), 'deny');
  assert.equal(approvalKeyAction(press({ key: 'a' })), null);
  // Typing a message, a held modifier, an open menu or a focused button: not ours.
  for (const key of ['Enter', 'Escape']) {
    assert.equal(approvalKeyAction(press({ key, typing: true })), null);
    assert.equal(approvalKeyAction(press({ key, modified: true })), null);
    assert.equal(approvalKeyAction(press({ key, overlay: true })), null);
  }
});

test('keys only reach the first approval of the focused pane, while it is on screen', () => {
  for (const key of ['Enter', 'Escape']) {
    // Focus nowhere (the body): only the focused pane's approval answers.
    assert.notEqual(approvalKeyAction(press({ key, focus: 'none', paneFocused: true })), null);
    assert.equal(approvalKeyAction(press({ key, focus: 'none', paneFocused: false })), null);
    // Focus in another pane or outside any pane: never, even if this pane is marked focused.
    assert.equal(approvalKeyAction(press({ key, focus: 'elsewhere', paneFocused: true })), null);
    assert.equal(approvalKeyAction(press({ key, focus: 'elsewhere', paneFocused: false })), null);
    // Scrolled out of view, or in a hidden tab.
    assert.equal(approvalKeyAction(press({ key, onScreen: false })), null);
    assert.equal(approvalKeyAction(press({ key, focus: 'none', onScreen: false })), null);
    // A later approval waits its turn.
    assert.equal(approvalKeyAction(press({ key, first: false })), null);
  }
});

test('a key is ignored until the approval has settled: just shown, or just become first', () => {
  // settledForMs counts from when it appeared or from when the one before it was answered,
  // whichever is later, so a second Enter does not allow the next approval too.
  for (const key of ['Enter', 'Escape']) {
    assert.equal(approvalKeyAction(press({ key, settledForMs: 0 })), null);
    assert.equal(approvalKeyAction(press({ key, settledForMs: APPROVAL_KEY_GUARD_MS - 1 })), null);
    assert.notEqual(approvalKeyAction(press({ key, settledForMs: APPROVAL_KEY_GUARD_MS })), null);
  }
});

const agent = (id: string, status: Agent['status'], lastActiveAt = 0): Agent => ({ id, name: id, status, lastActiveAt, role: 'dev' }) as Agent;

test('the workspace column groups agents by what wants attention, keeping their order within a group', () => {
  const agents = [agent('a', 'idle'), agent('b', 'working'), agent('c', 'waiting'), agent('d', 'error'), agent('e', 'idle'), agent('f', 'working')];
  const groups = groupAgents(agents, new Set(['e']));
  assert.deepEqual(groups.map(g => [g.key, g.agents.map(a => a.id)]), [['needs-you', ['c', 'e']], ['working', ['b', 'f']], ['idle', ['a', 'd']]]);
  // A pending approval outranks working; empty groups are left out.
  assert.equal(agentGroup(agent('x', 'working'), true), 'needs-you');
  assert.deepEqual(groupAgents([agent('a', 'done')], new Set()).map(g => g.key), ['idle']);
  assert.deepEqual(groupAgents([], new Set()), []);
});

test('Home sends to the picked chip, unless the message opens with @Name', () => {
  const agents = [{ id: '1', name: 'Agent 1', role: 'dev' }, { id: '12', name: 'Agent 12', role: 'dev' }, { id: 'ada', name: 'Ada', role: 'dev' }, { id: 's', name: 'Boss', role: 'super' }] as Agent[];
  const picked = { kind: 'agent', agentId: 'ada' } as const;
  assert.deepEqual(homeTarget('  fix the build ', agents, picked), { target: picked, text: 'fix the build' });
  assert.deepEqual(homeTarget('@ada, fix the build', agents, { kind: 'super' }), { target: { kind: 'agent', agentId: 'ada' }, text: 'fix the build' });
  // The longest name wins, and a name must end where the mention does.
  assert.deepEqual(homeTarget('@Agent 12 go', agents, picked), { target: { kind: 'agent', agentId: '12' }, text: 'go' });
  assert.deepEqual(homeTarget('@Adam go', agents, picked), { target: picked, text: '@Adam go' });
  // The SuperAgent by its role's name or its own.
  assert.deepEqual(homeTarget('@SuperAgent plan it', agents, picked), { target: { kind: 'super' }, text: 'plan it' });
  assert.deepEqual(homeTarget('@Boss plan it', agents, picked), { target: { kind: 'super' }, text: 'plan it' });
  // A file mention is not an agent: the message goes to the chip as written.
  assert.deepEqual(homeTarget('@src/app.ts is slow', agents, picked), { target: picked, text: '@src/app.ts is slow' });
});

test('Home lists the agents that need you first, then the most recently active', () => {
  const agents = [agent('old', 'idle', 1), agent('new', 'idle', 9), agent('wait', 'waiting', 2), agent('pend', 'working', 3)];
  assert.deepEqual(homeRecent(agents, new Set(['pend']), 3).map(a => a.id), ['pend', 'wait', 'new']);
});

test('empty Overview sections are named once, in one line', () => {
  assert.equal(emptySections({ handoffs: 1, peers: 1, walkthroughs: 0, memories: 0 }), 'memories or walkthroughs');
  assert.equal(emptySections({ handoffs: 0, peers: 0, walkthroughs: 0, memories: 0 }), 'handoffs, teammates, memories or walkthroughs');
  assert.equal(emptySections({ handoffs: 0, peers: 2, walkthroughs: 1, memories: 3 }), 'handoffs');
  assert.equal(emptySections({ handoffs: 2, peers: 2, walkthroughs: 1, memories: 3 }), '');
  // Still loading: say nothing rather than claim it is empty.
  assert.equal(emptySections({ handoffs: 0, peers: 0, walkthroughs: undefined, memories: 0 }), '');
});
