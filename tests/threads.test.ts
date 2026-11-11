import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelPost } from '../shared/types.ts';
import { buildThreads, continuesGroup, GROUP_WINDOW_MS, participantMarks, remainingDraft, seenBaseline, settleDraft, threadRootId } from '../web/threads.ts';

// Local noon, so day boundaries do not depend on the machine's time zone.
const NOON = new Date(2026, 10, 4, 12, 0, 0).getTime();
const MIN = 60_000;

const p = (post: Partial<ChannelPost> & Pick<ChannelPost, 'id'>): ChannelPost => ({
  channelId: 'c1', ts: NOON, from: 'user', fromName: 'You', kind: 'post', text: post.id, to: [], ...post,
});
const ada = { from: 'agent' as const, agentId: 'ada', fromName: 'Ada' };
const bo = { from: 'agent' as const, agentId: 'bo', fromName: 'Bo' };
const ids = (posts: ChannelPost[]) => posts.map(post => post.id);

test('threadId names the root, and wins over inReplyTo', () => {
  const root = p({ id: 'r' });
  const reply = p({ id: 'x', ...ada, threadId: 'r', inReplyTo: 'other' });
  const byId = new Map([root, reply].map(post => [post.id, post]));
  assert.equal(threadRootId(root, byId), null, 'a top-level post has no root');
  assert.equal(threadRootId(reply, byId), 'r');
});

test('posts from before threads find their root by walking inReplyTo', () => {
  const posts = [
    p({ id: 'r' }),
    p({ id: 'a1', ...ada, kind: 'reply', inReplyTo: 'r' }),
    p({ id: 'b1', ...bo, inReplyTo: 'a1' }),
    p({ id: 'a2', ...ada, inReplyTo: 'b1' }),
  ];
  const byId = new Map(posts.map(post => [post.id, post]));
  assert.equal(threadRootId(posts[3], byId), 'r');
  const { main, threads } = buildThreads(posts);
  assert.deepEqual(ids(main), ['r']);
  assert.deepEqual(ids(threads.get('r')!.replies), ['a1', 'b1', 'a2']);
});

test('a chain that reaches a parent with a threadId uses that thread', () => {
  const posts = [p({ id: 'r' }), p({ id: 'a1', ...ada, threadId: 'r' }), p({ id: 'old', ...bo, inReplyTo: 'a1' })];
  assert.deepEqual(ids(buildThreads(posts).threads.get('r')!.replies), ['a1', 'old']);
});

test('replies whose root is not loaded stay in the main list', () => {
  const posts = [
    p({ id: 'x', ...ada, threadId: 'gone' }),
    p({ id: 'y', ...bo, inReplyTo: 'missing' }),
    p({ id: 'z', ...ada, inReplyTo: 'y' }),
    p({ id: 'r' }),
  ];
  const { main, threads } = buildThreads(posts);
  assert.deepEqual(ids(main), ['x', 'y', 'z', 'r'], 'nothing is dropped');
  assert.equal(threads.size, 0);
});

test('a cyclic inReplyTo chain does not hang and stays visible', () => {
  const posts = [p({ id: 'a', inReplyTo: 'b' }), p({ id: 'b', inReplyTo: 'a' })];
  const byId = new Map(posts.map(post => [post.id, post]));
  assert.equal(threadRootId(posts[0], byId), null);
  assert.deepEqual(ids(buildThreads(posts).main), ['a', 'b']);
});

test('a thread counts replies, lists each participant once and knows its last reply', () => {
  const posts = [
    p({ id: 'r', ts: NOON }),
    p({ id: 'a1', ...ada, threadId: 'r', ts: NOON + 1 * MIN }),
    p({ id: 'u1', threadId: 'r', ts: NOON + 2 * MIN }),
    p({ id: 'a2', ...ada, threadId: 'r', ts: NOON + 3 * MIN }),
    p({ id: 'b1', ...bo, threadId: 'r', ts: NOON + 4 * MIN }),
    p({ id: 'ev', from: 'system', fromName: 'Podcode', kind: 'event', threadId: 'r', ts: NOON + 5 * MIN }),
    p({ id: 'next', ts: NOON + 6 * MIN }),
  ];
  const { main, threads } = buildThreads(posts);
  assert.deepEqual(ids(main), ['r', 'next']);
  const thread = threads.get('r')!;
  assert.equal(thread.replies.length, 5);
  assert.deepEqual(thread.participants.map(x => x.key), ['a:ada', 'user', 'a:bo'], 'events are not participants');
  assert.equal(thread.lastReplyAt, NOON + 5 * MIN);
  assert.equal(threads.has('next'), false, 'posts without replies have no thread');
});

