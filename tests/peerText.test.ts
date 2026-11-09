import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entry, PeerMessage } from '../shared/types.ts';
import {
  arrivalNote, boilerplateKind, commsIndex, delegationState, firstSentence, LATE_AFTER_MS, messageMarkdown, messagePreview, messageTag,
  outcomeTone, outcomeWords, repeatedPromptTurns, reportKind, stripBoilerplate, taskTitle,
} from '../web/peerText.ts';

const msg = (over: Partial<PeerMessage>): PeerMessage => ({
  id: 'm', conversationId: 'c', fromAgentId: 'a', fromName: 'Rhea', toAgentId: 'b', toName: 'Fen',
  text: '', expectsReply: false, ts: 1_000_000, status: 'delivered', ...over,
});
const entry = (peer: PeerMessage): Entry => ({ id: `peer:${peer.id}`, agentId: 'b', kind: 'peer', text: peer.text, peer, ts: peer.ts });

test('outcomes read as the work they answer: a review approves or needs changes, tests pass or fail', () => {
  assert.equal(outcomeWords('failed', 'review'), 'Changes needed');
  assert.equal(outcomeWords('passed', 'review'), 'Approved');
  assert.equal(outcomeWords('passed', 'testing'), 'Passed');
  assert.equal(outcomeWords('failed', 'testing'), 'Failed');
  assert.equal(outcomeWords('done', 'implementation'), 'Done');
  assert.equal(outcomeWords('blocked', 'review'), 'Blocked');
  assert.equal(outcomeWords('failed'), 'Failed', 'an unknown kind keeps the plain word');
  assert.equal(outcomeTone('failed'), 'danger');
  assert.equal(outcomeTone('blocked'), 'warning');
  assert.equal(outcomeTone('done'), 'success');
});

test('boilerplate openings name the kind and are dropped from what is shown', () => {
  assert.equal(boilerplateKind('REVIEW RESULT: FAILED\n\nVerdict: changes needed.'), 'review');
  assert.equal(boilerplateKind('IMPLEMENTATION: Fix the four findings'), 'implementation');
  assert.equal(boilerplateKind('Fixed on feat/x as commit 2f316b3.'), undefined);
  assert.equal(stripBoilerplate('REVIEW RESULT: FAILED\n\nVerdict: changes needed.'), 'Verdict: changes needed.');
  assert.equal(stripBoilerplate('IMPLEMENTATION RESULT: DONE\n\nAll four fixed.'), 'All four fixed.');
  assert.equal(stripBoilerplate('IMPLEMENTATION: Fix the four findings'), 'Fix the four findings');
});

test('the preview is the first sentence that says something', () => {
  assert.equal(firstSentence('Fixed on feat/super-followups as commit 2f316b3, on top of ded9cd5. Not merged, pushed or restarted.'),
    'Fixed on feat/super-followups as commit 2f316b3, on top of ded9cd5.');
  assert.equal(firstSentence('Hi Fen, the user asked me to review it. More here.'), 'the user asked me to review it.');
  assert.equal(firstSentence('Thanks!\nThe build is green. Next up: merge.'), 'The build is green.');
  assert.equal(firstSentence('x'.repeat(300), 50).length, 50);
  assert.ok(firstSentence('x'.repeat(300), 50).endsWith('…'));
});

test('a message leads with its meaning: a report its summary, a delegation its task', () => {
  const report = msg({ text: 'REVIEW RESULT: FAILED\n\nVerdict: changes needed.', report: { outcome: 'failed', summary: 'Verdict: changes needed. Two layout bugs.', evidence: '- typecheck ok' } });
  assert.equal(messagePreview(report), 'Verdict: changes needed.');
  assert.equal(messageTag(report), 'Report');
  assert.match(messageMarkdown(report), /\*\*Evidence\*\*\n\n- typecheck ok/);
  const delegation = msg({ text: 'IMPLEMENTATION: ...', delegation: { kind: 'implementation', task: 'IMPLEMENTATION: Fix the four findings. Then rebase.', acceptanceCriteria: '1. Floats' } });
  assert.equal(messagePreview(delegation), 'Fix the four findings.');
  assert.equal(messageTag(delegation), 'Implementation');
  assert.match(messageMarkdown(delegation), /^Fix the four findings\. Then rebase\.\n\n\*\*Acceptance criteria\*\*/);
  assert.equal(messageTag(msg({ replyTo: 'x' })), 'Reply');
  assert.equal(messageTag(msg({ expectsReply: true })), 'Question');
  assert.equal(taskTitle('REVIEW: Review Fen\'s branch. It moves the log.'), 'Review Fen\'s branch.');
});

