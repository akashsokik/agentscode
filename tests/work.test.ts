import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { countChanges, isReadOnlyGit, MergeRecords, parseWorktrees, readGit, taskRefs, WorkService, type GitRunner } from '../server/work.ts';
import { mentionsBranch, namesInMergeSubject, parseDecorations } from '../shared/work.ts';
import { edgePath, layoutGraph } from '../shared/graph.ts';
import type { Agent, PeerMessage, Project } from '../shared/types.ts';
import { harness, tempDir } from './helpers.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';

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
  return new WorkService(new MergeRecords(path.join(dir, 'data', 'work')), { agents: () => agents, messages: () => messages, agentsDir: path.join(dir, 'data', 'agents'), dataDir: path.join(dir, 'data'), knownRef: () => true }, runner);
}

// ---- small pieces -------------------------------------------------------------------------------

test('only read-only git commands are allowed for the view', () => {
  for (const args of [
    ['reflog', 'show', 'refs/heads/main'], ['worktree', 'list', '--porcelain'], ['rev-list', '--count', 'a..b'], ['log', '-1'],
    ['status', '--porcelain'], ['rev-parse', '--show-toplevel'], ['merge-base', '--is-ancestor', 'a', 'b'], ['for-each-ref', 'refs/heads'],
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], ['merge-base', 'a', 'b'],
    ['diff', '--no-ext-diff', '--no-textconv', '--quiet', 'a', 'b', '--', 'f'],
  ]) assert.ok(isReadOnlyGit(args), args.join(' '));
  for (const args of [
    ['fetch'], ['pull'], ['push'], ['worktree', 'remove', 'x'], ['worktree', 'prune'], ['worktree', 'list'], ['branch', '-D', 'x'], ['status'],
    ['merge-base', '--fork-point', 'a'], ['diff', 'a', 'b'], ['diff', '--no-ext-diff', '--quiet', 'a', 'b'], ['reset', '--hard'], ['checkout', 'x'], ['gc'], ['reflog', 'expire'], ['log', '--output=/tmp/x'], ['update-ref', 'x', 'y'],
    ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['symbolic-ref', '--short', 'HEAD', 'refs/remotes/x'], ['config', 'x', 'y'],
  ]) assert.equal(isReadOnlyGit(args), false, args.join(' '));
});

test('readGit refuses anything that is not a read before git runs', async () => {
  await assert.rejects(readGit(['fetch'], '/'), /Not a read-only git command/);
  await assert.rejects(readGit(['branch', '-D', 'main'], '/'), /Not a read-only git command/);
});

