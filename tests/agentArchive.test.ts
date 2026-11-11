import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { archiveAgentHome, archiveDir, ARCHIVE_EXTRAS, ARCHIVE_META, ARCHIVE_TRANSCRIPT, findWorktrees, listArchive, move, slug, stamp } from '../server/agentArchive.ts';
import { Store } from '../server/store.ts';
import { harness, tempDir } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repository with one commit, and two linked worktrees inside `workspace`: one with changes, one clean. */
function repoWithWorktrees(workspace: string) {
  const repo = path.join(tempDir('archive-repo'), 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const dirty = path.join(workspace, 'wt-dirty');
  const clean = path.join(workspace, 'nested', 'wt-clean');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/dirty', dirty);
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/clean', clean);
  fs.writeFileSync(path.join(dirty, 'app.ts'), 'export const a = 2; // not committed\n');
  fs.writeFileSync(path.join(dirty, 'notes.txt'), 'untracked\n');
  return { repo, dirty, clean };
}

test('removing an agent moves its home to the archive with its transcript; nothing is deleted, and it is not loaded again', async () => {
  const h = harness();
  const nova = await h.manager.create({ name: 'Nova', engine: 'claude', projectId: null });
  h.manager.send(nova.id, 'Remember the release steps.');
  h.runner(nova.id).complete();
  fs.writeFileSync(path.join(nova.home, 'memory.md'), '# Nova\n- release steps\n');
  fs.mkdirSync(path.join(nova.home, 'workspace', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(nova.home, 'workspace', 'scripts', 'deploy.sh'), 'echo deploy\n');

  await h.manager.remove(nova.id);
  assert.ok(!fs.existsSync(nova.home), 'the live home is gone');
  const [archived] = h.manager.archivedAgents();
  assert.equal(archived.name, 'Nova');
  assert.equal(archived.id, nova.id);
  assert.match(path.basename(archived.dir), new RegExp(`^${nova.id}-nova-\\d{8}-\\d{6}$`));
  assert.equal(path.dirname(archived.dir), path.join(h.store.dataDir, 'archive', 'agents'));
  assert.equal(fs.readFileSync(path.join(archived.dir, 'memory.md'), 'utf8'), '# Nova\n- release steps\n');
  assert.ok(fs.existsSync(path.join(archived.dir, 'soul.md')));
  assert.equal(fs.readFileSync(path.join(archived.dir, 'workspace', 'scripts', 'deploy.sh'), 'utf8'), 'echo deploy\n');
  assert.match(fs.readFileSync(path.join(archived.dir, ARCHIVE_TRANSCRIPT), 'utf8'), /Remember the release steps/);
  assert.ok(fs.existsSync(path.join(archived.dir, ARCHIVE_META)));

  // The archive is never loaded as live agents.
  assert.equal(h.manager.snapshot().agents.some(a => a.id === nova.id), false);
  h.store.flush();
  const reloaded = new Store(h.store.dataDir);
  reloaded.load();
  assert.equal(reloaded.agents.has(nova.id), false);
});

test('archive folders never collide: the same agent, name and second get -2, -3', () => {
  const root = tempDir('archive-collide');
  const when = new Date('2026-11-10T07:51:23.234Z');
  assert.equal(stamp(when), '20261110-075123');
  assert.equal(slug('Ada / Lovelace!!'), 'ada-lovelace');
  assert.equal(slug('***'), 'agent');
  const first = archiveDir(root, 'id1', 'Ada', when);
  fs.mkdirSync(first);
  const second = archiveDir(root, 'id1', 'Ada', when);
  fs.mkdirSync(second);
  const third = archiveDir(root, 'id1', 'Ada', when);
  assert.deepEqual([first, second, third].map(d => path.basename(d)), ['id1-ada-20261110-075123', 'id1-ada-20261110-075123-2', 'id1-ada-20261110-075123-3']);

  // Two archives of the same agent at the same moment both keep their files.
  const home = path.join(tempDir('archive-home'), 'agents', 'id2');
  const archiveRoot = path.join(root, 'agents');
  for (const text of ['one', 'two']) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'soul.md'), text);
    archiveAgentHome({ home, archiveRoot, agent: { id: 'id2', name: 'Bo', role: 'dev', engine: 'claude', projectId: null }, now: when });
  }
  assert.deepEqual(listArchive(archiveRoot).map(a => fs.readFileSync(path.join(a.dir, 'soul.md'), 'utf8')).sort(), ['one', 'two']);
});

