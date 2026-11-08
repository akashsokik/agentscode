import assert from 'node:assert/strict';
import test from 'node:test';
import { commandPaths, locate, toolPaths, type Place } from '../server/whereabouts.ts';

const places: Place[] = [
  { root: '/w/proj', projectId: 'p' },
  { root: '/w/proj-other', projectId: 'o' },
  { root: '/w/proj/.worktrees/gus', projectId: 'p', branch: 'agent/gus' },
];

test('a leading cd and git -C name the folders a command works in', () => {
  assert.deepEqual(commandPaths('cd /w/proj && npm test', '/home'), ['/w/proj']);
  assert.deepEqual(commandPaths(`cd "/w/my proj" && ls`, '/home'), ['/w/my proj']);
  assert.deepEqual(commandPaths('git -C /w/proj-other status', '/home'), ['/w/proj-other']);
  assert.deepEqual(commandPaths('cd ~/code && ls', '/home', '/Users/me'), ['/Users/me/code']);
  assert.deepEqual(commandPaths('ls -la', '/home'), []);
});

test('tool paths resolve relative paths against the working folder', () => {
  assert.deepEqual(toolPaths('Read', { file_path: 'src/a.ts' }, '/w/proj'), ['/w/proj/src/a.ts']);
  assert.deepEqual(toolPaths('Grep', { pattern: 'x', path: '/w/proj-other/web' }, '/home'), ['/w/proj-other/web']);
  assert.deepEqual(toolPaths('Bash', { command: 'cd /w/proj && git status' }, '/home'), ['/w/proj']);
  assert.deepEqual(toolPaths('WebSearch', { query: 'x' }, '/home'), []);
});

test('locate picks the deepest place and respects folder boundaries', () => {
  assert.equal(locate('/w/proj/src/a.ts', places)?.projectId, 'p');
  assert.equal(locate('/w/proj', places)?.root, '/w/proj');
  assert.equal(locate('/w/proj-other/x', places)?.projectId, 'o');
  assert.equal(locate('/w/proj/.worktrees/gus/web/a.ts', places)?.branch, 'agent/gus');
  assert.equal(locate('/w/elsewhere/a.ts', places), null);
  assert.equal(locate('/w/pro', places), null);
});

test('the label names the project and branch, falling back to the folder for a removed project', async () => {
  const { whereabouts } = await import('../web/whereabouts.ts');
  const base = { projectId: null, worktree: null } as unknown as import('../shared/types.ts').Agent;
  const projects = [{ id: 'p', name: 'orcabox' }];
  assert.equal(whereabouts(base, projects), null);
  assert.deepEqual(whereabouts({ ...base, workingIn: { projectId: 'p', root: '/w/orcabox', branch: 'main', at: 0 } }, projects), { project: 'orcabox', branch: 'main', own: false });
  assert.deepEqual(whereabouts({ ...base, workingIn: { projectId: 'gone', root: '/w/old-site', branch: null, at: 0 } }, projects), { project: 'old-site', branch: null, own: false });
  assert.deepEqual(whereabouts({ ...base, projectId: 'p', workingIn: { projectId: 'p', root: '/w/orcabox', branch: 'dev', at: 0 } }, projects)?.own, true);
});
