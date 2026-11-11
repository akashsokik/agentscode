import assert from 'node:assert/strict';
import test from 'node:test';
import { alignHints, channelRecipients, findMentions, inCode, joinPath, mentionContext, mentionStart, parseHints } from '../shared/mentions.ts';
import { mentionTokenAt, pickGroup, pickValue, rankMentions, withFolders } from '../web/composer/tokens.ts';
import { hintFor } from '../web/composer/mentionHints.ts';
import { harness, projectDir } from './helpers.ts';

const agents = [
  { id: 'a1', name: 'Ada', role: 'dev', projectIds: ['p1'] },
  { id: 'a2', name: 'Ada Lovelace', role: 'reviewer', projectIds: null },
  { id: 'a3', name: 'Rhea', role: 'reviewer', projectIds: ['p1'] },
];
const projects = [
  { id: 'p1', name: 'web', path: '/work/web' },
  { id: 'p2', name: 'orca site', path: '/work/orca-site' },
];

test('an @ starts a mention only outside words, emails, paths and code', () => {
  assert.equal(mentionStart('@Ada hi', 0), true);
  assert.equal(mentionStart('ask @Ada', 4), true);
  assert.equal(mentionStart('me@example.com', 2), false, 'an email is not a mention');
  assert.equal(mentionStart('see `@Ada` here', 5), false, 'inline code');
  assert.equal(inCode('```\n@Ada\n```', 4), true, 'a fenced block');
  assert.equal(inCode('```\nx\n``` @Ada', 10), false, 'after the fence closes');
  assert.equal(mentionTokenAt('mail me@ex', 10), null, 'no picker inside an email');
  assert.equal(mentionTokenAt('code `@Ad', 9), null, 'no picker inside code');
  assert.deepEqual(mentionTokenAt('ask @Ad', 7), { start: 4, end: 7, query: 'Ad' });
});

test('mentions resolve agents, projects and files: longest name first, a path beats a short name', () => {
  const refs = findMentions('@Ada Lovelace and @ada, see @orca site, @web/app.ts and @README.md. Ping @all', { agents, projects });
  assert.deepEqual(refs.map(r => [r.kind, r.name]), [
    ['agent', 'Ada Lovelace'], ['agent', 'Ada'], ['project', 'orca site'], ['file', 'web/app.ts'], ['file', 'README.md'], ['everyone', 'all'],
  ]);
  assert.equal(refs[0].start, 0);
  assert.equal(refs[0].end, '@Ada Lovelace'.length);
  assert.deepEqual(findMentions('@Adam is new', { agents, projects }), [], 'not inside a longer word');
  assert.deepEqual(findMentions('`@Ada` and ```\n@Rhea\n```', { agents, projects }), [], 'nothing in code');
  // In a channel a file is project/path, and only a known project's.
  const channel = findMentions('@web/src/a.ts and @nope/b.ts', { agents, projects, channel: true });
  assert.deepEqual(channel, [{ kind: 'file', start: 0, end: 13, name: 'web/src/a.ts', path: 'src/a.ts', projectId: 'p1' }]);
});

test('the receiving agent is told who and what was mentioned, with ids and paths', () => {
  const refs = findMentions('@Rhea review it in @web, then @Rhea again', { agents, projects });
  const context = mentionContext(refs, { agents, projects, roleName: role => role.toUpperCase() });
  assert.match(context, /does not message it/);
  assert.match(context, /- @Rhea: the agent Rhea \(agent id a3, REVIEWER, project web at \/work\/web\)\./);
  assert.match(context, /- @web: the project web at \/work\/web\./);
  assert.equal(context.match(/@Rhea:/g)?.length, 1, 'each named once');
  assert.match(mentionContext(findMentions('@Ada Lovelace', { agents, projects }), { agents, projects }), /all projects/);
  const file = mentionContext(findMentions('@web/src/a.ts', { agents, projects, channel: true }), { agents, projects, channel: true });
  assert.match(file, /the file or folder \/work\/web\/src\/a\.ts/);
  assert.doesNotMatch(file, /does not message it/, 'in a channel a member mention does start them');
  assert.equal(mentionContext(findMentions('@app.ts only', { agents, projects }), { agents, projects }), '', 'a workspace file needs no note');
  assert.equal(mentionContext(findMentions('@Gone', { agents, projects }), { agents, projects }), '');
});

test('one picker ranks agents, projects and files in groups, an exact name first', () => {
  const files = withFolders(['src/ada.ts', 'web/app.ts']);
  const picks = rankMentions({ agents, projects, files, query: 'ada', everyone: true });
  assert.deepEqual(picks.slice(0, 3).map(p => [pickGroup(p), pickValue(p)]), [['Best match', 'Ada'], ['Agents', 'Ada Lovelace'], ['Files', 'src/ada.ts']]);
  const all = rankMentions({ agents, projects, files, query: '', everyone: true });
  assert.deepEqual([...new Set(all.map(pickGroup))], ['Agents', 'Projects', 'Files'], 'groups in order, no query');
  assert.ok(all.some(p => p.kind === 'everyone'));
  assert.equal(rankMentions({ agents, projects, files, query: 'zzz' }).length, 0);
  assert.equal(pickValue(rankMentions({ agents: [], projects: [], files, query: 'src' })[0]), 'src/', 'a folder ends with a slash');
});

