import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MergeRecords, WorkService } from '../server/work.ts';
import { WorkOwners, ownableBranch, reflogMerges } from '../server/workOwners.ts';
import { isStaleBranch, STALE_IDLE_MS, type WorkBranch, type WorkCommit, type WorkMerge, type WorkProject } from '../shared/work.ts';
import type { Agent, Project } from '../shared/types.ts';
import { branchCount, mergedBranch, rowOwners, rowText, shortBranch, splitBranches, tagNames, tipLabels } from '../web/work/graphRows.ts';
import { tempDir } from './helpers.ts';

// The calm Work graph (ACH-D34): labels only on open tips, "Merged <branch>" rows, owners recorded
// as they happen (never guessed), stale branches folded.

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, args: string[], env: Record<string, string> = {}) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...ENV, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd: string, file: string, message: string, env: Record<string, string> = {}) => {
  fs.writeFileSync(path.join(cwd, file), message);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], env);
  return git(cwd, ['rev-parse', 'HEAD']);
};

const branch = (b: Partial<WorkBranch>): WorkBranch => ({ branch: 'feat/x', folder: `/w/${b.branch ?? 'x'}`, inPlace: false, state: 'open', ahead: 1, behind: 0, changed: 0, untracked: 0, refs: [], ...b });
const NOW = 1_800_000_000_000;

test('stale: over a day idle or 40+ behind folds; working, in review or uncommitted changes never do, approved only when far behind', () => {
  const recent = { hash: 'a', subject: 's', at: NOW - 1000 };
  const old = { hash: 'a', subject: 's', at: NOW - STALE_IDLE_MS - 1 };
  assert.equal(isStaleBranch(branch({ last: recent }), NOW), false);
  assert.equal(isStaleBranch(branch({ last: old }), NOW), true);
  assert.equal(isStaleBranch(branch({ last: recent, behind: 40 }), NOW), true);
  assert.equal(isStaleBranch(branch({ last: recent, behind: 39 }), NOW), false);
  assert.equal(isStaleBranch(branch({ last: old, state: 'working' }), NOW), false);
  assert.equal(isStaleBranch(branch({ last: old, state: 'reviewing' }), NOW), false);
  assert.equal(isStaleBranch(branch({ last: old, changed: 1 }), NOW), false);
  assert.equal(isStaleBranch(branch({ last: old, untracked: 2 }), NOW), false);
  assert.equal(isStaleBranch(branch({ last: old, state: 'approved', behind: 47 }), NOW), true, 'approved but left behind still folds');
  assert.equal(isStaleBranch(branch({ last: old, state: 'approved' }), NOW), false, 'an approved branch waiting to merge stays in view');
  const { open, older } = splitBranches({ inProgress: [branch({ branch: 'a', last: recent }), branch({ branch: 'b', last: old })] }, NOW);
  assert.deepEqual([open.map(b => b.branch), older.map(b => b.branch)], [['a'], ['b']]);
});

test('labels only on open tips: merged, main, stale and tags get none; a branch and its remote copy count once', () => {
  const open = [branch({ branch: 'fix/header-spacing', agentName: 'Ada' })];
  const c = (refs: WorkCommit['refs']) => ({ refs });
  assert.deepEqual(tipLabels(c([{ kind: 'local', name: 'main' }, { kind: 'local', name: 'fix/header-spacing', remote: 'origin/fix/header-spacing' }, { kind: 'remote', name: 'origin/fix/header-spacing' }]), open).map(b => b.branch), ['fix/header-spacing']);
  assert.deepEqual(tipLabels(c([{ kind: 'local', name: 'fix/work-colours' }, { kind: 'remote', name: 'origin/main' }, { kind: 'tag', name: 'fix/header-spacing' }]), open), [], 'a merged branch, remote main and a tag named like a branch get no label');
  const local = c([{ kind: 'local', name: 'fix/header-spacing' }]);
  const pushed = c([{ kind: 'remote', name: 'origin/fix/header-spacing' }]);
  assert.deepEqual(tipLabels(pushed, open, [local, pushed]), [], 'an older pushed copy below the local tip gets no second label');
  assert.deepEqual(tipLabels(pushed, open, [pushed]).map(b => b.branch), ['fix/header-spacing'], 'a remote copy alone still labels');
  assert.deepEqual(tagNames(c([{ kind: 'tag', name: 'v0.3.1' }, { kind: 'local', name: 'main' }])), ['v0.3.1']);
  assert.equal(shortBranch('fix/header-spacing'), 'header-spacing');
  assert.equal(shortBranch('feat/ui-rules-keys-tabs'), 'ui-rules-keys-tabs');
  assert.equal(shortBranch('ada/experiment'), 'ada/experiment', 'only conventional prefixes are dropped');
});