test('worktrees: one with uncommitted changes stays a working checkout in the archive; a clean one is unregistered', () => {
  const home = path.join(tempDir('archive-wt'), 'agents', 'fable');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const { repo, dirty, clean } = repoWithWorktrees(workspace);
  const archiveRoot = path.join(path.dirname(path.dirname(home)), 'archive', 'agents');

  const archived = archiveAgentHome({ home, archiveRoot, agent: { id: 'fable', name: 'Fable', role: 'dev', engine: 'claude', projectId: null } })!;
  const byPath = Object.fromEntries(archived.worktrees.map(w => [w.path, w]));
  assert.deepEqual(byPath[path.join('workspace', 'wt-dirty')], { path: path.join('workspace', 'wt-dirty'), repo: fs.realpathSync(repo), branch: 'feat/dirty', dirty: true, action: 'repaired' });
  assert.deepEqual(byPath[path.join('workspace', 'nested', 'wt-clean')], { path: path.join('workspace', 'nested', 'wt-clean'), repo: fs.realpathSync(repo), branch: 'feat/clean', dirty: false, action: 'unregistered' });
  assert.ok(!fs.existsSync(dirty) && !fs.existsSync(clean), 'both moved');

  // The dirty one works where it is now, with every change.
  const movedDirty = path.join(archived.dir, 'workspace', 'wt-dirty');
  assert.equal(fs.readFileSync(path.join(movedDirty, 'app.ts'), 'utf8'), 'export const a = 2; // not committed\n');
  assert.match(git(movedDirty, 'status', '--porcelain'), / M app\.ts[\s\S]*\?\? notes\.txt/);
  const list = git(repo, 'worktree', 'list', '--porcelain');
  assert.ok(list.includes(`worktree ${fs.realpathSync(movedDirty)}`), 'the repository knows its new place');
  assert.ok(!list.includes(dirty) && !list.includes(clean), 'no dead entries for the old places');

  // The clean one is unregistered: its files are in the archive, and its branch is free again.
  assert.equal(fs.readFileSync(path.join(archived.dir, 'workspace', 'nested', 'wt-clean', 'app.ts'), 'utf8'), 'export const a = 1;\n');
  assert.ok(!list.includes('feat/clean'));
  git(repo, 'worktree', 'add', '-q', path.join(tempDir('archive-reuse'), 'again'), 'feat/clean');

  const [meta] = listArchive(archiveRoot);
  assert.deepEqual(meta.worktrees.map(w => [w.dirty, w.action]).sort(), [[false, 'unregistered'], [true, 'repaired']]);
});

test('a repository kept inside the workspace moves with its worktrees, which keep working in the archive', () => {
  const home = path.join(tempDir('archive-own'), 'agents', 'kai');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const repo = path.join(workspace, 'clone');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'worktree', 'add', '-q', '-b', 'side', path.join(workspace, 'side'));
  const archived = archiveAgentHome({ home, archiveRoot: path.join(path.dirname(path.dirname(home)), 'archive', 'agents'), agent: { id: 'kai', name: 'Kai', role: 'dev', engine: 'claude', projectId: null } })!;
  assert.deepEqual(archived.worktrees.map(w => [w.path, w.dirty, w.action]), [[path.join('workspace', 'side'), false, 'repaired']]);
  const movedRepo = path.join(archived.dir, 'workspace', 'clone');
  const list = git(movedRepo, 'worktree', 'list', '--porcelain');
  assert.ok(list.includes(`worktree ${fs.realpathSync(path.join(archived.dir, 'workspace', 'side'))}`));
  assert.equal(git(path.join(archived.dir, 'workspace', 'side'), 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'side');
});

test('worktree search does not follow symlinks or look inside node_modules', () => {
  const home = path.join(tempDir('archive-links'), 'agents', 'cy');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const elsewhere = path.join(tempDir('archive-elsewhere'), 'ws');
  fs.mkdirSync(elsewhere, { recursive: true });
  const { dirty } = repoWithWorktrees(elsewhere);
  fs.symlinkSync(dirty, path.join(workspace, 'linked-worktree'));
  fs.mkdirSync(path.join(workspace, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'node_modules', 'pkg', '.git'), 'gitdir: /nowhere/.git/worktrees/x\n');
  assert.deepEqual(findWorktrees(home), []);
});

