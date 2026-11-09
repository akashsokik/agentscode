import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, PeerMessage } from '../shared/types.ts';
import { APPROVAL_KEY_GUARD_MS, approvalKeyAction, approvalText, tildePath, type ApprovalKey } from '../web/approvalText.ts';
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

test('an approval\'s question names what it acts on; raw tool input waits behind Show details', () => {
  const read = approvalText({ title: 'Use Read?', detail: '{\n  "file_path": "/Users/me/work/demo-shot.png"\n}' });
  assert.deepEqual(read, { lead: 'Read', target: 'demo-shot.png', path: '~/work/demo-shot.png', shown: '', hidden: '{\n  "file_path": "/Users/me/work/demo-shot.png"\n}' });
  // A command or a diff is what you are allowing, so it shows up front.
  const run = approvalText({ title: 'Run npm test?', detail: 'npm test\n# run the suite' });
  assert.deepEqual(run, { lead: 'Run', target: 'npm test', path: '', shown: 'npm test\n# run the suite', hidden: '' });
  // A tool with no file keeps its own name; its JSON is still tucked away.
  const mcp = approvalText({ title: 'Use agentscode send_message?', detail: '{"to":"ada"}' });
  assert.equal(mcp.lead, 'Use');
  assert.equal(mcp.target, 'agentscode send_message');
  assert.equal(mcp.path, '');
  assert.equal(mcp.hidden, '{"to":"ada"}');
  // A title that is not "Verb target?" is shown as it is.
  assert.deepEqual(approvalText({ title: 'Plan ready', detail: '' }), { lead: 'Plan ready', target: '', path: '', shown: '', hidden: '' });
  // Text that only looks like JSON is not hidden.
  assert.equal(approvalText({ title: 'Run x?', detail: '{ not json' }).shown, '{ not json');
});

test('the home folder shows as ~', () => {
  assert.equal(tildePath('/Users/me/a/b.ts'), '~/a/b.ts');
  assert.equal(tildePath('/home/me'), '~');
  assert.equal(tildePath('/var/log/x'), '/var/log/x');
});

test('Enter allows and Esc denies an approval only when the key is clearly meant for it', () => {
  const press = (fields: Partial<ApprovalKey>): ApprovalKey => ({ key: 'Enter', modified: false, shownForMs: 5000, inScope: true, typing: false, overlay: false, first: true, ...fields });
  assert.equal(approvalKeyAction(press({})), 'allow');
  assert.equal(approvalKeyAction(press({ key: 'Escape' })), 'deny');
  assert.equal(approvalKeyAction(press({ key: 'a' })), null);
  // Typing a message, a held modifier, an open menu, another pane, or a later approval: not ours.
  assert.equal(approvalKeyAction(press({ typing: true })), null);
  assert.equal(approvalKeyAction(press({ modified: true })), null);
  assert.equal(approvalKeyAction(press({ overlay: true })), null);
  assert.equal(approvalKeyAction(press({ inScope: false })), null);
  assert.equal(approvalKeyAction(press({ first: false })), null);
  // A key already on its way down when the approval landed was meant for something else.
  assert.equal(approvalKeyAction(press({ shownForMs: APPROVAL_KEY_GUARD_MS - 1 })), null);
  assert.equal(approvalKeyAction(press({ shownForMs: APPROVAL_KEY_GUARD_MS })), 'allow');
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