test('a merge row reads "Merged <branch>": our record first, else git\'s own subject; other rows keep their subject', () => {
  const project = { merged: [{ branch: 'fix/restore-work-view-hal', hash: 'm1' } as WorkMerge] };
  const row = (hash: string, subject: string, merge = true) => rowText(project, { hash, subject, merge });
  assert.deepEqual(row('m1', 'Merge approved Work redesign (ACH-D23, ACH-D24)'), { text: 'Merged restore-work-view-hal', merge: true });
  assert.deepEqual(row('m2', 'Merge fix/work-colours: restore Work ownership and status colours (ACH-D29)'), { text: 'Merged work-colours', merge: true });
  assert.deepEqual(row('m3', 'Merge fix/lost-reports-v3 (Cy, Ada, Fen): late answers'), { text: 'Merged lost-reports-v3', merge: true });
  assert.deepEqual(row('m4', "Merge branch 'feat/thing' into main"), { text: 'Merged thing', merge: true });
  assert.equal(mergedBranch(project, { hash: 'm5', subject: 'Merge remote-tracking branch \'origin/main\'', merge: true }), 'origin/main');
  assert.deepEqual(row('m6', 'Merge pull request from somewhere'), { text: 'Merge pull request from somewhere', merge: false }, 'an unknown merge keeps its subject');
  assert.deepEqual(row('c1', 'Merge fix/x: looks like a merge', false), { text: 'Merge fix/x: looks like a merge', merge: false }, 'a single-parent commit is not a merge row');
});

test('row owners: up to three, ids only when aligned, and nothing at all when nobody was recorded (no "?")', () => {
  assert.deepEqual(rowOwners({ names: [], agentIds: [] }), []);
  assert.deepEqual(rowOwners({ names: ['Cy', 'Ada', 'Fen', 'Hal'], agentIds: ['c', 'a', 'f', 'h'] }).map(o => o.name), ['Cy', 'Ada', 'Fen']);
  assert.deepEqual(rowOwners({ names: ['Former', 'Ada'], agentIds: ['a'] }), [{ name: 'Former' }, { name: 'Ada' }], 'misaligned ids are not paired with the wrong names');
  assert.equal(branchCount(1, 4), '1 open · 4 older');
  assert.equal(branchCount(0, 4), '4 older');
  assert.equal(branchCount(0, 0), 'No open branches');
});

test('main\'s reflog: merges with the main before them; commits, pulls of a remote and main itself are not branch work', () => {
  const text = [
    'h5\x1fmerge fix/header-spacing: Fast-forward\x1fmain@{1700000500}',
    'h4\x1fcommit (merge): Merge fix/work-colours: restore\x1fmain@{1700000400}',
    'h3\x1fmerge fix/lost-reports-v3: Merge made by the \'ort\' strategy.\x1fmain@{1700000300}',
    'h2\x1fpull --no-rebase --no-edit origin main: Merge made by the \'ort\' strategy.\x1fmain@{1700000200}',
    'h1\x1fmerge origin/main: Fast-forward\x1fmain@{1700000100}',
    'h0\x1fcommit: init\x1fmain@{1700000000}',
  ].join('\n');
  assert.deepEqual(reflogMerges(text, 'main').map(m => [m.branch, m.hash, m.before, m.fastForward, m.at]), [
    ['fix/header-spacing', 'h5', 'h4', true, 1700000500000],
    ['fix/lost-reports-v3', 'h3', 'h2', false, 1700000300000],
  ]);
  assert.equal(ownableBranch('main'), false);
  assert.equal(ownableBranch('backup/pre-0.2.6'), false);
  assert.equal(ownableBranch('e8cbc40'), false, 'a detached checkout is not a branch');
  assert.equal(ownableBranch('fix/x'), true);
});

