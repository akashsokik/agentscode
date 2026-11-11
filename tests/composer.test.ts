import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { injectSkillPrompt, skillNamesInText, type ComposerCommand } from '../shared/composer.ts';
import {
  BUILTIN_COMMANDS,
  builtinCommand,
  isLeading,
  mentionTokenAt,
  mentionValue,
  rankCommands,
  rankFiles,
  replaceToken,
  slashTokenAt,
  withFolders,
} from '../web/composer/tokens.ts';
import { harness, projectDir, settle } from './helpers.ts';

function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the ${name} thing.\n`;

// ---- tokens --------------------------------------------------------------------

test('a slash token is a command being typed, not a path', () => {
  assert.deepEqual(slashTokenAt('/cle', 4), { start: 0, end: 4, query: 'cle' });
  assert.deepEqual(slashTokenAt('please /vercel:dep now', 15), { start: 7, end: 18, query: 'vercel:' }, 'the query runs to the caret');
  assert.equal(slashTokenAt('/Users/me/app', 13), null, 'a path is not a command');
  assert.equal(slashTokenAt('hello', 5), null);
  assert.equal(slashTokenAt('/clear ', 7), null, 'past the space the token is done');
  assert.ok(isLeading('  /review', slashTokenAt('  /review', 9)!), 'leading spaces still lead');
  assert.ok(!isLeading('do /review', slashTokenAt('do /review', 10)!));
});

test('a mention token is a file being named', () => {
  assert.deepEqual(mentionTokenAt('look at @web/Tr', 15), { start: 8, end: 15, query: 'web/Tr' });
  assert.equal(mentionTokenAt('mail me@example.com', 19), null, 'an address is not a mention');
  assert.deepEqual(mentionTokenAt('@', 1), { start: 0, end: 1, query: '' });
});

test('a pick replaces the token and leaves the caret after a space', () => {
  const text = 'see @Tra please';
  const token = mentionTokenAt(text, 8)!;
  assert.deepEqual(replaceToken(text, token, '@', 'web/panes/Transcript.tsx'), { text: 'see @web/panes/Transcript.tsx please', caret: 30 });
  const slash = slashTokenAt('/rev', 4)!;
  assert.deepEqual(replaceToken('/rev', slash, '/', 'review'), { text: '/review ', caret: 8 });
});

test('/clear runs alone, and /new and /reset are other names for it', () => {
  assert.equal(builtinCommand('/clear')?.name, 'clear');
  assert.equal(builtinCommand('  /New ')?.name, 'clear');
  assert.equal(builtinCommand('/reset')?.name, 'clear');
  assert.equal(builtinCommand('/clear the cache'), undefined, 'with more after it, it is a message');
  assert.equal(builtinCommand('/review'), undefined);
});

test('the command picker puts Podcode first and lands exact names on top', () => {
  const commands: ComposerCommand[] = [
    ...BUILTIN_COMMANDS,
    { name: 'review', description: 'Review a change', scope: 'user', source: 'claude' },
    { name: 'vercel:deploy', description: 'Deploy to Vercel', scope: 'plugin', source: 'vercel' },
    { name: 'ship-feature', description: 'Ship it', scope: 'project', source: 'claude' },
  ];
  assert.deepEqual(rankCommands(commands, '').map(c => c.name), ['clear', 'ship-feature', 'review', 'vercel:deploy']);
  assert.equal(rankCommands(commands, 'new')[0].name, 'clear', 'an alias finds its command');
  assert.equal(rankCommands(commands, 'dep')[0].name, 'vercel:deploy');
  assert.deepEqual(rankCommands(commands, 'zzz'), []);
});

test('the file picker offers folders too, shallow first, and fuzzy once typed', () => {
  const entries = withFolders(['web/panes/Transcript.tsx', 'web/App.tsx', 'README.md']);
  assert.deepEqual(rankFiles(entries, '').map(f => f.relative), ['web', 'README.md', 'web/panes', 'web/App.tsx', 'web/panes/Transcript.tsx']);
  const hit = rankFiles(entries, 'trans')[0];
  assert.equal(hit.relative, 'web/panes/Transcript.tsx');
  assert.deepEqual(hit.positions, [10, 11, 12, 13, 14], 'the match is in the name');
  assert.equal(mentionValue(rankFiles(entries, 'panes')[0]), 'web/panes/', 'a folder is written with its slash');
});

// ---- skills ----------------------------------------------------------------------

test('skills named in a message travel with it to an engine that cannot run them', () => {
  assert.deepEqual(skillNamesInText('/review this then /ship-it, and /Users/me is a path'), ['review'], 'a path, or a name run into punctuation, is not a skill');
  assert.deepEqual(skillNamesInText('/review and /ship-it now'), ['review', 'ship-it']);
  assert.equal(injectSkillPrompt('hello', []), 'hello');
  const prompt = injectSkillPrompt('/review the auth module', [{ name: 'review', body: 'Read every file.' }]);
  assert.match(prompt, /^The user invoked skill\(s\) with \/name/);
  assert.match(prompt, /## \/review\n\nRead every file\./);
  assert.ok(prompt.endsWith('---\n\n/review the auth module'));
});

test('a Codex agent gets the skill body; the transcript keeps the message as typed', async () => {
  const h = harness();
  const dir = projectDir(h.dir, 'app');
  write(path.join(dir, '.agents/skills/review/SKILL.md'), skill('review', 'Review'));
  const project = h.manager.addProject({ path: dir });
  const bo = await h.manager.create({ name: 'Bo', engine: 'codex', projectId: project.id });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
  h.manager.send(bo.id, '/review the auth module');
  h.manager.send(ada.id, '/review the auth module');
  await settle();
  assert.match(h.runner(bo.id).sent[0].text, /## \/review\n\nDo the review thing\./);
  assert.ok(!h.runner(ada.id).sent[0].text.includes('## /review'), 'Claude Code runs the command itself');
  assert.equal(h.manager.entries(bo.id).find(e => e.kind === 'user')?.text, '/review the auth module');
  const listed = await h.manager.commands(bo.id);
  // The project's skills come first; personal ones from the real home folder may follow.
  assert.deepEqual([listed[0].name, listed[0].scope], ['review', 'project']);
  assert.ok(listed.every(c => !('path' in c)), 'file paths stay on the server');
});