test('channel delivery: members by name, @all for everyone, from the same parse as the chips', () => {
  const members = ['a1', 'a3'];
  const recipients = (text: string) => channelRecipients(text, members, { agents, projects });
  assert.deepEqual(recipients('@Ada take it'), ['a1']);
  assert.deepEqual(recipients('@all go'), ['a1', 'a3']);
  assert.deepEqual(recipients('mail ada@x.com'), []);
  assert.deepEqual(recipients('@Rhea then @Ada, and @Rhea again'), ['a3', 'a1'], 'in order, once each');
  assert.deepEqual(recipients('@Ada Lovelace, look'), [], 'the longest name wins, and Ada Lovelace is not a member');
});

test('a member named only in code starts nobody, and the chips agree', () => {
  const members = ['a1', 'a3'];
  const recipients = (text: string) => channelRecipients(text, members, { agents, projects });
  for (const text of ['run `@Ada` later', 'see:\n```\n@Ada do it\n```\nthanks', '`@all` is the keyword']) {
    assert.deepEqual(recipients(text), [], text);
    assert.deepEqual(findMentions(text, { agents, projects, channel: true }), [], `no chip either: ${text}`);
  }
  // Named in code and outside it: started once, and one chip, the one outside.
  const text = '`@Ada` means @Ada';
  assert.deepEqual(recipients(text), ['a1']);
  assert.deepEqual(findMentions(text, { agents, projects, channel: true }).map(m => m.start), [text.lastIndexOf('@')]);
});

test('names with spaces: the picker stays open while one is typed, and closes once a name is done', () => {
  const names = [...agents, ...projects].map(n => n.name);
  const at = (text: string, cursor = text.length) => mentionTokenAt(text, cursor, names);
  assert.deepEqual(at('ask @Ada Lo'), { start: 4, end: 11, query: 'Ada Lo' });
  assert.deepEqual(at('in @orca s'), { start: 3, end: 10, query: 'orca s' });
  assert.deepEqual(at('in @orca '), { start: 3, end: 9, query: 'orca ' }, 'orca is only the start of a name');
  assert.equal(at('ask @Ada '), null, 'Ada is a whole name: done');
  assert.equal(at('ask @Ada please'), null, 'no name goes on like that');
  assert.equal(at('`@Ada Lo'), null, 'not in code');
  assert.deepEqual(at('ask @Ada Lo there', 11), { start: 4, end: 11, query: 'Ada Lo' }, 'caret in the middle');
  assert.deepEqual(at('ask @Ad'), { start: 4, end: 7, query: 'Ad' }, 'one word, as before');
  assert.equal(mentionTokenAt('ask @Ada Lo', 11), null, 'without names, a space ends the token as before');
  // What the picker offers for a spaced query, and the pick writes the whole name.
  const best = rankMentions({ agents, projects, files: [], query: 'Ada Lovelace' })[0];
  assert.equal(best.best && pickValue(best), 'Ada Lovelace');
  assert.equal(pickValue(rankMentions({ agents, projects, files: [], query: 'orca s' })[0]), 'orca site');
});