test('owner records: a commit keeps its first owner, a reused branch name is not credited for an earlier merge, and they persist', () => {
  const dir = tempDir('owners');
  const owners = new WorkOwners(dir);
  owners.noteBranch('p', 'fix/x', { agentId: 'cy', name: 'Cy' }, 1000);
  owners.noteCommits('p', ['a', 'b'], { agentId: 'cy', name: 'Cy' });
  owners.noteCommits('p', ['b', 'c'], { agentId: 'fen', name: 'Fen' });
  assert.deepEqual(['a', 'b', 'c'].map(h => owners.commitOwner('p', h)?.name), ['Cy', 'Cy', 'Fen']);
  owners.noteBranch('p', 'fix/x', { agentId: 'fen', name: 'Fen' }, 5000);
  assert.equal(owners.branchOwner('p', 'fix/x')?.name, 'Fen', 'the latest owner of the name');
  assert.equal(owners.branchOwner('p', 'fix/x', 2000), undefined, 'not the one who had it at 2000');
  owners.noteBranch('p', 'main', { agentId: 'cy', name: 'Cy' });
  assert.equal(owners.branchOwner('p', 'main'), undefined);
  owners.markSeen('p', ['e1']);
  owners.save();
  const again = new WorkOwners(dir);
  assert.equal(again.commitOwner('p', 'a')?.name, 'Cy');
  assert.equal(again.seen('p', 'e1'), true);
  assert.equal(fs.existsSync(path.join(dir, 'owners.json')), true);
  const memory = new WorkOwners(null);
  memory.noteBranch('p', 'fix/y', { agentId: 'cy', name: 'Cy' });
  memory.save();
  assert.equal(memory.branchOwner('p', 'fix/y')?.name, 'Cy', 'kept in memory without a folder');
});

/** A repository with main, and Fen's and Cy's homes under the data folder. */
function setup() {
  const dir = tempDir('calm');
  const repo = path.join(dir, 'app');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  commit(repo, 'README.md', 'init');
  const home = (id: string) => { const h = path.join(dir, 'data', 'agents', id, 'workspace'); fs.mkdirSync(h, { recursive: true }); return h; };
  const agents = [
    { id: 'fen', name: 'Fen', role: 'dev', status: 'idle', worktree: null },
    { id: 'cy', name: 'Cy', role: 'dev', status: 'idle', worktree: null },
    { id: 'ada', name: 'Ada', role: 'dev', status: 'idle', worktree: null },
  ] as unknown as Agent[];
  const owners = new WorkOwners(path.join(dir, 'data', 'work'));
  const work = new WorkService(new MergeRecords(path.join(dir, 'data', 'work')), { agents: () => agents, messages: () => [], agentsDir: path.join(dir, 'data', 'agents'), dataDir: path.join(dir, 'data'), knownRef: () => true, owners });
  const project = { id: 'p1', name: 'app', path: repo, exists: true, isGit: true } as unknown as Project;
  return { dir, repo, home, agents, work, project };
}

