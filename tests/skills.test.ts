import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MAX_LISTED_FILES, listProjectFiles } from '../server/fileList.ts';
import { commandBody, discoverCommands, parseFrontmatter } from '../server/skills.ts';

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcode-skills-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const skill = (description: string, extra = '') => `---\nname: ignored-for-claude\ndescription: ${description}\n${extra}---\n\nDo the thing.\n`;

test('frontmatter: flat keys, quotes and folded values', () => {
  const { data, body } = parseFrontmatter('---\nname: "deploy"\ndescription: >\n  Ship it\n  to prod\nuser-invocable: false\n---\nBody\n');
  assert.deepEqual(data, { name: 'deploy', description: 'Ship it to prod', 'user-invocable': 'false' });
  assert.equal(body, 'Body\n');
  assert.deepEqual(parseFrontmatter('No frontmatter'), { data: {}, body: 'No frontmatter' });
});

test('Claude: project, personal and enabled plugin skills and commands, named as Claude Code names them', t => {
  const home = tree({
    '.claude/skills/anatomy/SKILL.md': skill('Draw figures'),
    '.claude/skills/hidden/SKILL.md': skill('Model only', 'user-invocable: false\n'),
    '.claude/skills/notaskill/README.md': 'no SKILL.md here',
    '.claude/commands/review.md': '---\ndescription: Review a diff\nargument-hint: <path>\n---\nReview.\n',
    '.claude/commands/frontend/component.md': '# Make a component\n',
    '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'vercel@market': true, 'off@market': false } }),
    'plugins/vercel/skills/deploy/SKILL.md': skill('Deploy'),
    'plugins/vercel/commands/status.md': 'Show status\n',
    'plugins/vercel/commands/_conventions.md': 'A partial, not a command\n',
    'plugins/off/skills/nope/SKILL.md': skill('Disabled plugin'),
  });
  fs.writeFileSync(path.join(home, '.claude/plugins.json'), '');
  fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'vercel@market': [{ scope: 'user', installPath: path.join(home, 'plugins/vercel') }],
      'off@market': [{ scope: 'user', installPath: path.join(home, 'plugins/off') }],
    },
  }));
  const cwd = tree({ '.claude/skills/anatomy/SKILL.md': skill('The project one wins'), '.claude/skills/ship/SKILL.md': skill('Ship it') });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });

  const found = discoverCommands('claude', cwd, home);
  const byName = new Map(found.map(c => [c.name, c]));
  assert.deepEqual([...byName.keys()].sort(), ['anatomy', 'frontend:component', 'review', 'ship', 'vercel:deploy', 'vercel:status']);
  assert.equal(byName.get('anatomy')?.scope, 'project', 'a project skill shadows a personal one of the same name');
  assert.equal(byName.get('anatomy')?.description, 'The project one wins');
  assert.deepEqual({ scope: byName.get('review')?.scope, hint: byName.get('review')?.argumentHint, description: byName.get('review')?.description }, { scope: 'user', hint: '<path>', description: 'Review a diff' });
  assert.equal(byName.get('frontend:component')?.description, 'Make a component', 'a command without frontmatter is described by its first line');
  assert.deepEqual({ scope: byName.get('vercel:deploy')?.scope, source: byName.get('vercel:deploy')?.source }, { scope: 'plugin', source: 'vercel' });
});

test('Codex: skills from .codex and .agents, nested, named by their frontmatter, with their bodies', t => {
  const home = tree({
    '.codex/skills/.system/imagegen/SKILL.md': '---\nname: imagegen\ndescription: Make images\n---\nUse the image tool.\n',
    '.agents/skills/anatomy/SKILL.md': '---\nname: anatomy\ndescription: Draw figures\n---\nDraw.\n',
  });
  const cwd = tree({ '.agents/skills/local/SKILL.md': '---\nname: ship-it\ndescription: Ship\n---\nShip it.\n' });
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });

  const found = discoverCommands('codex', cwd, home);
  assert.deepEqual(found.map(c => [c.name, c.scope, c.source]), [['ship-it', 'project', 'agents'], ['imagegen', 'user', 'codex'], ['anatomy', 'user', 'agents']]);
  assert.equal(commandBody(found[1]), 'Use the image tool.\n');
});

test('the file list walks a plain folder, skipping dependencies and paths an @ token cannot carry', async t => {
  const root = tree({ 'a.ts': '', 'src/b.ts': '', 'node_modules/x/index.js': '', 'has space.md': '', '.env.example': '' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(await listProjectFiles(root), { files: ['.env.example', 'a.ts', 'src/b.ts'], truncated: false });
  assert.ok(MAX_LISTED_FILES >= 10_000);
});

test('the file list follows git in a repository, leaving ignored files out', async t => {
  const root = tree({ '.gitignore': 'secret.txt\n', 'kept.ts': '', 'secret.txt': '', 'dir/new.ts': '' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
  } catch {
    t.skip('git is not installed');
    return;
  }
  const { files } = await listProjectFiles(root);
  assert.deepEqual(files.sort(), ['.gitignore', 'dir/new.ts', 'kept.ts']);
});