const agentInfo = (id: string, name: string) => ({ id, name, role: 'dev', engine: 'claude', projectId: null });

test('only the archived worktree is unregistered: another one on an unmounted path keeps its registration and staged index', () => {
  const base = tempDir('archive-probe');
  const home = path.join(base, 'data', 'agents', 'A');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  // Someone else's worktree, with a staged file, on a drive that is not mounted right now.
  const external = path.join(base, 'ext', 'other');
  git(repo, 'worktree', 'add', '-q', '-b', 'other', external);
  fs.writeFileSync(path.join(external, 'staged.txt'), 'staged\n');
  git(external, 'add', 'staged.txt');
  const unmounted = path.join(base, 'ext-unmounted');
  fs.renameSync(path.join(base, 'ext'), unmounted);
  // The agent's own clean worktree.
  git(repo, 'worktree', 'add', '-q', '-b', 'mine', path.join(workspace, 'mine'));

  const archived = archiveAgentHome({ home, archiveRoot: path.join(base, 'data', 'archive', 'agents'), agent: agentInfo('A', 'Ada') })!;
  assert.deepEqual(archived.worktrees.map(w => [w.path, w.action]), [[path.join('workspace', 'mine'), 'unregistered']]);
  const admin = path.join(repo, '.git', 'worktrees');
  assert.deepEqual(fs.readdirSync(admin), ['other'], 'only the archived worktree\'s registration is gone');
  assert.ok(fs.existsSync(path.join(admin, 'other', 'index')), 'the other worktree keeps its index');
  // Mounted again, it is exactly as it was, staged file included.
  fs.renameSync(unmounted, path.join(base, 'ext'));
  assert.equal(git(external, 'status', '--porcelain').trim(), 'A  staged.txt');
});

test('other agents\' live worktrees of the same repository are untouched', () => {
  const base = tempDir('archive-others');
  const homeA = path.join(base, 'agents', 'A');
  const homeB = path.join(base, 'agents', 'B');
  fs.mkdirSync(path.join(homeA, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(homeB, 'workspace'), { recursive: true });
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'worktree', 'add', '-q', '-b', 'a-clean', path.join(homeA, 'workspace', 'wt'));
  const bClean = path.join(homeB, 'workspace', 'wt');
  const bDirty = path.join(homeB, 'workspace', 'wt2');
  git(repo, 'worktree', 'add', '-q', '-b', 'b-clean', bClean);
  git(repo, 'worktree', 'add', '-q', '-b', 'b-dirty', bDirty);
  fs.writeFileSync(path.join(bDirty, 'a.txt'), 'changed\n');

  archiveAgentHome({ home: homeA, archiveRoot: path.join(base, 'archive', 'agents'), agent: agentInfo('A', 'Ada') });
  const list = git(repo, 'worktree', 'list', '--porcelain');
  assert.ok(list.includes(`worktree ${fs.realpathSync(bClean)}`) && list.includes(`worktree ${fs.realpathSync(bDirty)}`));
  assert.ok(!list.includes('a-clean'));
  assert.equal(git(bDirty, 'status', '--porcelain').trim(), 'M a.txt');
  assert.equal(git(bClean, 'status', '--porcelain').trim(), '');
});

test('a worktree is found at any depth', () => {
  const home = path.join(tempDir('archive-deep'), 'agents', 'D');
  const deep = path.join(home, 'workspace', 'a', 'b', 'c', 'd', 'e', 'f');
  fs.mkdirSync(deep, { recursive: true });
  const { repo } = (() => {
    const r = path.join(tempDir('archive-deep-repo'), 'repo');
    fs.mkdirSync(r, { recursive: true });
    git(r, 'init', '-q', '-b', 'main');
    git(r, 'commit', '-q', '--allow-empty', '-m', 'x');
    return { repo: r };
  })();
  git(repo, 'worktree', 'add', '-q', '-b', 'deep', path.join(deep, 'wt'));
  assert.deepEqual(findWorktrees(home).map(w => path.relative(home, w.dir)), [path.join('workspace', 'a', 'b', 'c', 'd', 'e', 'f', 'wt')]);
});

