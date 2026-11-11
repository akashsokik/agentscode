import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { NotesApi } from '../server/notesApi.ts';
import { ProjectRefs } from '../server/projectRefs.ts';
import { RefMentions } from '../server/refMentions.ts';
import { Store } from '../server/store.ts';
import { findRefIds, isCommit, queryWords, refCode, refKind, sourceLine, splitLinks } from '../shared/refs.ts';
import type { Agent, ChannelPost, Entry, PeerMessage, Project } from '../shared/types.ts';
import type { Element, Root } from 'hast';
import { rehypeRefChips } from '../web/ui/rehypeRefChips.ts';
import { rehypeWordFade } from '../web/ui/rehypeWordFade.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

const KNOWN = new Set(['ACH-D7', 'ACH-D12', 'ACH-N1', 'XYZ-D2']);
const known = (id: string) => KNOWN.has(id);
const ids = (text: string) => findRefIds(text, known).map(m => m.id);

// ---- chip parsing -------------------------------------------------------------

test('findRefIds finds known ids in prose, with their positions', () => {
  const text = 'That goes against ACH-D7, which you decided; see ACH-N1.';
  const found = findRefIds(text, known);
  assert.deepEqual(found.map(m => m.id), ['ACH-D7', 'ACH-N1']);
  for (const m of found) assert.equal(text.slice(m.start, m.end), m.id);
  assert.deepEqual(ids('(ACH-D12) and **XYZ-D2**: done'), ['ACH-D12', 'XYZ-D2']);
  assert.deepEqual(ids('ACH-D7'), ['ACH-D7']);
  assert.deepEqual(ids('Recorded ACH-D12 replacing ACH-D7.\nNext line ACH-N1'), ['ACH-D12', 'ACH-D7', 'ACH-N1']);
});

test('findRefIds ignores unknown ids and longer ids that start like a known one', () => {
  assert.deepEqual(ids('ACH-D70 and ACH-D8 and ACH-D7x and ACH-D7-b and ACH-D7_b'), []);
  assert.deepEqual(ids('XACH-D7 and 2ACH-D7'), []);
  assert.deepEqual(ids('ACH-D07 is not ACH-D7'), ['ACH-D7']);
});

test('findRefIds does not match lower case, code, URLs, paths or anchors', () => {
  assert.deepEqual(ids('ach-d7 and Ach-D7'), []);
  assert.deepEqual(ids('run `grep ACH-D7 notes.md` first'), []);
  assert.deepEqual(ids('```\nACH-D7 in a fence\n```\nbut ACH-N1 after it'), ['ACH-N1']);
  assert.deepEqual(ids('see https://github.com/x/y/issues/ACH-D7 and http://h/ACH-N1?q=1'), []);
  assert.deepEqual(ids('www.example.com/ACH-D7'), []);
  assert.deepEqual(ids('[the decision](https://example.com#ACH-D7)'), []);
  assert.deepEqual(ids('on branch feat/ACH-D7 and docs/ACH-N1.md and #ACH-D7 and @ACH-D7'), []);
  assert.deepEqual(ids('the file ACH-D7.md'), []);
  assert.deepEqual(ids('ends with ACH-D7.'), ['ACH-D7']);
});

test('ids, links and source lines', () => {
  assert.equal(refKind('ACH-D7'), 'D');
  assert.equal(refKind('ACH-N1'), 'N');
  assert.equal(refCode('XYZ-D2'), 'XYZ');
  assert.ok(isCommit('b94cdda'));
  assert.ok(!isCommit('deadbeef'.replace(/\d/g, '')), 'all letters is a word, not a hash');
  assert.ok(!isCommit('1234567'), 'all digits is a number, not a hash');
  assert.deepEqual(splitLinks(['b94cdda', 'ach-n1', 'https://x.dev/a', ' ']), { commits: ['b94cdda'], related: ['ACH-N1'], other: ['https://x.dev/a'] });
  assert.deepEqual(queryWords('  Notariz   HANG '), ['notariz', 'hang']);
  assert.equal(sourceLine('first line\nMac builds stalled in notarization for 3 hours', ['notariz']), 'Mac builds stalled in notarization for 3 hours');
  const long = `${'word '.repeat(40)}notarization ${'more '.repeat(40)}`;
  const line = sourceLine(long, ['notariz'], 60)!;
  assert.match(line, /^\.\.\..*notarization.*\.\.\.$/);
  assert.ok(line.length <= 70);
  assert.equal(sourceLine('nothing here', ['notariz']), null);
});

// ---- fixtures --------------------------------------------------------------------