test('an agent and a project with the same name: each pick keeps its kind, in the chips, the note and channel delivery', () => {
  const both = { agents: [...agents, { id: 'a9', name: 'orca', role: 'dev', projectIds: null }], projects: [...projects, { id: 'p9', name: 'orca', path: '/work/orca' }] };
  const text = 'ask @orca about @orca';
  // Picked: the agent first, then the project.
  const picked = [hintFor({ kind: 'agent', agent: { id: 'a9', name: 'orca' }, positions: [] }, 4)!, hintFor({ kind: 'project', project: { id: 'p9', name: 'orca', path: '/work/orca' }, positions: [] }, 16)!];
  const refs = findMentions(text, { ...both, hints: picked });
  assert.deepEqual(refs.map(r => [r.kind, 'id' in r ? r.id : '']), [['agent', 'a9'], ['project', 'p9']]);
  const note = mentionContext(refs, both);
  assert.match(note, /the agent orca \(agent id a9/);
  assert.match(note, /the project orca at \/work\/orca\./);
  // Unpicked (typed by hand), the agent wins as before.
  assert.deepEqual(findMentions(text, both).map(r => r.kind), ['agent', 'agent']);
  // In a channel, a picked project does not start the member who shares its name.
  assert.deepEqual(channelRecipients('@orca has the bug', ['a9'], { ...both, hints: [{ kind: 'project', id: 'p9', name: 'orca', start: 0 }] }), []);
  assert.deepEqual(channelRecipients('@orca has the bug', ['a9'], both), ['a9']);
  // A hint for a name with no clash changes nothing, and a hint naming something else is ignored.
  assert.deepEqual(findMentions('@Rhea', { ...both, hints: [{ kind: 'project', id: 'p1', name: 'Rhea', start: 0 }] }).map(r => r.kind), ['agent']);
});

test('picks follow their @ as the text changes, and the server takes only well-formed ones', () => {
  const hint = { kind: 'project' as const, id: 'p9', name: 'orca', start: 4 };
  assert.deepEqual(alignHints('so, ask @orca', [hint]).map(h => h.start), [8], 'typing before it moves it');
  assert.deepEqual(alignHints('nothing here', [hint]), [], 'its @ was deleted');
  assert.deepEqual(alignHints('`@orca` and @orca', [hint]).map(h => h.start), [12], 'never onto an @ in code');
  const two = alignHints('@orca @orca', [{ ...hint, start: 0 }, { ...hint, kind: 'agent', id: 'a9', start: 6 }]);
  assert.deepEqual(two.map(h => [h.kind, h.start]), [['project', 0], ['agent', 6]], 'one pick per @');
  assert.deepEqual(parseHints([hint, { kind: 'file', id: 'x', name: 'x', start: 0 }, { kind: 'agent', id: 'a', name: 'a', start: -1 }, null, 'x']), [hint]);
  assert.deepEqual(parseHints('nope'), []);
});

test('a message to an agent stores its mentions and tells the agent who and what they are', async () => {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const rhea = await h.manager.create({ name: 'Rhea', engine: 'claude', projectId: web.id, role: 'reviewer' });
  h.manager.send(ada.id, 'Ask @Rhea to review @web/app.ts in @web');
  const sent = h.runner(ada.id).sent[0].text;
  assert.match(sent, /^Ask @Rhea to review @web\/app\.ts in @web/);
  assert.match(sent, new RegExp(`- @Rhea: the agent Rhea \\(agent id ${rhea.id}, Reviewer, project web at `));
  assert.match(sent, /- @web: the project web at /);
  const entry = h.manager.entries(ada.id).find(e => e.kind === 'user')!;
  assert.equal(entry.text, 'Ask @Rhea to review @web/app.ts in @web', 'the transcript shows what you typed');
  assert.deepEqual(entry.mentions?.map(m => m.kind), ['agent', 'file', 'project']);
  assert.ok(!h.manager.entries(rhea.id).some(e => e.kind === 'user' || e.kind === 'peer'), 'a mention in a prompt box messages nobody');
});

test('a channel post resolves project/path files to absolute paths for the members it starts', async () => {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const channel = h.manager.createChannel({ name: 'ship', memberIds: [ada.id] });
  const post = h.manager.postToChannel(channel.id, '@Ada check @web/src/a.ts', [ada.id]);
  assert.deepEqual(post.mentions?.map(m => m.kind), ['agent', 'file']);
  const sent = h.runner(ada.id).sent[0].text;
  assert.match(sent, new RegExp(`the file or folder ${web.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/src/a\\.ts`));
  assert.deepEqual(h.manager.entries(ada.id).find(e => e.kind === 'user')?.mentions?.map(m => m.kind), ['agent', 'file']);
});

test('a channel file path stays inside its project', () => {
  assert.equal(joinPath('/work/web/', 'src/./a.ts'), '/work/web/src/a.ts');
  assert.equal(joinPath('/work/web', 'src/../lib/b.ts'), '/work/web/lib/b.ts');
  assert.equal(joinPath('/work/web', '../../etc/passwd'), null);
  assert.equal(mentionContext(findMentions('@web/../../x', { agents, projects, channel: true }), { agents, projects, channel: true }), '', 'a path leaving the project is not passed on');
});

test('the server keeps an agent and a project with the same name apart by the pick, in a message and a channel post', async () => {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const webAgent = await h.manager.create({ name: 'web', engine: 'claude', projectId: web.id });
  // Typed, then sent with leading spaces: the server realigns the pick to its @.
  h.manager.send(ada.id, '  look at @web with @web', undefined, [{ kind: 'project', id: web.id, name: 'web', start: 21 }, { kind: 'agent', id: webAgent.id, name: 'web', start: 10 }, { kind: 'nonsense' }]);
  const entry = h.manager.entries(ada.id).find(e => e.kind === 'user')!;
  assert.deepEqual(entry.mentions?.map(m => [m.kind, 'id' in m ? m.id : '']), [['agent', webAgent.id], ['project', web.id]]);
  const sent = h.runner(ada.id).sent[0].text;
  assert.match(sent, new RegExp(`- @web: the agent web \\(agent id ${webAgent.id}`));
  assert.match(sent, /- @web: the project web at /);

  const channel = h.manager.createChannel({ name: 'release', memberIds: [ada.id, webAgent.id] });
  const post = h.manager.postToChannel(channel.id, '@Ada check @web', [ada.id], undefined, undefined, [{ kind: 'project', id: web.id, name: 'web', start: 11 }]);
  assert.deepEqual(post.mentions?.map(m => m.kind), ['agent', 'project'], 'the chip is the project the user picked');
  assert.deepEqual(post.to.map(d => d.agentId), [ada.id]);
});