test('a message that waited says when it was sent and when it arrived', () => {
  const clock = (ms: number) => `t${ms / 60_000}`;
  assert.equal(arrivalNote(0, LATE_AFTER_MS - 1, clock), null);
  assert.equal(arrivalNote(0, undefined, clock), null);
  assert.equal(arrivalNote(60_000, 60_000 + 36 * 60_000, clock), 'sent t1, arrived t37');
});

test('a report finds the delegation it answers, and the delegation shows where it stands', () => {
  const asked = msg({ id: 'd', fromAgentId: 'b', toAgentId: 'a', fromName: 'Fen', toName: 'Rhea', delegation: { kind: 'review', task: 'Review it.', acceptanceCriteria: '' }, status: 'delivering' });
  const report = msg({ id: 'r', replyTo: 'd', ts: 2_000_000, report: { outcome: 'failed', summary: 'Two bugs.', evidence: '' } });
  const index = commsIndex([entry(asked), entry(report)]);
  assert.equal(index.reportFor.get('d')?.id, 'r');
  assert.equal(reportKind(report, index.byId.get('d')), 'review');
  assert.deepEqual(delegationState(asked, index.reportFor.get('d')), { label: 'Changes needed', tone: 'danger' });
  assert.deepEqual(delegationState(asked), { label: 'Working', tone: 'busy' });
  assert.deepEqual(delegationState({ ...asked, status: 'queued' }), { label: 'Sent', tone: 'neutral' });
  assert.deepEqual(delegationState({ ...asked, status: 'delivered' }), { label: 'Awaiting report', tone: 'neutral' });
  assert.deepEqual(delegationState({ ...asked, status: 'failed' }), { label: 'Not delivered', tone: 'danger' });
  // A later report replaces an earlier one; a reply that is not a report never links.
  const again = msg({ id: 'r2', replyTo: 'd', ts: 3_000_000, report: { outcome: 'passed', summary: 'Fixed.', evidence: '' } });
  const chat = msg({ id: 'n', replyTo: 'd', ts: 4_000_000, text: 'Thanks' });
  assert.equal(commsIndex([entry(asked), entry(report), entry(again), entry(chat)]).reportFor.get('d')?.id, 'r2');
});

test('the same message delivered twice marks the second turn as a repeat', () => {
  const peer = entry(msg({ id: 'x' }));
  const other = entry(msg({ id: 'y' }));
  const user: Entry = { id: 'u', agentId: 'b', kind: 'user', text: 'hi', ts: 1 };
  const repeats = repeatedPromptTurns([
    { id: 't1', prompt: peer }, { id: 't2', prompt: user }, { id: 't3', prompt: peer }, { id: 't4', prompt: other }, { id: 't5' },
  ]);
  assert.deepEqual([...repeats], ['t3']);
});

test('an openui-lang block only comes alive in the agent\'s own words, never in a teammate\'s message', async () => {
  const { openUiLive } = await import('../web/openuiTrust.ts');
  assert.equal(openUiLive(true, false), true, 'the agent\'s own reply draws its UI');
  assert.equal(openUiLive(true, true), false, 'a teammate\'s buttons would answer as the user: they stay code');
  assert.equal(openUiLive(false, false), false);
});

test('a delegation this agent sent stands on its own, so it stays in view when the work folds', async () => {
  const { groupTurnItems, foldableWork, keptInView, isOutgoingDelegation } = await import('../web/activity.ts');
  const sent = msg({ id: 'd', fromAgentId: 'b', toAgentId: 'a', delegation: { kind: 'review', task: 'Review it.', acceptanceCriteria: '' } });
  const out: Entry = { ...entry(sent), agentId: 'b' };
  const got: Entry = { ...entry(msg({ id: 'i', fromAgentId: 'a', toAgentId: 'b', delegation: { kind: 'review', task: 'x', acceptanceCriteria: '' } })), agentId: 'b' };
  assert.equal(isOutgoingDelegation(out), true);
  assert.equal(isOutgoingDelegation(got), false, 'one sent to this agent is not its card');
  const tool: Entry = { id: 't', agentId: 'b', kind: 'tool', text: '', ts: 1, tool: { id: 't', name: 'Read', input: { file_path: '/x' }, status: 'done' } as never };
  const prose: Entry = { id: 'p', agentId: 'b', kind: 'agent', text: 'Delegated the review.', ts: 3 };
  const later: Entry = { ...tool, id: 't2', ts: 2 };
  const items = groupTurnItems([tool, out, later, prose]);
  assert.deepEqual(items.map(i => i.type), ['activity', 'delegation', 'activity', 'prose']);
  const fold = foldableWork(items);
  assert.deepEqual(fold, { start: 0, end: 2 }, 'the card is inside the work that folds');
  assert.deepEqual(keptInView(items, fold).map(i => i.type), ['delegation'], 'but stays in view under the fold');
});
