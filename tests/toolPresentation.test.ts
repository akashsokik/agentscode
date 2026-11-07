import assert from 'node:assert/strict';
import test from 'node:test';
import type { ToolCall } from '../shared/types.ts';
import { commandLabel, commandSteps, presentTool, searchPatterns, shellCommand, shellWords, stepChips } from '../web/toolPresentation.ts';

const bash = (command: string, description?: string): ToolCall => {
  const flat = command.replace(/\s+/g, ' ').trim();
  return {
    name: 'Bash',
    summary: flat.length > 160 ? `${flat.slice(0, 159)}...` : flat,
    detail: [command, description && `# ${description}`].filter(Boolean).join('\n'),
    status: 'ok',
  };
};

test('chained commands split into captioned steps', () => {
  const steps = commandSteps("git status --short && cat package.json && sed -n '1,260p' scripts/build.mjs; npm test || true");
  assert.deepEqual(steps.map(s => [s.op, s.action, s.target]), [
    [undefined, 'Run', 'git status --short'],
    ['&&', 'Read', 'package.json'],
    ['&&', 'Read', 'scripts/build.mjs'],
    [';', 'Run', 'npm test'],
    ['||', 'Run', 'true'],
  ]);
  assert.equal(steps[2].path, 'scripts/build.mjs');
});

test('opaque or single commands have no steps', () => {
  for (const command of [
    'cargo test',
    'rg foo src | head',
    "echo 'a && b'",
    'cd $(pwd) && ls',
    '(cd x && make) && ls',
    'cat <<EOF && ls\nx\nEOF',
    'cargo build 2>&1 | tail',
  ]) {
    assert.deepEqual(commandSteps(command), [], command);
  }
  const shown = presentTool(bash('cd src && cat a.rs'));
  assert.equal(shown.action, 'Read', 'plumbing before a read leaves a read');
  assert.equal(shown.target, 'a.rs');
  assert.equal(shown.chips, undefined);
});

test('a chain reads as chips: plumbing dropped, repeats merged, reads by file name', () => {
  const shown = presentTool(bash('cd /repo && git status --short && rg --files | head -50 && cat src/app.ts && git status && find . -name "*.ts"', 'Map the repo'));
  assert.equal(shown.action, 'Run');
  assert.equal(shown.description, 'Map the repo');
  assert.deepEqual(shown.chips?.map(c => [c.action, c.label]), [
    ['Run', 'git status'],
    ['Run', 'rg'],
    ['Read', 'app.ts'],
    ['Run', 'find'],
  ]);
  assert.equal(shown.chips?.[2].path, 'src/app.ts');
});

test('rg --files is a search for files, and a bare search reads as Search with pills', () => {
  assert.deepEqual(commandSteps('git status && rg --files').map(s => [s.action, s.target]), [['Run', 'git status'], ['Find', 'files']]);
  const shown = presentTool(bash("rg -n 'fold|rail' web"));
  assert.equal(shown.action, 'Search');
  assert.deepEqual(shown.patterns, ['fold', 'rail']);
});

test('search pills split only simple extended alternatives', () => {
  assert.deepEqual(searchPatterns('a|b|c'), ['a', 'b', 'c']);
  assert.deepEqual(searchPatterns('a|(b|c)'), ['a|(b|c)'], 'groups stay whole');
  assert.deepEqual(searchPatterns('a||b'), ['a||b'], 'an empty alternative stays whole');
  assert.deepEqual(searchPatterns('a|b', "grep 'a|b' x"), ['a|b'], 'basic grep has no alternation');
  assert.deepEqual(searchPatterns('a|b', "grep -E 'a|b' x"), ['a', 'b']);
  assert.deepEqual(searchPatterns('a|b', "rg -F 'a|b'"), ['a|b'], 'fixed strings are literal');
  const grep = presentTool({ name: 'Grep', summary: 'foo|bar  in web/panes', status: 'ok' });
  assert.deepEqual([grep.action, grep.patterns], ['Search', ['foo', 'bar']]);
});

test("Claude's description comes off the command; a command ending in a comment keeps it", () => {
  assert.deepEqual(shellCommand(bash('npm test\nnpm run build', 'Run the checks')), { command: 'npm test\nnpm run build', description: 'Run the checks' });
  assert.deepEqual(shellCommand(bash('ls\n# done')), { command: 'ls\n# done' });
  const codex: ToolCall = { name: 'Shell', summary: 'a; b', detail: 'a\n# b', status: 'ok' };
  assert.deepEqual(shellCommand(codex), { command: 'a\n# b' }, 'Codex details are the command alone');
});

test('a plain command keeps its first line as the target', () => {
  const shown = presentTool(bash('npm test -- --watch=false'));
  assert.deepEqual([shown.action, shown.target, shown.chips], ['Run', 'npm test -- --watch=false', undefined]);
});

test('labels and words', () => {
  assert.equal(commandLabel('git status --short'), 'git status');
  assert.equal(commandLabel('/usr/bin/node --test'), 'node');
  assert.equal(commandLabel('npm run build'), 'npm run');
  assert.equal(commandLabel('cat ./a.ts'), 'cat');
  assert.deepEqual(shellWords(`a 'b c' "d \\"e\\"" f\\ g`), ['a', 'b c', 'd "e"', 'f g']);
  assert.equal(shellWords("a 'b"), undefined);
  assert.deepEqual(stepChips(commandSteps('echo hi && pwd && npm test && npm test')).map(c => c.label), ['npm test']);
});

test('file tools open their file; several files do not', () => {
  assert.deepEqual(presentTool({ name: 'Edit', summary: 'web/a.ts', status: 'ok' }).file, { path: 'web/a.ts', diff: true });
  assert.equal(presentTool({ name: 'Edit', summary: 'a.ts, b.ts', status: 'ok' }).file, undefined);
});