const DECISIONS = `# Decisions (ACH)

## ACH-D11  Every merge to main ships a release
- decided by: SuperAgent
- date: 2026-11-09
- why: Fast feedback.
- status: replaced by ACH-D12
- links:

Every merge to main ships.

## ACH-D12  Release from a tag; publish only with a separate yes
- decided by: You
- date: 2026-11-10
- why: Mac builds stalled in notarization for 3 hours.
- status: active
- links: b94cdda, ACH-N1, https://example.com/release

Tag first, publish with a separate yes.

## ACH-D7  No shadows anywhere
- decided by: You
- date: 2026-11-09
- why: The composer's soft shadow.
- status: active
- links:

Surfaces stay flat.
`;

const NOTES = `# Notes (ACH)

## ACH-N1  Mac notarization can hang past 3 hours
- author: Ada
- date: 2026-11-10
- added by: Ada
- links:

notarytool submit --wait has no timeout.
Poll with info instead.
`;

function writeRefs(root: string): void {
  fs.mkdirSync(path.join(root, 'ACH'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ACH', 'decisions.md'), DECISIONS);
  fs.writeFileSync(path.join(root, 'ACH', 'notes.md'), NOTES);
  fs.mkdirSync(path.join(root, 'XYZ'), { recursive: true });
  fs.writeFileSync(path.join(root, 'XYZ', 'decisions.md'), '# Decisions (XYZ)\n\n## XYZ-D2  Use the notarize script too\n- decided by: Fen\n- date: 2026-11-08\n- why:\n- status: active\n- links:\n\nSame as ACH.\n');
}

function agent(id: string, name: string): Agent {
  return { id, name } as Agent;
}

function setup() {
  const dir = tempDir('notes');
  const store = new Store(path.join(dir, 'data'));
  store.load();
  store.agents.set('a-super', agent('a-super', 'SuperAgent'));
  store.agents.set('a-fen', agent('a-fen', 'Fen'));
  store.agents.set('a-rhea', agent('a-rhea', 'Rhea'));
  const refsRoot = path.join(store.dataDir, 'projects');
  writeRefs(refsRoot);
  const refs = new ProjectRefs(refsRoot);
  const mentions = new RefMentions(store);
  const projects: Project[] = [{ id: 'p1', name: 'agent-comms-harness', path: '/x/agent-comms-harness', code: 'ACH' } as Project];
  const api = new NotesApi({ refs, mentions, projects: () => projects });
  return { store, refs, mentions, api };
}

function entry(agentId: string, id: string, kind: Entry['kind'], text: string, extra: Partial<Entry> = {}): Entry {
  return { id, agentId, ts: 1000, kind, text, ...extra };
}

function message(id: string, from: string, fromName: string, to: string, toName: string, text: string, extra: Partial<PeerMessage> = {}): PeerMessage {
  return { id, conversationId: `c-${id}`, fromAgentId: from, fromName, toAgentId: to, toName, text, expectsReply: true, ts: 2000, status: 'delivered', ...extra };
}

// ---- mention indexing ---------------------------------------------------------

test('mentions count chats, messages, handoffs and channel posts, and not tool output', () => {
  const { store, mentions } = setup();
  store.appendEntry(entry('a-super', 'e1', 'agent', 'That would go against ACH-D7.'));
  store.appendEntry(entry('a-super', 'e2', 'user', 'Can we bring back ACH-D7 shadows?'));
  store.appendEntry(entry('a-super', 'e3', 'tool', 'ref_get ACH-D7 ACH-D12', { tool: { name: 'ref_get' } as Entry['tool'] }));
  store.messages.push(message('m1', 'a-fen', 'Fen', 'a-rhea', 'Rhea', 'The border is a stroke now, per ACH-D7.'));
  store.messages.push(message('m2', 'a-super', 'SuperAgent', 'a-fen', 'Fen', 'Handing off', {
    delegation: { kind: 'implementation', task: 'Re-run the Mac build, see ACH-N1', acceptanceCriteria: 'Green', context: '' } as PeerMessage['delegation'],
  }));
  store.channels.set('ch1', { id: 'ch1', name: 'release' } as never);
  store.posts.set('ch1', [
    { id: 'p1', channelId: 'ch1', ts: 3000, from: 'agent', agentId: 'a-fen', fromName: 'Fen', kind: 'post', text: 'Recorded ACH-D12 replacing ACH-D11.', to: [] } as ChannelPost,
    { id: 'p2', channelId: 'ch1', ts: 3001, from: 'system', fromName: 'PodCode', kind: 'event', text: 'ACH-D7 event', to: [] } as ChannelPost,
  ]);
  const counts = mentions.counts();
  assert.equal(counts.get('ACH-D7'), 3, 'two chat entries and one message; the tool call does not count');
  assert.equal(counts.get('ACH-N1'), 1, 'the handoff task counts');
  assert.equal(counts.get('ACH-D12'), 1);
  assert.equal(counts.get('ACH-D11'), 1);
  const { citations, count } = mentions.citations('ACH-D7');
  assert.equal(count, 3);
  assert.deepEqual(citations.map(c => `${c.who} ${c.where}`).sort(), ['Fen to Rhea', 'SuperAgent in your chat', 'You to SuperAgent']);
  const handoff = mentions.citations('ACH-N1').citations[0];
  assert.equal(handoff.where, 'to Fen, handoff');
  assert.deepEqual(handoff.open, { kind: 'comms', conversationId: 'c-m2' });
  assert.deepEqual(mentions.citations('ACH-D12').citations[0].open, { kind: 'channel', channelId: 'ch1' });
});

test('a rewritten entry replaces what it cited, and new lines are read incrementally', () => {
  const { store, mentions } = setup();
  store.appendEntry(entry('a-fen', 'e1', 'agent', 'Working on ACH-D7'));
  assert.equal(mentions.counts().get('ACH-D7'), 1);
  // Streaming rewrites the same entry: the id it cited is gone, another one is there.
  store.appendEntry(entry('a-fen', 'e1', 'agent', 'Actually this is ACH-N1'));
  let counts = mentions.counts();
  assert.equal(counts.get('ACH-D7'), undefined);
  assert.equal(counts.get('ACH-N1'), 1);
  // A line that only updates meta keeps what the entry cites.
  fs.appendFileSync(path.join(store.dataDir, 'transcripts', 'a-fen.jsonl'), `${JSON.stringify({ id: 'e1', agentId: 'a-fen', meta: { durationMs: 5 } })}\n`);
  assert.equal(mentions.counts().get('ACH-N1'), 1);
  store.appendEntry(entry('a-fen', 'e2', 'agent', 'And ACH-D7 again'));
  counts = mentions.counts();
  assert.equal(counts.get('ACH-D7'), 1);
  assert.equal(counts.get('ACH-N1'), 1);
  // Rewritten to cite nothing at all: it no longer counts.
  store.appendEntry(entry('a-fen', 'e1', 'agent', 'Never mind'));
  assert.equal(mentions.counts().get('ACH-N1'), undefined);
});

test('a citation is counted once: channel prompts, peer copies and channel replies', () => {
  const { store, mentions } = setup();
  // The user posts in a channel; the agent's chat gets the same prompt marked with the channel.
  store.channels.set('ch1', { id: 'ch1', name: 'test' } as never);
  store.posts.set('ch1', [
    { id: 'p1', channelId: 'ch1', ts: 1, from: 'user', fromName: 'You', kind: 'post', text: 'Is ACH-D7 still right?', to: [] } as ChannelPost,
    { id: 'p2', channelId: 'ch1', ts: 2, from: 'agent', agentId: 'a-fen', fromName: 'Fen', kind: 'reply', inReplyTo: 'p1', threadId: 'p1', text: 'Yes, ACH-D7 holds.', to: [] } as ChannelPost,
  ]);
  store.appendEntry(entry('a-fen', 'u1', 'user', 'Is ACH-D7 still right?', { channel: { id: 'ch1', postId: 'p1' } }));
  // Its reply is in its chat and posted to the thread.
  store.appendEntry(entry('a-fen', 'r1', 'agent', 'Yes, ACH-D7 holds.'));
  // A message both parties' chats copy, and one older than state.json keeps.
  const live = message('m1', 'a-fen', 'Fen', 'a-rhea', 'Rhea', 'Review per ACH-N1');
  store.messages.push(live);
  const old = message('m0', 'a-rhea', 'Rhea', 'a-fen', 'Fen', 'Old note on ACH-N1');
  for (const who of ['a-fen', 'a-rhea']) {
    store.appendEntry(entry(who, `peer:${live.id}`, 'peer', live.text, { peer: live }));
    store.appendEntry(entry(who, `peer:${old.id}`, 'peer', old.text, { peer: old }));
  }
  const counts = mentions.counts();
  assert.equal(counts.get('ACH-D7'), 2, 'the user post and the reply, once each');
  assert.equal(counts.get('ACH-N1'), 2, 'the live message and the old one, once each');
});

test('a transcript that was rewritten smaller is read again from the start', () => {
  const { store, mentions } = setup();
  store.appendEntry(entry('a-fen', 'e1', 'agent', 'ACH-D7 and a lot more text to make the file longer than the next one'));
  assert.equal(mentions.counts().get('ACH-D7'), 1);
  fs.writeFileSync(path.join(store.dataDir, 'transcripts', 'a-fen.jsonl'), `${JSON.stringify(entry('a-fen', 'e9', 'agent', 'ACH-N1'))}\n`);
  const counts = mentions.counts();
  assert.equal(counts.get('ACH-D7'), undefined);
  assert.equal(counts.get('ACH-N1'), 1);
  store.deleteTranscript('a-fen');
  assert.equal(mentions.counts().size, 0);
});

// ---- read API ----------------------------------------------------------------------

test('the index lists projects and entries with state, replaces and mention counts', () => {
  const { store, api } = setup();
  store.appendEntry(entry('a-super', 'e1', 'agent', 'Per ACH-D7 and ACH-D7 again'));
  const index = api.index();
  const ach = index.projects.find(p => p.code === 'ACH')!;
  assert.deepEqual(ach, { code: 'ACH', name: 'agent-comms-harness', projectId: 'p1', decisions: 2, notes: 1, replaced: 1 });
  assert.equal(index.projects.find(p => p.code === 'XYZ')?.name, 'XYZ', 'a folder with no project reads by its code');
  assert.ok(index.projects.some(p => p.code === 'ALL' && p.name === 'All projects'));
  const byId = new Map(index.entries.map(e => [e.id, e]));
  assert.equal(byId.get('ACH-D11')?.state, 'replaced');
  assert.equal(byId.get('ACH-D11')?.replacedBy, 'ACH-D12');
  assert.equal(byId.get('ACH-D12')?.replaces, 'ACH-D11');
  assert.equal(byId.get('ACH-D12')?.state, 'active');
  assert.equal(byId.get('ACH-N1')?.state, 'note');
  assert.equal(byId.get('ACH-D7')?.mentions, 1, 'one entry citing it twice is one place');
  assert.equal(byId.get('ACH-D7')?.gist, 'Surfaces stay flat.');
  // Within a project: decisions newest first, then notes.
  assert.deepEqual(index.entries.filter(e => e.code === 'ACH').map(e => e.id), ['ACH-D12', 'ACH-D11', 'ACH-D7', 'ACH-N1']);
});

test('get returns the whole entry with its links split and its citations', () => {
  const { store, api } = setup();
  store.messages.push(message('m1', 'a-fen', 'Fen', 'a-rhea', 'Rhea', 'Done per ACH-D12.'));
  const detail = api.get('ach-d12');
  assert.equal(detail.id, 'ACH-D12');
  assert.equal(detail.body, 'Tag first, publish with a separate yes.');
  assert.equal(detail.why, 'Mac builds stalled in notarization for 3 hours.');
  assert.deepEqual(detail.commits, ['b94cdda']);
  assert.deepEqual(detail.related, ['ACH-N1']);
  assert.deepEqual(detail.otherLinks, ['https://example.com/release']);
  assert.equal(detail.replaces, 'ACH-D11');
  assert.equal(detail.mentions, 1);
  assert.equal(detail.citations[0].who, 'Fen');
  assert.equal(detail.addedBy, undefined, 'a hand-written entry has no added-by');
  assert.equal(api.get('ACH-N1').addedBy, 'Ada', 'added-by, recorded by PodCode, comes through');
  assert.throws(() => api.get('ACH-D99'), /no note or decision ACH-D99/);
  assert.throws(() => api.get('nonsense'), /Give an id/);
});

test('search matches titles and text, gives the source line, and searches every project', () => {
  const { api } = setup();
  const inAch = api.search('notariz', 'ACH');
  assert.deepEqual(inAch.map(h => [h.entry.id, h.field]), [['ACH-N1', 'title'], ['ACH-D12', 'why']]);
  assert.equal(inAch[1].line, 'Mac builds stalled in notarization for 3 hours.');
  const body = api.search('poll info', 'ACH');
  assert.deepEqual(body.map(h => [h.entry.id, h.field, h.line]), [['ACH-N1', 'body', 'Poll with info instead.']]);
  assert.deepEqual(api.search('gradient', 'ACH'), []);
  assert.deepEqual(api.search('notarize script', 'ACH'), [], 'XYZ is another project');
  assert.deepEqual(api.search('notarize script').map(h => h.entry.id), ['XYZ-D2']);
  assert.deepEqual(api.search('   '), []);
  assert.throws(() => api.search('x', 'not a code'), /Not a project code/);
});

test('the HTTP routes read the notes and never change them', async () => {
  const h = harness();
  const root = path.join(h.store.dataDir, 'projects');
  writeRefs(root);
  const before = fs.readFileSync(path.join(root, 'ACH', 'decisions.md'), 'utf8');
  const server = createApp(h.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = (p: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`;
  try {
    const index = await (await fetch(url('/api/refs'))).json() as { entries: { id: string }[] };
    assert.ok(index.entries.some(e => e.id === 'ACH-D7'));
    const one = await (await fetch(url('/api/refs/ACH-N1'))).json() as { title: string };
    assert.equal(one.title, 'Mac notarization can hang past 3 hours');
    assert.equal((await fetch(url('/api/refs/ACH-N9'))).status, 404);
    const search = await (await fetch(url('/api/refs/search?q=shadows&code=ACH'))).json() as { hits: { entry: { id: string } }[] };
    assert.deepEqual(search.hits.map(hit => hit.entry.id), ['ACH-D7']);
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      const res = await fetch(url('/api/refs/ACH-D7'), { method, headers: { 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
      assert.equal(res.status, 404, `${method} has no route`);
    }
    assert.equal(fs.readFileSync(path.join(root, 'ACH', 'decisions.md'), 'utf8'), before);
  } finally {
    server.close();
  }
});

// ---- chips in rendered Markdown ------------------------------------------------------

const el = (tagName: string, children: Element['children'], properties: Element['properties'] = {}): Element => ({ type: 'element', tagName, properties, children });
const txt = (value: string) => ({ type: 'text' as const, value });

test('rehypeRefChips turns known ids in prose into chips, never in code or links', () => {
  const p = el('p', [txt('Per ACH-D7 and ACH-D70, see '), el('code', [txt('ACH-D7')]), txt(' or '), el('a', [txt('ACH-N1')], { href: 'https://x/ACH-N1' }), el('strong', [txt('ACH-N1')])]);
  const pre = el('pre', [el('code', [txt('ACH-D7')])]);
  const tree: Root = { type: 'root', children: [p, pre] };
  rehypeRefChips({ known })(tree);
  const chips: string[] = [];
  const walk = (node: Root | Element) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (typeof child.properties.dataRef === 'string') chips.push(child.properties.dataRef);
      walk(child);
    }
  };
  walk(tree);
  assert.deepEqual(chips, ['ACH-D7', 'ACH-N1'], 'the one in prose and the one in bold; not in code, a link or a fence');
  assert.deepEqual(p.children.slice(0, 3).map(c => (c.type === 'text' ? c.value : (c as Element).properties.dataRef)), ['Per ', 'ACH-D7', ' and ACH-D70, see ']);
  assert.deepEqual((pre.children[0] as Element).children, [txt('ACH-D7')]);
});

test('word fading keeps a chip whole, as one word', () => {
  const tree: Root = { type: 'root', children: [el('p', [txt('See ACH-D7 now')])] };
  rehypeRefChips({ known })(tree);
  rehypeWordFade()(tree);
  const p = tree.children[0] as Element;
  const chip = p.children.find((c): c is Element => c.type === 'element' && c.properties.dataRef === 'ACH-D7')!;
  assert.ok('dataWordFade' in chip.properties, 'the chip fades in as one unit');
  assert.deepEqual(chip.children, [txt('ACH-D7')], 'its text is not split into word spans');
});

test('every way a note is added tells the app to read the notes again: note_add, decision_add and a lesson', async () => {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'acme-core-web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const lead = h.runner(sup.id);
  const refsEvents = () => h.events.filter(e => e.type === 'refs').length;
  const request = await h.manager.commsTool(lead.ctx.commsToken!, 'delegate_task', { to_agent_id: ada.id, kind: 'implementation', task: 'Do it.', acceptance_criteria: 'Done.' }) as PeerMessage;
  await settle();
  const worker = h.runners.get(ada.id)!.at(-1)!;
  const as = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(worker.ctx.commsToken!, tool, args);
  const start = refsEvents();
  await as('note_add', { project: 'ALL', title: 'A note', body: 'Text.' });
  assert.equal(refsEvents(), start + 1);
  await as('decision_add', { project: 'ALL', title: 'A decision', decision: 'Do it.', why: 'Because.', decided_by: 'You' });
  assert.equal(refsEvents(), start + 2);
  await as('report_result', { message_id: request.id, outcome: 'done', summary: 'Built it.', evidence: 'ok', lesson: 'Lessons refresh the Notes tab too.' });
  assert.equal(refsEvents(), start + 3, 'a lesson saved with a report');
  assert.ok(h.manager.notes.index().entries.some(e => e.title.startsWith('Lesson: Lessons refresh')));
});
