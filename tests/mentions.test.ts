import assert from 'node:assert/strict';
import test from 'node:test';
import { findMentions, inCode, joinPath, mentionContext, mentionStart } from '../shared/mentions.ts';
import { mentionTokenAt, pickGroup, pickValue, rankMentions, withFolders } from '../web/composer/tokens.ts';
import { resolveMentions } from '../web/mentions.ts';
import { harness, projectDir } from './helpers.ts';

const agents = [
  { id: 'a1', name: 'Ada', role: 'dev', projectId: 'p1' },
  { id: 'a2', name: 'Ada Lovelace', role: 'reviewer', projectId: null },
  { id: 'a3', name: 'Rhea', role: 'reviewer', projectId: 'p1' },
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

test('channel delivery is unchanged: members by name, @all for everyone', () => {
  const members = [{ id: 'a1', name: 'Ada' }, { id: 'a3', name: 'Rhea' }] as never;
  assert.deepEqual(resolveMentions('@Ada take it', members), ['a1']);
  assert.deepEqual(resolveMentions('@all go', members), ['a1', 'a3']);
  assert.deepEqual(resolveMentions('mail ada@x.com', members), []);
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