test('across file systems the folder is copied, then the original removed; a failed copy is cleaned up and the original kept', () => {
  const base = tempDir('archive-exdev');
  const exdev = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
  const from = path.join(base, 'home');
  fs.mkdirSync(path.join(from, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(from, 'memory.md'), 'kept\n');
  fs.symlinkSync('/nowhere', path.join(from, 'workspace', 'link'));

  const to = path.join(base, 'archive', 'a');
  move(from, to, { rename: exdev, copy: (f, t) => fs.cpSync(f, t, { recursive: true, verbatimSymlinks: true }) });
  assert.ok(!fs.existsSync(from));
  assert.equal(fs.readFileSync(path.join(to, 'memory.md'), 'utf8'), 'kept\n');
  assert.equal(fs.readlinkSync(path.join(to, 'workspace', 'link')), '/nowhere', 'symlinks stay links');

  // A copy that fails part way: the partial copy goes, the original stays whole.
  const from2 = path.join(base, 'home2');
  fs.mkdirSync(from2);
  fs.writeFileSync(path.join(from2, 'soul.md'), 'soul\n');
  const to2 = path.join(base, 'archive', 'b');
  const partial = (_f: string, t: string) => { fs.mkdirSync(t, { recursive: true }); fs.writeFileSync(path.join(t, 'half'), 'x'); throw new Error('disk full'); };
  assert.throws(() => move(from2, to2, { rename: exdev, copy: partial }), /disk full/);
  assert.ok(!fs.existsSync(to2), 'the partial copy is removed');
  assert.equal(fs.readFileSync(path.join(from2, 'soul.md'), 'utf8'), 'soul\n', 'the original is untouched');
});

test('if the archive cannot be written, the agent is not removed', async () => {
  const h = harness();
  const nova = await h.manager.create({ name: 'Nova', engine: 'claude', projectId: null });
  fs.writeFileSync(path.join(nova.home, 'memory.md'), 'keep\n');
  // A file where the archive folder should go: the move cannot happen.
  fs.writeFileSync(path.join(h.store.dataDir, 'archive'), 'not a folder');
  await assert.rejects(h.manager.remove(nova.id));
  assert.ok(h.store.agents.has(nova.id), 'still an agent');
  assert.equal(fs.readFileSync(path.join(nova.home, 'memory.md'), 'utf8'), 'keep\n', 'its home is where it was');
  assert.equal(h.manager.archivedAgents().length, 0);
});

test('an agent\'s attachments are archived with it, not deleted', async () => {
  const h = harness();
  const nova = await h.manager.create({ name: 'Nova', engine: 'claude', projectId: null });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const image = h.manager.saveAttachment(nova.id, png, 'screen.png');
  await h.manager.remove(nova.id);
  const [archived] = h.manager.archivedAgents();
  assert.deepEqual(fs.readFileSync(path.join(archived.dir, '.archive-extras', 'attachments', image.id)), png);
  assert.deepEqual(archived.extras, [{ name: 'attachments', path: path.join('.archive-extras', 'attachments'), action: 'moved' }]);
  assert.ok(!fs.existsSync(path.join(h.store.dataDir, 'attachments', nova.id)));
});

/** Rhea's probe: a home with its own top-level attachments/ folder, and the agent's attachments outside it. */
function homeWithAttachmentsFolder(tag: string) {
  const base = tempDir(`archive-${tag}`);
  const home = path.join(base, 'data', 'agents', 'A');
  fs.mkdirSync(path.join(home, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(home, 'soul.md'), 'soul');
  fs.writeFileSync(path.join(home, 'attachments', 'home-file.txt'), 'precious home file');
  const extra = path.join(base, 'data', 'attachments', 'A');
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'img.png'), 'img');
  return { base, home, extra, archiveRoot: path.join(base, 'data', 'archive', 'agents') };
}
const probeAgent = { id: 'A', name: 'Ada', role: 'dev', engine: 'claude', projectId: null };
const exdevFor = (match: string) => (f: string, t: string) => {
  if (f.includes(match)) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
  fs.renameSync(f, t);
};