test('started from a git hook (GIT_DIR and GIT_INDEX_FILE set when work.ts loads), the view reads its own repository', () => {
  // A child process, so the variables are there when server/work.ts is imported and nothing has
  // dropped them first (the app's case: tests/isolate.ts is not involved).
  const victim = path.join(tempDir('work-hook-victim'), 'repo');
  fs.mkdirSync(victim);
  git(victim, 'init', '-q');
  git(victim, 'commit', '-q', '--allow-empty', '-m', 'victim');
  const repo = path.join(tempDir('work-hook-own'), 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  const indexBefore = fs.readFileSync(path.join(victim, '.git', 'index'));
  const work = JSON.stringify(path.resolve('server', 'work.ts'));
  const script = `const { readGit } = await import(${work});
const dir = await readGit(['rev-parse', '--path-format=absolute', '--absolute-git-dir'], ${JSON.stringify(repo)});
const status = await readGit(['status', '--porcelain'], ${JSON.stringify(repo)});
process.stdout.write(JSON.stringify({ dir: dir.out.trim(), status: status.out.trim() }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_DIR: path.join(victim, '.git'), GIT_INDEX_FILE: path.join(victim, '.git', 'index') },
  })) as { dir: string; status: string };
  assert.equal(out.dir, fs.realpathSync(path.join(repo, '.git')), 'git ran on the folder it was given');
  assert.equal(out.status, '?? a.txt');
  assert.deepEqual(fs.readFileSync(path.join(victim, '.git', 'index')), indexBefore, 'the hook\'s repository is untouched');
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
  // The graph: main and its merged branches in lanes, newest first; HEAD, the local main, and GitHub's main where it is.
  const top = view.graph[0];
  assert.equal(top.merge, true);
  assert.equal(top.head, true, 'the checked-out commit');
  assert.deepEqual(top.refs.find(r => r.name === 'main'), { kind: 'local', name: 'main' }, 'GitHub\'s main is not here yet');
  assert.ok(top.refs.some(r => r.name === 'backup/pre-x'), 'other branches here are pills too');
  assert.equal(top.key, 'main');
  assert.equal(top.lane, 0);
  const pushedTip = view.graph.find(c => c.refs.some(r => r.kind === 'remote' && r.name === 'origin/main'))!;
  assert.deepEqual(pushedTip.names, ['Cy'], 'the feat/b merge, where origin/main is, named from the record');
  const sideCommit = view.graph.find(c => c.subject === 'work on c')!;
  assert.equal(sideCommit.lane, 1, 'a merged branch\'s own commit sits in its lane');
  assert.equal(sideCommit.key, 'Fen', 'that lane is the merge\'s author\'s');
  assert.equal(view.laneOwners.Fen, 'fen');
  assert.equal(view.graphLanes, 2);
  assert.ok(view.graph.length <= 20);
  assert.ok(view.graphEdges.some(e => e.lane === 1 && e.key === 'Fen'));
});

test('an open branch is drawn on top of main in its owner\'s lane; a local branch and its GitHub copy share a pill', async () => {
  const { dir, repo, project } = setup();
  git(repo, 'push', '-q', 'origin', 'main');
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const wt = path.join(home, 'wt-open');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/open', wt, 'main');
  commit(wt, 'o1.txt', '1', 'open one');
  commit(wt, 'o2.txt', '2', 'open two');
  git(repo, 'tag', 'v1.0', 'main');
  const agents = [{ id: 'fen', name: 'Fen', role: 'dev', status: 'idle', worktree: null }] as unknown as Agent[];
  const view = await service(dir, agents).project(project, true);
  assert.deepEqual(view.graph.slice(0, 2).map(c => [c.subject, c.lane, c.key]), [['open two', 1, 'Fen'], ['open one', 1, 'Fen']], 'to the right of main');
  assert.equal(view.graph[2].lane, 0, 'main keeps lane 0');
  assert.deepEqual(view.graph[0].refs, [{ kind: 'local', name: 'feat/open' }]);
  const main = view.graph[2];
  assert.equal(main.head, true);
  assert.deepEqual(main.refs.find(r => r.name === 'main'), { kind: 'local', name: 'main', remote: 'origin/main' }, 'one pill for main and its GitHub copy');
  assert.deepEqual(main.refs.at(-1), { kind: 'tag', name: 'v1.0' }, 'tags last');
  assert.ok(!main.refs.some(r => r.kind === 'remote'), 'no separate GitHub pill');
});

// ---- the graph's lanes (shared/graph.ts) ------------------------------------------------------------

const c = (hash: string, parents: string[], key?: string, mergeKey?: string) => ({ hash, parents, ...(key ? { key } : {}), ...(mergeKey ? { mergeKey } : {}) });

test('lanes: a straight line stays in lane 0, an open branch forks off and joins with a rounded turn', () => {
  // f2 -> f1 -> m2 (main) -> m1
  const layout = layoutGraph([c('f2', ['f1'], 'Fen'), c('f1', ['m2']), c('m2', ['m1'], 'main'), c('m1', [], 'main')]);
  assert.deepEqual(layout.rows.map(r => [r.hash, r.lane, r.key]), [['f2', 0, 'Fen'], ['f1', 0, 'Fen'], ['m2', 0, 'main'], ['m1', 0, 'main']]);
  assert.equal(layout.lanes, 1);
  // A branch tip with main's tip still above it in another lane: main keeps lane 0, the branch gets lane 1.
  const two = layoutGraph([c('m3', ['m2'], 'main'), c('f1', ['m2'], 'Ada'), c('m2', ['m1'], 'main'), c('m1', [], 'main')]);
  assert.deepEqual(two.rows.map(r => r.lane), [0, 1, 0, 0]);
  const join = two.edges.find(e => e.from === 1)!;
  assert.deepEqual([join.fromLane, join.lane, join.to, join.toLane, join.key], [1, 1, 2, 0, 'Ada'], 'Ada\'s line runs in lane 1 and turns into main at m2');
});

test('lanes: a merge sends its other parent to a free lane in the merged branch\'s owner\'s colour', () => {
  // M merges b1 (Fable's) into main; b1 forked from m1.
  const layout = layoutGraph([c('M', ['m1', 'b1'], 'main', 'Fable'), c('b1', ['m1']), c('m1', [], 'main')]);
  assert.deepEqual(layout.rows.map(r => [r.hash, r.lane, r.key]), [['M', 0, 'main'], ['b1', 1, 'Fable'], ['m1', 0, 'main']]);
  const toBranch = layout.edges.find(e => e.from === 0 && e.to === 1)!;
  assert.deepEqual([toBranch.fromLane, toBranch.lane, toBranch.toLane, toBranch.key], [0, 1, 1, 'Fable']);
  const back = layout.edges.find(e => e.from === 1)!;
  assert.deepEqual([back.lane, back.to, back.toLane], [1, 2, 0], 'and joins main again where it forked');
});

test('lanes: with main reserved, main stays in lane 0 and a newer branch tip opens to its right', () => {
  const layout = layoutGraph([c('f2', ['f1'], 'Fen'), c('f1', ['m2']), c('m2', ['m1'], 'main'), c('m1', [], 'main')], { mainKey: 'main' });
  assert.deepEqual(layout.rows.map(r => [r.hash, r.lane]), [['f2', 1], ['f1', 1], ['m2', 0], ['m1', 0]]);
  const join = layout.edges.find(e => e.from === 1)!;
  assert.deepEqual([join.lane, join.toLane, join.key], [1, 0, 'Fen'], 'Fen\'s line turns into main where it forked');
});

test('lanes: a freed lane is reused, so lanes stay few; a line crosses rows in its own lane', () => {
  // Two merges one after another: both branches use lane 1, one after the other.
  const reuse = layoutGraph([
    c('M2', ['M1', 'b2'], 'main', 'Fen'), c('b2', ['M1']),
    c('M1', ['m0', 'b1'], 'main', 'Cy'), c('b1', ['m0']),
    c('m0', [], 'main'),
  ]);
  assert.deepEqual(reuse.rows.map(r => r.lane), [0, 1, 0, 1, 0]);
  assert.equal(reuse.lanes, 2);
  // A branch that forked before a main commit runs past it in lane 1 (as feat/no-shadows past v0.2.4).
  const cross = layoutGraph([c('M', ['r', 'b'], 'main', 'Fen'), c('b', ['p']), c('r', ['p'], 'main'), c('p', [], 'main')]);
  assert.deepEqual(cross.rows.map(r => r.lane), [0, 1, 0, 0]);
  const long = cross.edges.find(e => e.from === 1)!;
  assert.deepEqual([long.lane, long.to, long.toLane], [1, 3, 0], 'down lane 1 past r, then into p');
  // Two branches open at once take lanes 1 and 2, and a parent below the window runs off the bottom.
  const wide = layoutGraph([c('M', ['m', 'x'], 'main', 'Fen'), c('x', ['y']), c('y', ['q'], 'Ada'), c('m', ['q'], 'main')]);
  assert.ok(wide.edges.some(e => e.to === 4), 'q is below the window');
});

test('lane paths are straight with rounded turns', () => {
  const straight = edgePath({ from: 0, fromLane: 0, lane: 0, to: 3, toLane: 0, key: null }, 4, 13, 24, 8);
  assert.equal(straight, 'M8 12V84');
  const merge = edgePath({ from: 0, fromLane: 0, lane: 1, to: 1, toLane: 1, key: null }, 4, 13, 24, 8);
  assert.match(merge, /^M8 12C8 24 21 24 21 36$/);
  const join = edgePath({ from: 1, fromLane: 1, lane: 1, to: 3, toLane: 0, key: null }, 4, 13, 24, 8);
  assert.match(join, /^M21 36V60C21 72 8 72 8 84$/);
  const off = edgePath({ from: 2, fromLane: 1, lane: 1, to: 4, toLane: 1, key: null }, 4, 13, 24, 8);
  assert.equal(off, 'M21 60V98');
});

test('decorations become pills: local, GitHub combined with its local, remote alone, tags; HEAD noted', () => {
  assert.deepEqual(parseDecorations('HEAD -> refs/heads/main, tag: refs/tags/v0.2.6, refs/remotes/origin/main, refs/remotes/origin/HEAD'), {
    head: true, refs: [{ kind: 'local', name: 'main', remote: 'origin/main' }, { kind: 'tag', name: 'v0.2.6' }],
  });
  assert.deepEqual(parseDecorations('refs/remotes/origin/main'), { head: false, refs: [{ kind: 'remote', name: 'origin/main' }] });
  assert.deepEqual(parseDecorations('refs/heads/feat/work-view'), { head: false, refs: [{ kind: 'local', name: 'feat/work-view' }] });
  assert.deepEqual(parseDecorations(''), { head: false, refs: [] });
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

test('a branch merged through another branch counts as merged by record, also after a rewrite', async () => {
  const { dir, repo, base, project } = setup();
  git(repo, 'checkout', '-q', '-b', 'feat/x', base);
  commit(repo, 'x.txt', 'x', 'work on x');
  git(repo, 'checkout', '-q', '-b', 'feat/y', 'feat/x');
  commit(repo, 'y.txt', 'y', 'work on y');
  git(repo, 'checkout', '-q', 'main');
  merge(repo, 'feat/y', 'Merge feat/y (Cy): x and y');
  const svc = service(dir);
  await svc.project(project);
  // Rewrite main to a single commit with the same files, and let git forget the old ones.
  const tree = git(repo, 'rev-parse', 'main^{tree}');
  git(repo, 'update-ref', 'refs/heads/main', git(repo, 'commit-tree', tree, '-p', base, '-m', 'everything'));
  git(repo, 'reset', '-q', '--hard', 'main');
  git(repo, 'reflog', 'expire', '--expire=now', '--all');
  const view = await service(dir).project(project, true);
  const branches = new Map(view.cleanup.branches.map(b => [b.name, b.by]));
  assert.equal(branches.get('feat/x'), 'record', 'feat/x went in through feat/y');
  assert.equal(branches.get('feat/y'), 'record');
  assert.ok(!view.inProgress.some(b => b.branch === 'feat/x' || b.branch === 'feat/y'));
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
  assert.deepEqual(countChanges('?? node_modules\n M a.ts\n?? b.txt\n!! dist/\n!! .env\n', wt), { changed: 1, untracked: 2, links: 1, built: 1, ignored: ['.env'] });
});

test('cleanup lists merged work only: never main or backup/*, never a live agent\'s worktree, a locked one or a new branch; dirty folders flagged', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const add = (name: string, branch: string) => { const p = path.join(home, name); git(repo, 'worktree', 'add', '-q', p, branch); return fs.realpathSync(p); };
  const clean = add('wt-a', 'feat/a');
  const dirty = add('wt-b', 'feat/b');
  fs.writeFileSync(path.join(dirty, 'feat/b.txt'), 'edited');
  const linked = add('wt-c', 'feat/c');
  fs.symlinkSync(dir, path.join(linked, 'node_modules'));
  const live = path.join(home, 'wt-live');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/live', live, 'feat/a');
  const locked = path.join(home, 'wt-locked');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/locked', locked, 'feat/a');
  git(repo, 'worktree', 'lock', locked);
  const fresh = path.join(home, 'wt-fresh');
  // A worktree another tool made, outside PodCode's data folder: never PodCode's to remove.
  const foreign = path.join(dir, 'other-tool', 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/foreign', foreign, 'feat/a');
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
  assert.ok(!folders.has(fs.realpathSync(foreign)), 'never a worktree made outside PodCode');
  const branches = view.cleanup.branches.map(b => b.name);
  assert.ok(!branches.includes('main') && !branches.includes('backup/pre-x') && !branches.includes('feat/fresh'));
  assert.ok(!branches.includes('feat/live') && !branches.includes('feat/locked'), 'still checked out in a folder that stays');
  assert.equal(view.cleanup.branches.find(b => b.name === 'feat/a')?.inFolder, folders.get(clean)!.path);
  assert.ok(view.inProgress.every(b => b.branch !== 'feat/fresh' || b.ahead === 0));
});

test('cleanup removes exactly what was ticked, rechecked now; a dirty folder needs a second yes; links stay intact', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const add = (name: string, branch: string) => { const p = path.join(home, name); git(repo, 'worktree', 'add', '-q', p, branch); return fs.realpathSync(p); };
  const clean = add('wt-a', 'feat/a');
  const dirty = add('wt-b', 'feat/b');
  fs.writeFileSync(path.join(dirty, 'feat/b.txt'), 'edited');
  const linked = add('wt-c', 'feat/c');
  const foreign = path.join(dir, 'other-tool', 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/foreign', foreign, 'feat/a');
  const target = path.join(dir, 'kept');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'file'), 'keep');
  fs.symlinkSync(target, path.join(linked, 'node_modules'));
  const svc = service(dir);
  const first = await svc.cleanup(project, { projectId: 'p1', folders: [clean, dirty, linked, '/etc', foreign], forceFolders: [foreign], branches: ['feat/a', 'main', 'backup/pre-x', 'feat/fresh', 'feat/b'] });
  assert.deepEqual(first.removed.folders.sort(), [clean, linked].sort());
  assert.ok(first.skipped.some(s => s.item === dirty && /uncommitted/.test(s.why)));
  assert.ok(first.skipped.some(s => s.item === '/etc'));
  assert.ok(first.skipped.some(s => s.item === foreign) && fs.existsSync(foreign), 'a worktree another tool made stays, even when asked');
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
  const server = createApp(h.manager, undefined, undefined, OPEN_AUTH).listen(0, '127.0.0.1');
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

// ---- evidence before cleanup (Rhea's review of 579d48e) -------------------------------------------

test('a merge undone by a reset is not merged: no merged row, no branch, no folder for cleanup', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const wt = path.join(home, 'wt-u');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/u', wt, 'main');
  commit(wt, 'u.txt', 'u', 'work on u');
  merge(repo, 'feat/u', 'Merge feat/u (Fen): u');
  const svc = service(dir);
  const before = await svc.project(project, true);
  assert.ok(before.merged.some(m => m.branch === 'feat/u'));
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  const view = await service(dir).project(project, true);
  assert.ok(!view.merged.some(m => m.branch === 'feat/u'), 'the undone merge is not listed as merged');
  assert.ok(!view.cleanup.branches.some(b => b.name === 'feat/u'), 'its branch is not offered for deletion');
  assert.ok(!view.cleanup.folders.some(f => fs.realpathSync(f.path) === fs.realpathSync(wt)), 'nor its folder');
  assert.ok(view.inProgress.some(b => b.branch === 'feat/u'), 'it is work in progress again');
  const tried = await service(dir).cleanup(project, { projectId: 'p1', folders: [wt], branches: ['feat/u'] });
  assert.deepEqual(tried.removed, { folders: [], branches: [] });
});

test('a merge kept only in a backup ref from before a rewrite counts, and says where its commits are', async () => {
  const { dir, repo, base, project } = setup();
  const before = await service(dir).project(project);
  const mergeA = before.merged.find(m => m.branch === 'feat/a')!.originalHash;
  // Rewrite main without the old commits: feat/a's merge kept as one commit with its files, then a commit
  // that changes them (as when private text was removed), so feat/b and feat/c are neither on main nor the same.
  git(repo, 'branch', '-f', 'backup/pre-x', 'main');
  const a = git(repo, 'commit-tree', git(repo, 'rev-parse', `${mergeA}^{tree}`), '-p', base, '-m', 'A');
  git(repo, 'update-ref', 'refs/heads/main', a);
  git(repo, 'reset', '-q', '--hard', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'rewritten\n');
  git(repo, 'commit', '-qam', 'rewritten history');
  const view = await service(dir).project(project, true);
  const c = view.merged.find(m => m.branch === 'feat/c');
  assert.deepEqual(c?.evidence, { kind: 'backup', backup: 'backup/pre-x' }, 'kept in the backup, which holds feat/a\'s merge, proven on main');
  assert.equal(view.cleanup.branches.find(b => b.name === 'feat/c')?.backup, 'backup/pre-x');
  assert.equal(view.merged.find(m => m.branch === 'feat/a')?.evidence.kind, 'content');
});

test('a folder an agent is working in is never listed, whether or not it is its recorded worktree', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'cy', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const wt = path.join(home, 'wt-a');
  git(repo, 'worktree', 'add', '-q', wt, 'feat/a');
  const agents = [{ id: 'cy', name: 'Cy', role: 'dev', status: 'working', worktree: null, workingIn: { projectId: 'p1', root: fs.realpathSync(path.join(wt)), branch: 'feat/a', at: 1 } }] as unknown as Agent[];
  const view = await service(dir, agents).project(project, true);
  assert.ok(!view.cleanup.folders.some(f => fs.realpathSync(f.path) === fs.realpathSync(wt)));
});

test('ignored files: build output is noted, anything else (.env) makes the folder need a second yes', async () => {
  const { dir, repo, project } = setup();
  // Ignore rules every worktree shares (feat/a and feat/b have no .gitignore of their own).
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'dist/\n.env\n');
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const built = path.join(home, 'wt-built');
  git(repo, 'worktree', 'add', '-q', built, 'feat/a');
  fs.mkdirSync(path.join(built, 'dist'));
  fs.writeFileSync(path.join(built, 'dist', 'app.js'), 'x');
  const secret = path.join(home, 'wt-secret');
  git(repo, 'worktree', 'add', '-q', secret, 'feat/b');
  fs.writeFileSync(path.join(secret, '.env'), 'TOKEN=1');
  const svc = service(dir);
  const view = await svc.project(project, true);
  const folders = new Map(view.cleanup.folders.map(f => [fs.realpathSync(f.path), f]));
  assert.equal(folders.get(fs.realpathSync(built))!.dirty, false, 'only build output: not dirty');
  assert.equal(folders.get(fs.realpathSync(built))!.changes.built, 1);
  assert.equal(folders.get(fs.realpathSync(secret))!.dirty, true, '.env: dirty');
  assert.deepEqual(folders.get(fs.realpathSync(secret))!.changes.ignored, ['.env']);
  const builtListed = folders.get(fs.realpathSync(built))!.path;
  const result = await svc.cleanup(project, { projectId: 'p1', folders: [built, secret], branches: [] });
  assert.deepEqual(result.removed.folders, [builtListed]);
  assert.ok(fs.existsSync(path.join(secret, '.env')), 'the .env folder stays without a second yes');
});

test('a folder with another worktree inside it is never listed, so "Remove anyway" cannot take it', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const outer = path.join(home, 'wt-outer');
  git(repo, 'worktree', 'add', '-q', outer, 'feat/a');
  const inner = path.join(outer, 'nested');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/inner', inner, 'main');
  commit(inner, 'i.txt', 'i', 'inner work');
  const svc = service(dir);
  const view = await svc.project(project, true);
  assert.ok(!view.cleanup.folders.some(f => fs.realpathSync(f.path) === fs.realpathSync(outer)));
  const tried = await svc.cleanup(project, { projectId: 'p1', folders: [outer], forceFolders: [outer], branches: [] });
  assert.deepEqual(tried.removed.folders, []);
  assert.ok(fs.existsSync(path.join(inner, 'i.txt')));
});

test('branch names that look like options are deleted as names, never read as options', async () => {
  const { dir, repo, project } = setup();
  git(repo, 'update-ref', 'refs/heads/-p', git(repo, 'rev-parse', 'feat/a'));
  const svc = service(dir);
  const view = await svc.project(project, true);
  assert.ok(view.cleanup.branches.some(b => b.name === '-p'));
  const result = await svc.cleanup(project, { projectId: 'p1', folders: [], branches: ['-p'] });
  assert.deepEqual(result.removed.branches, ['-p']);
  assert.equal(git(repo, 'for-each-ref', 'refs/heads/-p'), '');
  assert.ok(git(repo, 'rev-parse', 'feat/a'), 'feat/a is untouched');
});

test('a worktree whose folder is gone: only its own record is removed, and only inside the data folder', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  const gone = path.join(home, 'wt-gone');
  git(repo, 'worktree', 'add', '-q', gone, 'feat/a');
  const kept = path.join(home, 'wt-kept');
  git(repo, 'worktree', 'add', '-q', kept, 'feat/b');
  const outside = path.join(dir, 'outside-gone');
  git(repo, 'worktree', 'add', '-q', outside, 'feat/c');
  fs.rmSync(gone, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  const svc = service(dir);
  const view = await svc.project(project, true);
  const missing = view.cleanup.folders.filter(f => f.reason === 'missing').map(f => path.basename(f.path));
  assert.deepEqual(missing, ['wt-gone'], 'the one outside the data folder is not listed');
  const result = await svc.cleanup(project, { projectId: 'p1', folders: [view.cleanup.folders.find(f => f.reason === 'missing')!.path, outside], branches: [] });
  assert.equal(result.removed.folders.length, 1);
  const left = git(repo, 'worktree', 'list', '--porcelain');
  assert.ok(!left.includes('wt-gone'));
  assert.ok(left.includes('wt-kept') && left.includes('outside-gone'), 'other records are intact');
});

test('a gone worktree git records under the old data folder name (a link to the new one) is still ours (ALL-D6)', async () => {
  const { dir, repo, project } = setup();
  fs.mkdirSync(path.join(dir, 'data', 'agents', 'fen', 'workspace'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'data'), path.join(dir, 'old-data'), 'dir');
  const real = path.join(fs.realpathSync(dir), 'data', 'agents', 'fen', 'workspace', 'wt-gone');
  git(repo, 'worktree', 'add', '-q', real, 'feat/a');
  // A record made before the move names ~/.agentscode/... (git keeps the path it was given when the
  // folder was real); that name is now a link to ~/.podcode. Write the record that way.
  const record = path.join(repo, '.git', 'worktrees', 'wt-gone', 'gitdir');
  fs.writeFileSync(record, `${path.join(fs.realpathSync(dir), 'old-data', 'agents', 'fen', 'workspace', 'wt-gone', '.git')}\n`);
  fs.rmSync(real, { recursive: true, force: true });
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), /old-data/);
  const view = await service(dir).project(project, true);
  assert.deepEqual(view.cleanup.folders.filter(f => f.reason === 'missing').map(f => path.basename(f.path)), ['wt-gone']);
});

test('a merge undone after a backup was taken is not merged: a backup counts only when main itself was rewritten (A2)', async () => {
  const { dir, repo, project } = setup();
  const home = path.join(dir, 'data', 'agents', 'fen', 'workspace');
  fs.mkdirSync(home, { recursive: true });
  for (const name of ['v', 'u']) {
    const wt = path.join(home, `wt-${name}`);
    git(repo, 'worktree', 'add', '-q', '-b', `feat/${name}`, wt, 'main');
    commit(wt, `${name}.txt`, name, `work on ${name}`);
    merge(repo, `feat/${name}`, `Merge feat/${name} (Fen): ${name}`);
  }
  const svc = service(dir);
  await svc.project(project, true);
  git(repo, 'branch', 'backup/before-undo', 'main');
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  const view = await service(dir).project(project, true);
  assert.ok(!view.merged.some(m => m.branch === 'feat/u'), 'not merged, though backup/before-undo holds it');
  assert.ok(view.merged.some(m => m.branch === 'feat/v' && m.evidence.kind === 'main'), 'feat/v is still on main');
  assert.ok(view.inProgress.some(b => b.branch === 'feat/u'), 'feat/u is in progress again');
  assert.ok(!view.cleanup.branches.some(b => b.name === 'feat/u'));
  assert.ok(!view.cleanup.folders.some(f => f.branch === 'feat/u'));
  assert.equal(view.cleanup.branches.find(b => b.name === 'feat/v')?.evidence, 'main', 'a plain merge reads as merged, not "by record"');
});

test('file names are never pathspec magic: ":!x.txt" cannot exclude itself from the content proof (A3)', async () => {
  const { dir, repo, project } = setup();
  git(repo, 'checkout', '-q', '-b', 'feat/p', 'main');
  commit(repo, 'y.txt', 'y', 'y');
  commit(repo, ':!x.txt', 'only on the branch', 'odd name');
  git(repo, 'checkout', '-q', 'main');
  merge(repo, 'feat/p', 'Merge feat/p (Fen): p');
  await service(dir).project(project, true);
  // Undo the merge, then bring only y.txt to main by another route.
  git(repo, 'reset', '-q', '--hard', 'HEAD~1');
  commit(repo, 'y.txt', 'y', 'y on main');
  const view = await service(dir).project(project, true);
  assert.ok(!view.merged.some(m => m.branch === 'feat/p'), '":!x.txt" is not on main, so the branch is not proven');
  assert.ok(!view.cleanup.branches.some(b => b.name === 'feat/p'));
});

// ---- selected work inspection (ACH-D24) ---------------------------------------------------------

test('commit inspection reads the selected revision, including root commits and first-parent merges', async () => {
  const { dir, project, repo, base } = setup();
  const svc = service(dir);
  const view = await svc.project(project);
  const merged = view.merged.find(m => m.branch === 'feat/c')!;
  const target = { kind: 'merge' as const, id: merged.originalHash };
  fs.writeFileSync(path.join(repo, 'c.txt'), 'not the selected commit\n');
  const changes = await svc.changes(project, target);
  assert.equal(changes.basis, 'commit');
  assert.deepEqual(changes.files.map(f => f.path), ['c.txt']);
  const diff = await svc.diff(project, target, 'c.txt');
  assert.match(diff.diff, /\+c/);
  assert.doesNotMatch(diff.diff, /not the selected commit/);
  const initial = await svc.changes(project, { kind: 'commit', id: base });
  assert.deepEqual(initial.files.map(f => f.path), ['README.md']);
  assert.match((await svc.diff(project, { kind: 'commit', id: base }, 'README.md')).diff, /\+app/);
});

test('branch inspection uses its own worktree, and switches between branch and uncommitted changes', async () => {
  const { dir, project, repo } = setup();
  const folder = path.join(dir, 'open');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/inspect', folder, 'main');
  commit(folder, 'branch.txt', 'first\n', 'branch change');
  const svc = service(dir);
  const target = { kind: 'branch' as const, id: fs.realpathSync(folder) };
  const committed = await svc.changes(project, target);
  assert.equal(committed.basis, 'branch');
  assert.deepEqual(committed.files.map(f => f.path), ['branch.txt']);
  fs.writeFileSync(path.join(folder, 'branch.txt'), 'first\nsecond\n');
  fs.writeFileSync(path.join(folder, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(folder, 'empty.txt'), '');
  const dirty = await svc.changes(project, target);
  assert.equal(dirty.basis, 'uncommitted');
  assert.deepEqual(dirty.files.map(f => f.path).sort(), ['branch.txt', 'empty.txt', 'new.txt']);
  assert.equal(dirty.files.find(f => f.path === 'empty.txt')!.added, 0);
  assert.match((await svc.diff(project, target, 'branch.txt')).diff, /\+second/);
  assert.match((await svc.diff(project, target, 'new.txt')).diff, /\+new/);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'main checkout untouched');
});

test('Work inspection rejects unlisted targets and files, and does not follow untracked symlinks outside the worktree', async () => {
  const { dir, project, repo } = setup();
  const folder = path.join(dir, 'open');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/inspect', folder, 'main');
  commit(folder, 'branch.txt', 'first\n', 'branch change');
  const secret = path.join(dir, 'outside.txt');
  fs.writeFileSync(secret, 'outside workspace\n');
  fs.symlinkSync(secret, path.join(folder, 'linked.txt'));
  const svc = service(dir), target = { kind: 'branch' as const, id: fs.realpathSync(folder) };
  await assert.rejects(svc.changes(project, { kind: 'branch', id: dir }), /no longer in this project/);
  await assert.rejects(svc.changes(project, { kind: 'commit', id: '--output=oops' }), /no longer in this view/);
  await assert.rejects(svc.diff(project, target, '../outside.txt'), /not in these changes/);
  const changed = await svc.changes(project, target);
  assert.ok(changed.files.some(f => f.path === 'linked.txt'));
  const linked = await svc.diff(project, target, 'linked.txt');
  assert.ok(linked.diff.includes(secret), 'shows link target string');
  assert.doesNotMatch(linked.diff, /outside workspace/, 'never reads the link target contents');
});

test('inspection treats unusual Git file names literally and disables external diff programs', async () => {
  const { dir, project, repo } = setup();
  const names = [':!literal.txt', '-option.txt', 'tab\tname.txt', 'line\nname.txt'];
  for (const name of names) fs.writeFileSync(path.join(repo, name), 'literal\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'unusual files');
  const hash = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'config', 'diff.external', '/definitely-not-a-diff-program');
  const svc = service(dir), target = { kind: 'commit' as const, id: hash };
  const changes = await svc.changes(project, target);
  assert.deepEqual(changes.files.map(f => f.path).sort(), names.sort());
  for (const name of names) assert.match((await svc.diff(project, target, name)).diff, /\+literal/);
});

test('last-fetch metadata is separate from the time Work was refreshed', async () => {
  const { dir, project, repo } = setup();
  const fetchHead = path.join(repo, '.git', 'FETCH_HEAD');
  fs.writeFileSync(fetchHead, '');
  const when = new Date('2025-01-02T03:04:05Z');
  fs.utimesSync(fetchHead, when, when);
  const svc = service(dir);
  assert.equal((await svc.project(project, true)).fetchedAt, when.getTime());
  assert.equal((await svc.project(project, true)).fetchedAt, when.getTime(), 'a refresh is not a fetch');
});

test('Work status and diffs never execute configured clean or process filters', async () => {
  const { dir, project, repo } = setup();
  const folder = path.join(dir, 'filtered');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/filtered', folder, 'main');
  commit(folder, 'filtered.txt', 'before\n', 'filtered file');
  const marker = path.join(dir, 'filter-ran');
  const filter = path.join(dir, 'filter.sh');
  fs.writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(folder, '.gitattributes'), 'filtered.txt filter=Review.With.Dots\n');
  git(repo, 'config', 'filter.Review.With.Dots.clean', filter);
  git(repo, 'config', 'filter.Review.With.Dots.process', filter);
  git(repo, 'config', 'filter.Review.With.Dots.required', 'true');
  fs.writeFileSync(path.join(folder, 'filtered.txt'), 'after\n');
  const svc = service(dir), target = { kind: 'branch' as const, id: fs.realpathSync(folder) };
  const changes = await svc.changes(project, target);
  assert.ok(changes.files.some(f => f.path === 'filtered.txt'));
  assert.match((await svc.diff(project, target, 'filtered.txt')).diff, /\+after/);
  assert.equal(fs.existsSync(marker), false);
});

test('untracked summary work is capped, and selecting one diff does not read every untracked file', async () => {
  const { dir, project, repo } = setup();
  const folder = path.join(dir, 'many');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/many', folder, 'main');
  commit(folder, 'branch.txt', 'branch\n', 'branch change');
  for (let n = 0; n < 510; n++) fs.writeFileSync(path.join(folder, `${String(n).padStart(3, '0')}.txt`), 'new\n');
  const svc = service(dir), target = { kind: 'branch' as const, id: fs.realpathSync(folder) };
  await svc.project(project);
  const original = fs.openSync;
  let reads = 0;
  fs.openSync = ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).startsWith(fs.realpathSync(folder)) && /\d{3}\.txt$/.test(String(file))) reads++;
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof fs.openSync;
  try {
    const changes = await svc.changes(project, target);
    assert.equal(changes.files.length, 500);
    assert.equal(changes.truncated, true);
    assert.equal(reads, 500);
    reads = 0;
    await svc.diff(project, target, '001.txt');
    assert.equal(reads, 1, 'only the selected file is read');
  } finally { fs.openSync = original; }
});

test('dependency setup symlinks do not hide the branch diff', async () => {
  const { dir, project, repo } = setup();
  const folder = path.join(dir, 'linked-deps');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/linked-deps', folder, 'main');
  commit(folder, 'branch.txt', 'branch work\n', 'branch change');
  fs.symlinkSync(dir, path.join(folder, 'node_modules'), 'dir');
  const svc = service(dir), target = { kind: 'branch' as const, id: fs.realpathSync(folder) };
  const changes = await svc.changes(project, target);
  assert.equal(changes.basis, 'branch');
  assert.deepEqual(changes.files.map(f => f.path), ['branch.txt']);
  fs.writeFileSync(path.join(folder, 'new.txt'), 'new\n');
  assert.deepEqual((await svc.changes(project, target)).files.map(f => f.path), ['new.txt']);
});

test('cleanup preserves dirty submodules even with a dependency link that would allow forced removal', async () => {
  const { dir, project, repo } = setup();
  const source = path.join(dir, 'submodule-source');
  fs.mkdirSync(source);
  git(source, 'init', '-q');
  commit(source, 'nested.txt', 'committed\n', 'nested base');
  const folder = path.join(dir, 'data', 'submodule-worktree');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/submodule', folder, 'main');
  git(folder, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub');
  git(folder, 'commit', '-q', '-am', 'add submodule');
  merge(repo, 'feat/submodule', 'Merge feat/submodule (Hal): nested work');
  fs.writeFileSync(path.join(folder, 'sub', 'nested.txt'), 'uncommitted nested work\n');
  fs.symlinkSync(dir, path.join(folder, 'node_modules'), 'dir');
  const svc = service(dir);
  assert.ok(!((await svc.project(project, true)).cleanup.folders.some(f => f.branch === 'feat/submodule')));
  const result = await svc.cleanup(project, { projectId: project.id, folders: [folder], branches: ['feat/submodule'], forceFolders: [] });
  assert.deepEqual(result.removed, { folders: [], branches: [] });
  assert.equal(fs.readFileSync(path.join(folder, 'sub', 'nested.txt'), 'utf8'), 'uncommitted nested work\n');
  // Removing the index entries must not bypass protection for an initialized submodule.
  git(folder, 'rm', '--cached', '-f', 'sub', '.gitmodules');
  fs.unlinkSync(path.join(folder, '.gitmodules'));
  const forced = await svc.cleanup(project, { projectId: project.id, folders: [folder], branches: [], forceFolders: [folder] });
  assert.deepEqual(forced.removed.folders, []);
  assert.equal(fs.readFileSync(path.join(folder, 'sub', 'nested.txt'), 'utf8'), 'uncommitted nested work\n');
});

test('old active branches retain their owner lanes when recent main history fills the graph window', async () => {
  const { dir, repo, project } = setup();
  const agents = ['fen', 'ada'].map(id => ({ id, name: id === 'fen' ? 'Fen' : 'Ada', role: 'dev', status: 'idle', worktree: null })) as unknown as Agent[];
  const tips: string[] = [];
  for (const [i, agent] of agents.entries()) {
    const folder = path.join(dir, 'data', 'agents', agent.id, 'workspace', 'branch');
    git(repo, 'worktree', 'add', '-q', '-b', `feat/${agent.id}-old`, folder, 'main');
    if (i) commit(folder, `${agent.id}-1.txt`, 'one', 'old branch parent');
    tips.push(commit(folder, `${agent.id}-2.txt`, 'two', 'old branch tip'));
  }
  for (let i = 0; i < 25; i++) commit(repo, 'recent.txt', String(i), `recent main ${i}`);
  const view = await service(dir, agents).project(project, true);
  assert.equal(view.graph.length, 20);
  assert.ok(view.graph.some(c => c.head && c.key === 'main'), 'main is retained');
  for (const [i, tip] of tips.entries()) {
    const row = view.graph.find(c => c.hash === tip)!;
    assert.ok(row, 'old active tip is visible');
    assert.equal(row.key, agents[i].name);
    assert.ok(row.lane > 0);
    assert.equal(view.laneOwners[row.key!], agents[i].id);
    assert.ok(view.graphEdges.some(e => e.key === agents[i].name));
  }
  const positions = new Map(view.graph.map((c, i) => [c.hash, i]));
  for (const [i, c] of view.graph.entries()) {
    if (c.key === 'main') assert.equal(c.lane, 0, 'sparse context never shifts main to a side lane');
    for (const parent of c.parents) if (positions.has(parent)) assert.ok(positions.get(parent)! > i, 'a visible parent stays below its child');
  }
});

test('sparse graph retains Git ancestry order across omitted commits in stacked active branches', async () => {
  const { dir, repo, project } = setup();
  const tips: string[] = [];
  for (const [name, base] of [['a', 'main'], ['b', 'feat/stack-a']]) {
    const folder = path.join(dir, 'data', 'agents', name, 'workspace', 'branch');
    git(repo, 'worktree', 'add', '-q', '-b', `feat/stack-${name}`, folder, base);
    for (let i = 0; i < 4; i++) commit(folder, `${name}.txt`, String(i), `stack ${name} ${i}`);
    tips.push(git(folder, 'rev-parse', 'HEAD'));
  }
  for (let i = 0; i < 26; i++) commit(repo, 'recent.txt', String(i), `recent main ${i}`);
  const view = await service(dir).project(project, true);
  const index = (hash: string) => view.graph.findIndex(c => c.hash === hash);
  assert.equal(view.graph.length, 20);
  assert.ok(index(tips[1]) >= 0 && index(tips[0]) > index(tips[1]), 'descendant B appears before ancestor A even with a gap');
  const onMain = new Set(git(repo, 'rev-list', '--first-parent', 'main').split('\n'));
  for (const c of view.graph) if (onMain.has(c.hash)) assert.equal(c.lane, 0);
});