test('owners show for real: a fast-forward and a merge credit the agent whose folder had the branch, even after the branch is gone', async () => {
  const { repo, home, agents, work, project } = setup();
  // Fen works in a worktree under its home; the Work view sees it while it is open.
  const fenWt = path.join(home('fen'), 'wt-d');
  git(repo, ['worktree', 'add', '-q', '-b', 'fix/d', fenWt, 'main']);
  const d1 = commit(fenWt, 'd1.txt', 'd one');
  await work.project(project, true);
  const d2 = commit(fenWt, 'd2.txt', 'd two'); // made after the last look: the merge's range still has it
  // Cy makes a branch with plain git in its home; only the manager's hook sees it (no Work read before the merge).
  const cyWt = path.join(home('cy'), 'wt-e');
  git(repo, ['worktree', 'add', '-q', '-b', 'fix/e', cyWt, 'main']);
  work.noteBranch('p1', cyWt, 'fix/e', agents.find(a => a.id === 'ada')!);
  work.noteBranch('p1', cyWt, 'fix/e', agents.find(a => a.id === 'cy')!);
  const e1 = commit(cyWt, 'e1.txt', 'e one');
  // Merged into main: Fen's as a fast-forward, Cy's with a merge commit whose subject names nobody.
  git(repo, ['merge', '-q', '--ff-only', 'fix/d']);
  git(repo, ['merge', '-q', '--no-ff', 'fix/e', '-m', 'Merge fix/e: the e work']);
  const m = git(repo, ['rev-parse', 'HEAD']);
  for (const [wt, b] of [[fenWt, 'fix/d'], [cyWt, 'fix/e']]) { git(repo, ['worktree', 'remove', wt]); git(repo, ['branch', '-D', b]); }

  const view = await work.project(project, true);
  const by = (hash: string) => view.graph.find(c => c.hash === hash);
  assert.deepEqual([d1, d2].map(h => by(h)?.names), [['Fen'], ['Fen']], 'both fast-forwarded commits are Fen\'s');
  assert.deepEqual(by(d1)?.agentIds, ['fen']);
  assert.deepEqual(by(m)?.names, ['Cy'], 'Ada touching Cy\'s folder did not make it hers; the merge is Cy\'s');
  assert.deepEqual(by(e1)?.names, ['Cy']);
  assert.equal(by(e1)?.key, 'Cy', 'the merged lane keeps its owner\'s colour');
  assert.equal(view.laneOwners.Cy, 'cy');
  const init = view.graph.find(c => c.subject === 'init');
  assert.deepEqual(init?.names, [], 'a commit nobody recorded shows no owner');
});

test('a stale open branch takes no rows or lane in the graph but is still listed in progress', async () => {
  const { repo, home, work, project } = setup();
  const adaWt = path.join(home('ada'), 'wt-old');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/old', adaWt, 'main']);
  const oldDate = new Date(Date.now() - 3 * STALE_IDLE_MS).toISOString();
  const old = commit(adaWt, 'old.txt', 'old work', { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
  const freshWt = path.join(home('fen'), 'wt-new');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/new', freshWt, 'main']);
  const fresh = commit(freshWt, 'new.txt', 'new work');
  const view = await work.project(project, true);
  assert.ok(view.inProgress.some(b => b.branch === 'feat/old' && b.agentName === 'Ada'));
  assert.ok(!view.graph.some(c => c.hash === old), 'the stale tip is not drawn');
  assert.ok(view.graph.some(c => c.hash === fresh), 'a fresh open tip is');
  assert.equal(view.graphLanes, 2, 'main and the one fresh branch');
  const { older } = splitBranches(view as WorkProject, Date.now());
  assert.deepEqual(older.map(b => b.branch), ['feat/old']);
});

test('stacked branches: commits a lower branch still has are never credited to the one on top, whatever the order', async () => {
  const { repo, home, agents, work, project } = setup();
  // Fen's feat/x (2 commits); Cy's feat/y made from feat/x (1 commit). Fen's folder is gone, the branch kept.
  const fenWt = path.join(home('fen'), 'wt-x');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', fenWt, 'main']);
  const x1 = commit(fenWt, 'x1.txt', 'x one');
  const x2 = commit(fenWt, 'x2.txt', 'x two');
  git(repo, ['worktree', 'remove', fenWt]);
  const cyWt = path.join(home('cy'), 'wt-y');
  git(repo, ['worktree', 'add', '-q', '-b', 'feat/y', cyWt, 'feat/x']);
  const y1 = commit(cyWt, 'y1.txt', 'y one');
  await work.project(project, true);
  // Cy's branch is merged with a merge commit (which brings feat/x's commits in too).
  git(repo, ['merge', '-q', '--no-ff', 'feat/y', '-m', 'Merge feat/y: on top of x']);
  const m = git(repo, ['rev-parse', 'HEAD']);
  const view = await work.project(project, true);
  const by = (hash: string) => view.graph.find(c => c.hash === hash)?.names;
  assert.deepEqual(by(y1), ['Cy']);
  assert.deepEqual(by(m), ['Cy']);
  assert.deepEqual([by(x1), by(x2)], [[], []], 'feat/x still has them: not Cy\'s, left unknown rather than wrong');
  void agents;
});