test('extras go under .archive-extras/, never onto a folder of the same name in the home', () => {
  const p = homeWithAttachmentsFolder('extras-same');
  const record = archiveAgentHome({ home: p.home, archiveRoot: p.archiveRoot, agent: probeAgent, extras: [{ from: p.extra, name: 'attachments' }] })!;
  assert.ok(!fs.existsSync(p.home), 'the home moved');
  assert.equal(fs.readFileSync(path.join(record.dir, 'attachments', 'home-file.txt'), 'utf8'), 'precious home file', 'the home\'s own folder is untouched');
  assert.equal(fs.readFileSync(path.join(record.dir, ARCHIVE_EXTRAS, 'attachments', 'img.png'), 'utf8'), 'img');
  assert.ok(!fs.existsSync(p.extra));
  const meta = JSON.parse(fs.readFileSync(path.join(record.dir, ARCHIVE_META), 'utf8'));
  assert.deepEqual(meta.extras, [{ name: 'attachments', path: path.join(ARCHIVE_EXTRAS, 'attachments'), action: 'moved' }]);

  // Across file systems too: the extra is copied beside the home's folder, not into it.
  const q = homeWithAttachmentsFolder('extras-xdev');
  const copied = archiveAgentHome({
    home: q.home, archiveRoot: q.archiveRoot, agent: probeAgent, extras: [{ from: q.extra, name: 'attachments' }],
    ops: { rename: exdevFor(`${path.sep}attachments${path.sep}A`), copy: (f, t) => fs.cpSync(f, t, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }) },
  })!;
  assert.equal(fs.readFileSync(path.join(copied.dir, 'attachments', 'home-file.txt'), 'utf8'), 'precious home file');
  assert.equal(fs.readFileSync(path.join(copied.dir, ARCHIVE_EXTRAS, 'attachments', 'img.png'), 'utf8'), 'img');
});

test('an extra that fails to move is recorded, not thrown after the home moved; nothing that was there is deleted', () => {
  const p = homeWithAttachmentsFolder('extras-fail');
  // Rhea's second probe: EXDEV for the extra, then the copy fails part way.
  const copy = (_f: string, t: string) => {
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, 'half'), 'x');
    throw Object.assign(new Error('EACCES: permission denied (simulated mid-copy)'), { code: 'EACCES' });
  };
  const record = archiveAgentHome({ home: p.home, archiveRoot: p.archiveRoot, agent: probeAgent, extras: [{ from: p.extra, name: 'attachments' }], ops: { rename: exdevFor(`${path.sep}attachments${path.sep}A`), copy } })!;
  assert.ok(record, 'no throw');
  assert.ok(!fs.existsSync(p.home), 'the home is in the archive');
  assert.equal(fs.readFileSync(path.join(record.dir, 'attachments', 'home-file.txt'), 'utf8'), 'precious home file', 'the home\'s attachments/ survives');
  assert.ok(!fs.existsSync(path.join(record.dir, ARCHIVE_EXTRAS, 'attachments')), 'the partial copy, which the move made, is cleaned up');
  assert.equal(fs.readFileSync(path.join(p.extra, 'img.png'), 'utf8'), 'img', 'the original attachments are kept');
  const meta = JSON.parse(fs.readFileSync(path.join(record.dir, ARCHIVE_META), 'utf8'));
  assert.equal(meta.extras.length, 1);
  assert.equal(meta.extras[0].action, 'failed');
  assert.equal(meta.extras[0].path, p.extra);
  assert.match(meta.extras[0].error, /EACCES/);
  assert.equal(listArchive(p.archiveRoot).length, 1, 'it is listed in the archive');
});

test('a failed cross-disk copy never removes a destination that was already there', () => {
  const base = tempDir('archive-existing');
  const from = path.join(base, 'from');
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'a'), 'a');
  const to = path.join(base, 'to');
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'keep'), 'precious');
  const exdev = () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
  assert.throws(() => move(from, to, { rename: exdev, copy: () => { throw new Error('EEXIST'); } }), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(to, 'keep'), 'utf8'), 'precious');
  assert.equal(fs.readFileSync(path.join(from, 'a'), 'utf8'), 'a');
});

