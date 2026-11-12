// First: no GIT_DIR and the like from a git hook (tests/isolate.ts).
import { gitEnv } from './isolate.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWalkthrough, listWalkthroughs, readWalkthrough, walkthroughImage, walkthroughMarkdown, type WalkthroughContext } from '../server/walkthroughs.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walk-')));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: gitEnv(), stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.ts'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  git('add', '.'); git('commit', '-qm', 'init');
  fs.appendFileSync(path.join(repo, 'a.ts'), 'added\n');
  fs.writeFileSync(path.join(base, 'shot.png'), PNG);
  const ctx: WalkthroughContext = {
    agentId: 'a1', agentName: 'Fen', dir: path.join(base, 'home', 'walkthroughs'), cwd: repo,
    rootOf: target => (target.startsWith(repo + path.sep) ? { root: repo, open: { project: 'p' }, projectId: 'p' } : null),
    fallback: { projectId: null, root: null, branch: null },
  };
  return { base, repo, ctx };
}

test('a walkthrough captures code, diffs, commands and images, and lists newest first', async () => {
  const { base, ctx } = setup();
  const w = await createWalkthrough(ctx, {
    title: 'Lines', summary: 'What changed.',
    steps: [
      { kind: 'note', title: 'Why', body: 'Because.' },
      { kind: 'code', title: 'The lines', body: '', path: 'a.ts', start_line: 3, end_line: 5 },
      { kind: 'diff', title: 'The change', body: '', path: path.join(ctx.cwd, 'a.ts') },
      { kind: 'command', title: 'Tests', body: '', command: 'npm test', output: 'ok' },
      { kind: 'image', title: 'Screen', body: '', path: path.join(base, 'shot.png') },
    ],
  }, Date.UTC(2026, 10, 8, 12));
  assert.equal(w.stepCount, 5);
  assert.equal(w.branch, 'main');
  assert.ok(w.commit);
  assert.equal(w.projectId, 'p');
  assert.equal(w.steps[1].excerpt, 'line 3\nline 4\nline 5');
  assert.deepEqual(w.steps[1].root, { project: 'p' });
  assert.match(w.steps[2].excerpt ?? '', /\+added/);
  assert.equal(w.steps[4].image?.mediaType, 'image/png');
  assert.ok(fs.existsSync(walkthroughImage(ctx.dir, w.id, w.steps[4].image!.file)));
  assert.deepEqual(readWalkthrough(ctx.dir, w.id), w);
  assert.equal(listWalkthroughs(ctx.dir)[0].id, w.id);
  const md = walkthroughMarkdown(w);
  assert.match(md, /^# Lines/);
  assert.match(md, /## 2\. The lines[\s\S]*```ts\nline 3/);
  assert.ok(fs.existsSync(path.join(ctx.dir, w.id, 'walkthrough.md')));
});

test('bad steps are all reported and nothing is saved', async () => {
  const { ctx } = setup();
  await assert.rejects(createWalkthrough(ctx, {
    title: 'Bad', summary: 's',
    steps: [
      { kind: 'code', title: 'Outside', body: '', path: '/etc/hosts', start_line: 1 },
      { kind: 'code', title: 'Too far', body: '', path: 'a.ts', start_line: 999 },
      { kind: 'note', title: 'Empty', body: '' },
      { kind: 'diff', title: 'Missing', body: '' },
    ],
  }), (error: Error) => {
    assert.match(error.message, /Step 1 .*outside/);
    assert.match(error.message, /Step 2 .*no line 999/);
    assert.match(error.message, /Step 3 .*needs a body/);
    assert.match(error.message, /Step 4 .*needs a path/);
    return true;
  });
  assert.deepEqual(listWalkthroughs(ctx.dir), []);
});

test('ids and image names from outside cannot reach other files', () => {
  const { ctx } = setup();
  assert.throws(() => readWalkthrough(ctx.dir, '../../etc'), /No such walkthrough/);
  assert.throws(() => walkthroughImage(ctx.dir, '20261108-abcdef12', '../walkthrough.json'), /No such image/);
});

test('a diagram step keeps its Mermaid source, without a pasted fence', async () => {
  const { ctx } = setup();
  const w = await createWalkthrough(ctx, {
    title: 'Flow', summary: 's',
    steps: [
      { kind: 'diagram', title: 'Calls', body: '', source: '```mermaid\nsequenceDiagram\n  A->>B: hi\n```' },
      { kind: 'diagram', title: 'Plain', body: '', source: 'flowchart LR\n  A --> B' },
    ],
  });
  assert.equal(w.steps[0].source, 'sequenceDiagram\n  A->>B: hi');
  assert.equal(w.steps[1].source, 'flowchart LR\n  A --> B');
  assert.match(walkthroughMarkdown(w), /```mermaid\nsequenceDiagram/);
  await assert.rejects(createWalkthrough(ctx, { title: 'x', summary: 's', steps: [{ kind: 'diagram', title: 'Empty', body: '' }] }), /needs Mermaid source/);
});
