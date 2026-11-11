import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { countChanges, isReadOnlyGit, MergeRecords, parseWorktrees, readGit, taskRefs, WorkService, type GitRunner } from '../server/work.ts';
import { mentionsBranch, namesInMergeSubject } from '../shared/work.ts';
import type { Agent, PeerMessage, Project } from '../shared/types.ts';
import { harness, tempDir } from './helpers.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, text: string, message: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};
const merge = (cwd: string, branch: string, message: string) => { git(cwd, 'merge', '-q', '--no-ff', branch, '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };

/** A project with a GitHub-like remote: feat/a and feat/b merged and pushed, feat/c merged, not pushed. */
function setup() {
  const dir = tempDir('work');
  git(dir, 'init', '-q', '--bare', 'remote.git');
  git(dir, 'clone', '-q', 'remote.git', 'app');
  const repo = fs.realpathSync(path.join(dir, 'app'));
  const base = commit(repo, 'README.md', 'app\n', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  for (const [branch, who] of [['feat/a', 'Fen'], ['feat/b', 'Cy']]) {
    git(repo, 'checkout', '-q', '-b', branch, 'main');
    commit(repo, `${branch}.txt`, branch, `work on ${branch}`);
    git(repo, 'checkout', '-q', 'main');
    merge(repo, branch, `Merge ${branch} (${who}): the work`);
  }
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat/c', 'main');
  commit(repo, 'c.txt', 'c', 'work on c');
  git(repo, 'checkout', '-q', 'main');
  merge(repo, 'feat/c', 'Merge feat/c (Fen, Ada): more work');
  git(repo, 'branch', 'backup/pre-x', 'main');
  git(repo, 'branch', 'feat/fresh', 'main'); // made from main, never used
  const project = { id: 'p1', name: 'app', path: repo, code: 'APP', exists: true, isGit: true } as unknown as Project;
  return { dir, repo, base, project };
}

function service(dir: string, agents: Agent[] = [], messages: PeerMessage[] = [], runner: GitRunner = readGit) {
  return new WorkService(new MergeRecords(path.join(dir, 'data', 'work')), { agents: () => agents, messages: () => messages, agentsDir: path.join(dir, 'data', 'agents'), knownRef: () => true }, runner);
}

// ---- small pieces -------------------------------------------------------------------------------

test('only read-only git commands are allowed for the view', () => {
  for (const args of [
    ['reflog', 'show', 'refs/heads/main'], ['worktree', 'list', '--porcelain'], ['rev-list', '--count', 'a..b'], ['log', '-1'],
    ['status', '--porcelain'], ['rev-parse', '--show-toplevel'], ['merge-base', '--is-ancestor', 'a', 'b'], ['for-each-ref', 'refs/heads'],
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
  ]) assert.ok(isReadOnlyGit(args), args.join(' '));
  for (const args of [
    ['fetch'], ['pull'], ['push'], ['worktree', 'remove', 'x'], ['worktree', 'prune'], ['worktree', 'list'], ['branch', '-D', 'x'], ['status'],
    ['merge-base', 'a', 'b'], ['reset', '--hard'], ['checkout', 'x'], ['gc'], ['reflog', 'expire'], ['log', '--output=/tmp/x'], ['update-ref', 'x', 'y'],
    ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['config', 'x', 'y'],
  ]) assert.equal(isReadOnlyGit(args), false, args.join(' '));
});

test('readGit refuses anything that is not a read before git runs', async () => {
  await assert.rejects(readGit(['fetch'], '/'), /Not a read-only git command/);
  await assert.rejects(readGit(['branch', '-D', 'main'], '/'), /Not a read-only git command/);
});

test('branch names, merge messages, task ids and worktree lists parse safely', () => {
  assert.ok(mentionsBranch('Merge your feat/notes-tab (fefb31f) into main', 'feat/notes-tab'));
  assert.ok(!mentionsBranch('feat/notes-tab-2 is new', 'feat/notes-tab'));
  assert.ok(!mentionsBranch('see x/feat/notes-tab', 'feat/notes-tab'));
  assert.ok(mentionsBranch('branch feat/notes-tab.', 'feat/notes-tab'));
  assert.deepEqual(namesInMergeSubject('Merge fix/notarize-poll-2 (Fen, Ada): submit'), ['Fen', 'Ada']);
  assert.deepEqual(namesInMergeSubject('Merge pull request #86 from x/y'), []);
  assert.deepEqual(taskRefs('Build it per ACH-D15 and ACH-D14.\n\nDecisions in force that may apply (check with ref_get): ACH-D2 x; ACH-D1 y'), ['ACH-D15', 'ACH-D14']);
  const parsed = parseWorktrees('worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /w\nHEAD bbb\ndetached\nlocked\n\nworktree /gone\nHEAD ccc\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n');
  assert.deepEqual(parsed.map(w => [w.path, w.branch, w.locked, w.prunable]), [['/r', 'main', false, false], ['/w', null, true, false], ['/gone', 'x', false, true]]);
});

// ---- merges, pushed, the graph -------------------------------------------------------------------

test('merges come from main\'s record, with who, reviewer and task; pushed is origin\'s main as last fetched', async () => {
  const { dir, project } = setup();
  const messages = [
    { id: 'd1', conversationId: 'c1', fromAgentId: 's', fromName: 'SuperAgent', toAgentId: 'fen', toName: 'Fen', text: 'IMPLEMENTATION: build feat/a per ACH-D7', delegation: { kind: 'implementation', task: 'Build feat/a per ACH-D7.\n\nDecisions in force that may apply: ACH-D2', acceptanceCriteria: 'ok' }, ts: 1, status: 'delivered', expectsReply: true },
    { id: 'r1', conversationId: 'c2', replyTo: 'd2', fromAgentId: 'rhea', fromName: 'Rhea', toAgentId: 's', toName: 'SuperAgent', text: 'REVIEW RESULT: PASSED feat/a', report: { outcome: 'passed', summary: 'APPROVED feat/a', evidence: 'x' }, ts: 2, status: 'delivered', expectsReply: false },
  ] as unknown as PeerMessage[];
  const agents = [{ id: 'fen', name: 'Fen', role: 'dev', status: 'idle', worktree: null }, { id: 'rhea', name: 'Rhea', role: 'reviewer', status: 'idle', worktree: null }] as unknown as Agent[];
  const view = await service(dir, agents, messages).project(project);
  assert.equal(view.defaultBranch, 'main');
  assert.equal(view.remote, 'origin/main');
  assert.equal(view.notPushed, 1, 'the feat/c merge is local only');
  const byBranch = new Map(view.merged.map(m => [m.branch, m]));
  assert.deepEqual([...byBranch.keys()].sort(), ['feat/a', 'feat/b', 'feat/c']);
  assert.equal(byBranch.get('feat/a')!.pushed, true);
  assert.equal(byBranch.get('feat/b')!.pushed, true);
  assert.equal(byBranch.get('feat/c')!.pushed, false);
  assert.deepEqual(byBranch.get('feat/a')!.agentIds, ['fen'], 'who, from the merge message');
  assert.equal(byBranch.get('feat/a')!.reviewer, 'Rhea', 'the passing review names it');
  assert.equal(byBranch.get('feat/a')!.conversationId, 'c1');
  assert.deepEqual(byBranch.get('feat/a')!.refs, ['ACH-D7'], 'the task\'s own decision, not the appended list');
  assert.deepEqual(byBranch.get('feat/c')!.names, ['Fen', 'Ada']);
  assert.equal(byBranch.get('feat/a')!.rewritten, false);
  // The graph: main, newest first, merges marked, origin's main labelled GitHub.
  assert.equal(view.graph[0].merge, true);
  assert.deepEqual(view.graph[0].labels, ['main']);
  assert.ok(view.graph[1].labels.includes('GitHub'));
  assert.deepEqual(view.graph[1].names, ['Cy']);
  assert.ok(view.graph.length <= 15);
});

test('after main is rewritten, merges still count by record: same files map to the new commit, a folded one has none', async () => {
  const { dir, repo, base, project } = setup();
  const svc = service(dir);
  const before = await svc.project(project);
  const original = new Map(before.merged.map(m => [m.branch, m.originalHash]));
  // Rewrite: feat/a's merge becomes one commit with the same files; feat/b and feat/c fold into one.
  const treeA = git(repo, 'rev-parse', `${original.get('feat/a')}^{tree}`);
  const treeC = git(repo, 'rev-parse', `${original.get('feat/c')}^{tree}`);
  const newA = git(repo, 'commit-tree', treeA, '-p', base, '-m', 'A');
  const newBC = git(repo, 'commit-tree', treeC, '-p', newA, '-m', 'B and C');
  git(repo, 'update-ref', 'refs/heads/main', newBC);
  git(repo, 'reset', '-q', '--hard', 'main');
  // git forgets the old commits: no reflog, no unreachable objects.
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  git(repo, 'gc', '-q', '--prune=now');
  assert.throws(() => git(repo, 'merge-base', '--is-ancestor', 'feat/a', 'main'), 'git no longer sees feat/a as merged');

  const after = await service(dir).project(project, true);
  const m = new Map(after.merged.map(x => [x.branch, x]));
  assert.equal(m.get('feat/a')!.hash, newA, 'same files: the rewritten commit');
  assert.equal(m.get('feat/a')!.rewritten, true);
  assert.equal(m.get('feat/b')!.hash, null, 'folded in with feat/c: no commit of its own');
  assert.equal(m.get('feat/c')!.hash, newBC);
  assert.equal(after.graph.find(c => c.hash === newA)?.names.join(), 'Fen', 'the graph labels the rewritten commit from the record');
  // Cleanup still knows these branches are merged, by record.
  const names = after.cleanup.branches.map(b => `${b.name}:${b.by}`).sort();
  assert.deepEqual(names, ['feat/a:record', 'feat/b:record', 'feat/c:record']);
});

test('pushed: nothing local only means everything merged is on GitHub, rewritten or not', async () => {
  const { dir, repo, project } = setup();
  git(repo, 'push', '-q', 'origin', 'main');
  const view = await service(dir).project(project, true);
  assert.equal(view.notPushed, 0);
  assert.ok(view.merged.every(m => m.pushed === true));
});

// ---- in progress and cleanup ----------------------------------------------------------------------

test('in progress: ahead and behind main, changes, last commit; symlinks are not work', async () => {
  const { dir, repo, project } = setup();
  const wt = path.join(dir, 'data', 'agents', 'fen', 'workspace', 'wt-d');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/d', wt, 'main');
  commit(wt, 'd1.txt', '1', 'd one');
  commit(wt, 'd2.txt', '2', 'd two');
  commit(repo, 'main-only.txt', 'm', 'main moves on');
  fs.writeFileSync(path.join(wt, 'd1.txt'), 'changed');
  fs.writeFileSync(path.join(wt, 'new.txt'), 'new');
  fs.symlinkSync(dir, path.join(wt, 'node_modules'));
  const agents = [{ id: 'fen', name: 'Fen', role: 'dev', status: 'idle', worktree: null }] as unknown as Agent[];
  const view = await service(dir, agents).project(project, true);
  const d = view.inProgress.find(b => b.branch === 'feat/d')!;
  assert.equal(d.ahead, 2);
  assert.equal(d.behind, 1);
  assert.equal(d.changed, 1);
  assert.equal(d.untracked, 1, 'new.txt; the node_modules link is not counted');
  assert.equal(d.last?.subject, 'd two');
  assert.equal(d.agentName, 'Fen', 'owner from the folder being under its home');
  assert.equal(d.state, 'open');
  assert.deepEqual(countChanges('?? node_modules\n M a.ts\n?? b.txt\n', wt), { changed: 1, untracked: 2, links: 1 });
});

test('cleanup lists merged work only: never main or backup/*, never a live agent\'s worktree, a locked one or a new branch; dirty folders flagged', async () => {
  const { dir, repo, project } = setup();
  const add = (name: string, branch: string, start = 'feat/a') => { const p = path.join(dir, name); git(repo, 'worktree', 'add', '-q', p, branch === '--detach' ? start : branch, ...(branch === '--detach' ? ['--detach'] : [])); return fs.realpathSync(p); };
  const clean = add('wt-a', 'feat/a');
  const dirty = add('wt-b', 'feat/b');
  fs.writeFileSync(path.join(dirty, 'feat/b.txt'), 'edited');
  const linked = add('wt-c', 'feat/c');
  fs.symlinkSync(dir, path.join(linked, 'node_modules'));
  const live = path.join(dir, 'wt-live');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/live', live, 'feat/a');
  const locked = path.join(dir, 'wt-locked');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/locked', locked, 'feat/a');
  git(repo, 'worktree', 'lock', locked);
  const fresh = path.join(dir, 'wt-fresh');
  git(repo, 'worktree', 'add', '-q', fresh, 'feat/fresh');
  const agents = [{ id: 'x', name: 'X', role: 'dev', status: 'idle', worktree: { path: live, cwd: live, branch: 'feat/live' } }] as unknown as Agent[];
  const view = await service(dir, agents).project(project, true);
  const folders = new Map(view.cleanup.folders.map(f => [fs.realpathSync(f.path), f]));
  assert.ok(folders.has(clean) && !folders.get(clean)!.dirty);
  assert.ok(folders.get(dirty)!.dirty, 'a changed file: dirty');
  assert.equal(folders.get(linked)!.dirty, false, 'only a symlink: not dirty');
  assert.equal(folders.get(linked)!.changes.links, 1);
  assert.ok(!folders.has(fs.realpathSync(live)), 'a live agent\'s worktree');
  assert.ok(!folders.has(fs.realpathSync(locked)), 'a locked worktree');
  assert.ok(!folders.has(fs.realpathSync(fresh)), 'a branch made from main and never used is new, not merged');
  assert.ok(!folders.has(repo), 'never the project\'s own folder');
  const branches = view.cleanup.branches.map(b => b.name);
  assert.ok(!branches.includes('main') && !branches.includes('backup/pre-x') && !branches.includes('feat/fresh'));
  assert.ok(!branches.includes('feat/live') && !branches.includes('feat/locked'), 'still checked out in a folder that stays');
  assert.equal(view.cleanup.branches.find(b => b.name === 'feat/a')?.inFolder, folders.get(clean)!.path);
  assert.ok(view.inProgress.every(b => b.branch !== 'feat/fresh' || b.ahead === 0));
});

test('cleanup removes exactly what was ticked, rechecked now; a dirty folder needs a second yes; links stay intact', async () => {
  const { dir, repo, project } = setup();
  const add = (name: string, branch: string) => { const p = path.join(dir, name); git(repo, 'worktree', 'add', '-q', p, branch); return fs.realpathSync(p); };
  const clean = add('wt-a', 'feat/a');
  const dirty = add('wt-b', 'feat/b');
  fs.writeFileSync(path.join(dirty, 'feat/b.txt'), 'edited');
  const linked = add('wt-c', 'feat/c');
  const target = path.join(dir, 'kept');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'file'), 'keep');
  fs.symlinkSync(target, path.join(linked, 'node_modules'));
  const svc = service(dir);
  const first = await svc.cleanup(project, { projectId: 'p1', folders: [clean, dirty, linked, '/etc'], branches: ['feat/a', 'main', 'backup/pre-x', 'feat/fresh', 'feat/b'] });
  assert.deepEqual(first.removed.folders.sort(), [clean, linked].sort());
  assert.ok(first.skipped.some(s => s.item === dirty && /uncommitted/.test(s.why)));
  assert.ok(first.skipped.some(s => s.item === '/etc'));
  assert.deepEqual(first.removed.branches, ['feat/a']);
  for (const name of ['main', 'backup/pre-x', 'feat/fresh']) assert.ok(first.skipped.some(s => s.item === name), name);
  assert.ok(first.skipped.some(s => s.item === 'feat/b' && /checked out/.test(s.why)), 'its folder stayed');
  assert.equal(fs.readFileSync(path.join(target, 'file'), 'utf8'), 'keep', 'the link went, never what it points to');
  assert.ok(fs.existsSync(dirty));
  const second = await svc.cleanup(project, { projectId: 'p1', folders: [dirty], forceFolders: [dirty], branches: ['feat/b'] });
  assert.deepEqual(second.removed, { folders: [dirty], branches: ['feat/b'] });
  assert.ok(git(repo, 'branch', '--list', 'main'), 'main is still there');
  assert.ok(git(repo, 'branch', '--list', 'backup/pre-x'));
});

test('reading the view changes nothing in the repository, and every git call it makes is a read', async () => {
  const { dir, repo, project } = setup();
  const wt = path.join(dir, 'wt-a');
  git(repo, 'worktree', 'add', '-q', wt, 'feat/a');
  fs.writeFileSync(path.join(wt, 'feat/a.txt'), 'edited');
  const snapshot = () => {
    const refs = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    const logs = execFileSync('find', [path.join(repo, '.git', 'logs'), '-type', 'f', '-exec', 'cat', '{}', '+'], { encoding: 'utf8' });
    const index = fs.statSync(path.join(repo, '.git', 'index')).mtimeMs;
    const wtIndex = fs.statSync(path.join(repo, '.git', 'worktrees', 'wt-a', 'index')).mtimeMs;
    return JSON.stringify({ refs, logs, index, wtIndex });
  };
  const before = snapshot();
  const calls: string[][] = [];
  const spy: GitRunner = (args, cwd) => { calls.push(args); return readGit(args, cwd); };
  await service(dir, [], [], spy).project(project, true);
  assert.equal(snapshot(), before, 'refs, reflogs and both indexes untouched');
  assert.ok(calls.length > 5);
  for (const args of calls) assert.ok(isReadOnlyGit(args), args.join(' '));
});

test('the cleanup route refuses a cross-origin write', async () => {
  const h = harness();
  const server = createApp(h.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/work/cleanup`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ projectId: 'x', folders: [], branches: ['main'] }) });
    assert.equal(res.status, 403);
    const view = await fetch(url.replace('/cleanup', '')).then(r => r.json()) as { projects: unknown[] };
    assert.deepEqual(view.projects, []);
  } finally {
    server.close();
  }
});