test('a transcript that cannot be copied is recorded, and the live one is kept', async () => {
  const p = homeWithAttachmentsFolder('transcript');
  const transcript = path.join(p.base, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  // A folder already at the transcript's place in the home makes the copy fail.
  fs.mkdirSync(path.join(p.home, ARCHIVE_TRANSCRIPT));
  const record = archiveAgentHome({ home: p.home, archiveRoot: p.archiveRoot, agent: probeAgent, transcript })!;
  assert.ok(record.transcriptError);
  assert.ok(fs.existsSync(path.join(record.dir, ARCHIVE_META)), 'metadata is still written');
  assert.ok(fs.existsSync(transcript));
});

test('the worktree search says so when it stops at its folder limit', () => {
  const root = tempDir('archive-visits');
  // A long chain of folders is cheaper to make than 50,000 siblings and hits the same limit.
  let dir = root;
  for (let i = 0; i < 120; i++) { dir = path.join(dir, 'd'); }
  fs.mkdirSync(dir, { recursive: true });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    findWorktrees(root, 50);
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 1, 'once');
  assert.match(warnings[0], /stopped looking for worktrees .* after 50 folders/);
});

test('an agent with no home still has its transcript and attachments archived, in a fresh folder', async () => {
  const base = tempDir('archive-nohome');
  const transcript = path.join(base, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{"id":"1"}\n');
  const extra = path.join(base, 'attachments', 'A');
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'img.png'), 'img');
  const archiveRoot = path.join(base, 'archive');
  const record = archiveAgentHome({ home: path.join(base, 'agents', 'A'), archiveRoot, agent: probeAgent, transcript, extras: [{ from: extra, name: 'attachments' }] })!;
  assert.equal(record.noHome, true);
  assert.equal(fs.readFileSync(path.join(record.dir, ARCHIVE_TRANSCRIPT), 'utf8'), '{"id":"1"}\n');
  assert.equal(fs.readFileSync(path.join(record.dir, ARCHIVE_EXTRAS, 'attachments', 'img.png'), 'utf8'), 'img');
  assert.deepEqual(record.worktrees, []);
  assert.equal(listArchive(archiveRoot)[0].noHome, true, 'listed, with its metadata');
  // With nothing of the agent's anywhere, there is nothing to archive.
  assert.equal(archiveAgentHome({ home: path.join(base, 'agents', 'B'), archiveRoot, agent: { ...probeAgent, id: 'B' }, transcript: path.join(base, 'none.jsonl') }), null);

  // Through the manager: an agent whose home folder is gone keeps its transcript and attachments.
  const h = harness();
  const nova = await h.manager.create({ name: 'Nova', engine: 'claude', projectId: null });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const image = h.manager.saveAttachment(nova.id, png, 'screen.png');
  h.store.appendEntry({ id: 'e1', agentId: nova.id, kind: 'user', text: 'hello', ts: Date.now() } as never);
  fs.rmSync(nova.home, { recursive: true, force: true });
  await h.manager.remove(nova.id);
  const [archived] = h.manager.archivedAgents();
  assert.equal(archived.noHome, true);
  assert.match(fs.readFileSync(path.join(archived.dir, ARCHIVE_TRANSCRIPT), 'utf8'), /"hello"/);
  assert.deepEqual(fs.readFileSync(path.join(archived.dir, ARCHIVE_EXTRAS, 'attachments', image.id)), png);
});

test('a failed .archived.json write is reported, not thrown after the home moved; the live transcript is kept', async () => {
  const p = homeWithAttachmentsFolder('meta-fail');
  // A folder where .archived.json goes makes the write fail, as a full disk would.
  fs.mkdirSync(path.join(p.home, ARCHIVE_META));
  const transcript = path.join(p.base, 'transcript.jsonl');
  fs.writeFileSync(transcript, '{}\n');
  const record = archiveAgentHome({ home: p.home, archiveRoot: p.archiveRoot, agent: probeAgent, transcript, extras: [{ from: p.extra, name: 'attachments' }] })!;
  assert.ok(record.metaError, 'reported');
  assert.ok(!fs.existsSync(p.home), 'the home is in the archive');
  assert.equal(fs.readFileSync(path.join(record.dir, 'soul.md'), 'utf8'), 'soul');

  // Through the manager: the agent is removed, and its live transcript is not deleted.
  const h = harness();
  const nova = await h.manager.create({ name: 'Nova', engine: 'claude', projectId: null });
  h.store.appendEntry({ id: 'e1', agentId: nova.id, kind: 'user', text: 'hello', ts: Date.now() } as never);
  fs.mkdirSync(path.join(nova.home, ARCHIVE_META), { recursive: true });
  await h.manager.remove(nova.id);
  assert.ok(!h.store.agents.has(nova.id));
  assert.ok(fs.existsSync(path.join(h.store.dataDir, 'transcripts', `${nova.id}.jsonl`)), 'transcript kept');
});