test('posts group under one header for the same author within five minutes', () => {
  const first = p({ id: '1', ...ada });
  assert.equal(continuesGroup(undefined, first), false);
  assert.equal(continuesGroup(first, p({ id: '2', ...ada, ts: NOON + GROUP_WINDOW_MS })), true);
  assert.equal(continuesGroup(first, p({ id: '3', ...ada, kind: 'reply', ts: NOON + MIN })), true, 'a reply reads like a post');
  assert.equal(continuesGroup(first, p({ id: '4', ...ada, ts: NOON + GROUP_WINDOW_MS + 1 })), false, 'too late');
  assert.equal(continuesGroup(first, p({ id: '5', ...bo, ts: NOON + MIN })), false, 'another author');
  assert.equal(continuesGroup(first, p({ id: '6', ts: NOON + MIN })), false, 'the user is another author');
  assert.equal(continuesGroup(first, p({ id: '7', ...ada, kind: 'error', ts: NOON + MIN })), false, 'problems keep their label');
  assert.equal(continuesGroup(first, p({ id: '8', ...ada, kind: 'needs_you', ts: NOON + MIN })), false, 'approval requests keep their label');
  assert.equal(continuesGroup(p({ id: 'e', from: 'system', fromName: 'Podcode', kind: 'event' }), p({ id: '9', from: 'system', fromName: 'Podcode', kind: 'event', ts: NOON + MIN })), false, 'events never group');
  const late = p({ id: 'late', ...ada, ts: new Date(2026, 10, 4, 23, 58).getTime() });
  assert.equal(continuesGroup(late, p({ id: 'next-day', ...ada, ts: new Date(2026, 10, 5, 0, 1).getTime() })), false, 'a new day starts a new header');
});

test('an event is never a thread root, and replies pointing at one stay in the main list', () => {
  const event = p({ id: 'ev', from: 'system', fromName: 'Podcode', kind: 'event' });
  const posts = [
    event,
    p({ id: 'legacy', ...ada, kind: 'reply', inReplyTo: 'ev' }),
    p({ id: 'deeper', ...bo, inReplyTo: 'legacy' }),
    p({ id: 'pointed', ...ada, threadId: 'ev' }),
    p({ id: 'stray', from: 'system', fromName: 'Podcode', kind: 'event', inReplyTo: 'legacy' }),
  ];
  const byId = new Map(posts.map(post => [post.id, post]));
  assert.equal(threadRootId(posts[1], byId), null, 'a chain that reaches an event has no root');
  assert.equal(threadRootId(posts[2], byId), null);
  assert.equal(threadRootId(posts[4], byId), null, 'events are not threaded by inReplyTo');
  const { main, threads } = buildThreads(posts);
  assert.deepEqual(ids(main), ['ev', 'legacy', 'deeper', 'pointed', 'stray'], 'nothing is hidden under an event');
  assert.equal(threads.size, 0);
});

test('every participant gets a mark: live agents by engine, you, and removed agents by their stored name', () => {
  const posts = [
    p({ id: 'r' }),
    p({ id: 'a1', ...ada, threadId: 'r' }),
    p({ id: 'u1', threadId: 'r' }),
    p({ id: 'g1', from: 'agent', agentId: 'gone', fromName: 'Gus', threadId: 'r' }),
  ];
  const thread = buildThreads(posts).threads.get('r')!;
  const marks = participantMarks(thread.participants, [{ id: 'ada', name: 'Ada Renamed', engine: 'claude' }]);
  assert.deepEqual(marks, [
    { key: 'a:ada', name: 'Ada Renamed', kind: 'agent', engine: 'claude' },
    { key: 'user', name: 'You', kind: 'user' },
    { key: 'a:gone', name: 'Gus', kind: 'removed' },
  ]);
});

test('a successful send clears only the text that was sent', () => {
  assert.equal(remainingDraft('ship it', 'ship it'), '', 'nothing typed meanwhile');
  assert.equal(remainingDraft('ship it\nand the docs', 'ship it'), 'and the docs', 'text typed while in flight stays');
  assert.equal(remainingDraft('ship it now', 'ship it'), 'now');
  assert.equal(remainingDraft('ship the tests', 'ship it'), 'ship the tests', 'an edit to the sent text keeps everything');
  assert.equal(remainingDraft('', 'ship it'), '', 'a cleared box stays clear');
});

test('the new-post count rebases when the history is replaced by a shorter window', () => {
  let seen = seenBaseline(0, 310, true);
  assert.equal(seen, 310, 'at the bottom everything is seen');
  seen = seenBaseline(seen, 312, false);
  assert.equal(312 - seen, 2, 'two posts arrived while scrolled up');
  seen = seenBaseline(seen, 300, false);
  assert.equal(seen, 300, 'a reconnect returned a shorter window: rebase');
  seen = seenBaseline(seen, 301, false);
  assert.equal(301 - seen, 1, 'the next post is announced');
  seen = seenBaseline(seen, 301, true);
  assert.equal(seen, 301, 'scrolling back down marks it seen');
});

test('a send that finishes after its composer closed keeps the draft typed in the reopened one', () => {
  const drafts = new Map<string, string>([['c1', 'main list draft']]);
  const key = 'c1:root';
  // Send A from the thread composer, then close the thread while the post is in flight.
  drafts.set(key, 'ship it');
  // Reopen the thread: the new composer starts from the shared draft. Replace it with B.
  drafts.set(key, 'B');
  assert.equal(settleDraft(drafts, key, 'ship it'), 'B', 'A succeeds: B stays');
  assert.equal(drafts.get(key), 'B', 'and stays saved for the next reopen');
  // Or keep A and add to it: only the posted part goes.
  drafts.set(key, 'ship it and the docs');
  assert.equal(settleDraft(drafts, key, 'ship it'), 'and the docs');
  assert.equal(drafts.get(key), 'and the docs');
  // Nothing typed since: the draft is gone.
  drafts.set(key, 'ship it');
  assert.equal(settleDraft(drafts, key, 'ship it'), '');
  assert.equal(drafts.has(key), false);
  assert.equal(drafts.get('c1'), 'main list draft', 'other drafts are untouched');
});
