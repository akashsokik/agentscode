import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HttpError } from '../server/errors.ts';
import { deriveCode, INDEX_LIMIT, parseRefs, ProjectRefs, refIndex, renderRef, type RefEntry } from '../server/projectRefs.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

const status = (e: unknown) => (e instanceof HttpError ? e.status : 0);
const decision = (title: string, extra: Record<string, unknown> = {}) => ({ title, decision: `${title}, in full.`, why: 'The user said so.', decidedBy: 'You', addedBy: 'Cy', ...extra });
const note = (title: string) => ({ title, body: `${title}, in full.`, author: 'Cy', addedBy: 'Cy' });

test('ids increase per project and per kind, and a number is never given twice', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  assert.equal(refs.addDecision('ACM', decision('One')).id, 'ACM-D1');
  assert.equal(refs.addDecision('ACM', decision('Two')).id, 'ACM-D2');
  assert.equal(refs.addNote('ACM', note('First note')).id, 'ACM-N1');
  assert.equal(refs.addDecision('BKE', decision('Other project')).id, 'BKE-D1');
  assert.equal(refs.addDecision('ALL', decision('Everywhere')).id, 'ALL-D1');

  // Deleting the newest entry by hand does not free its number.
  const file = path.join(refs.root, 'ACM', 'decisions.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/## ACM-D2[\s\S]*$/, ''));
  assert.deepEqual(refs.entries('ACM', 'D').map(e => e.id), ['ACM-D1']);
  assert.equal(refs.addDecision('ACM', decision('Three')).id, 'ACM-D3');

  // Nor does losing the counter, or a block the parser skips: a malformed ACM-D9 still holds 9.
  fs.rmSync(path.join(refs.root, 'ACM', '.ids.json'));
  fs.appendFileSync(file, '\n## ACM-D9\n- decided by: You\n');
  assert.equal(refs.addDecision('ACM', decision('Four')).id, 'ACM-D10');
  assert.equal(refs.get('acm-d10')?.title, 'Four');
});

test('concurrent adds, from one store or two on the same folder, get distinct consecutive ids', async () => {
  const root = tempDir('refs');
  const a = new ProjectRefs(root);
  const b = new ProjectRefs(root);
  const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => (i % 2 ? a : b).addDecision('ACM', decision(`Decision ${i}`)).id)));
  assert.equal(new Set(ids).size, 40);
  const nums = ids.map(id => Number(id.slice('ACM-D'.length))).sort((x, y) => x - y);
  assert.deepEqual(nums, Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(a.entries('ACM', 'D').length, 40);
});

test('replacing a decision adds a new one and marks the old one; nothing else in the file changes', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  refs.addDecision('ACM', decision('Release 0.2.4'));
  refs.addDecision('ACM', decision('Keep shadows off'));
  const file = path.join(refs.root, 'ACM', 'decisions.md');
  const before = fs.readFileSync(file, 'utf8');
  const next = refs.addDecision('ACM', decision('0.2.5 is a tag only', { replaces: 'acm-d1' }));
  assert.equal(next.id, 'ACM-D3');
  assert.equal(next.status, 'active');
  const old = refs.get('ACM-D1')!;
  assert.equal(old.status, 'replaced by ACM-D3');
  assert.equal(old.replacedBy, 'ACM-D3');
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(after.replace('- status: replaced by ACM-D3', '- status: active').startsWith(before), 'only the status line changed');

  // Already replaced, a note, another project, missing: all refused, and no id is spent.
  assert.throws(() => refs.addDecision('ACM', decision('Again', { replaces: 'ACM-D1' })), e => status(e) === 409);
  refs.addNote('ACM', note('A note'));
  assert.throws(() => refs.addDecision('ACM', decision('X', { replaces: 'ACM-N1' })), e => status(e) === 400);
  assert.throws(() => refs.addDecision('ACM', decision('X', { replaces: 'BKE-D1' })), e => status(e) === 400);
  assert.throws(() => refs.addDecision('ACM', decision('X', { replaces: 'ACM-D99' })), e => status(e) === 404);
  assert.equal(refs.addDecision('ACM', decision('Next')).id, 'ACM-D4');

  // A hand edit that dropped the status line gets one back when the decision is replaced.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(## ACM-D2 [^\n]*\n(?:- [^\n]*\n)*?)- status: active\n/, '$1'));
  refs.addDecision('ACM', decision('Shadows, again', { replaces: 'ACM-D2' }));
  assert.equal(refs.get('ACM-D2')!.status, 'replaced by ACM-D5');
});

test('hand-edited files parse; malformed blocks are skipped and nothing throws', () => {
  const text = [
    '# Decisions (ACM)',
    'Some notes the user wrote at the top.',
    '',
    '## ACM-D1   Transcript is one conversation  ',
    '',
    '- Decided By:  You',
    '- date: 2026-11-09',
    '- why: Cards broke the flow.',
    '- status: active',
    '- links: web/Transcript.tsx,  #agents-comms-features',
    '',
    'No bordered cards.',
    '- status: this line is body, not a field',
    '\\## escaped heading in the body',
    '',
    '## ACM-D2',
    '- decided by: missing title, skipped',
    '## not an id at all',
    'skipped text',
    '## BKE-D3  Wrong project, skipped',
    '## ACM-N4  Wrong kind, skipped',
    '## ACM-D1  Duplicate id, skipped',
    '## ACM-D0  Zero, skipped',
    '## ACM-D5  No fields at all',
    'Just a body.',
    '## ACM-D6  Replaced by hand',
    '- status: Replaced by acm-d5',
    '### a subheading stays in the body? no: it is not a block heading',
    '# A new top-level heading ends the block',
    'stray text',
  ].join('\n');
  const entries = parseRefs(text, 'ACM', 'D');
  assert.deepEqual(entries.map(e => e.id), ['ACM-D1', 'ACM-D5', 'ACM-D6']);
  const [first, bare, replaced] = entries;
  assert.equal(first.title, 'Transcript is one conversation');
  assert.equal(first.by, 'You');
  assert.equal(first.why, 'Cards broke the flow.');
  assert.deepEqual(first.links, ['web/Transcript.tsx', '#agents-comms-features']);
  assert.equal(first.body, 'No bordered cards.\n- status: this line is body, not a field\n## escaped heading in the body');
  assert.equal(bare.status, 'active');
  assert.equal(bare.body, 'Just a body.');
  assert.equal(replaced.replacedBy, 'ACM-D5');
  assert.match(replaced.body, /^### a subheading/);

  // Garbage, binary and CRLF never throw.
  assert.deepEqual(parseRefs('\u0000\u0001## ACM-D\n##\n#', 'ACM', 'D'), []);
  assert.equal(parseRefs('## ACM-N1  Windows\r\n- author: Ada\r\n\r\nBody\r\n', 'ACM', 'N')[0].body, 'Body');

  // What renderRef writes reads back the same, including a body line that looks like a heading.
  const entry: RefEntry = { id: 'ACM-N2', code: 'ACM', kind: 'N', num: 2, title: 'Round trip', by: 'Cy', date: '2026-11-10', why: '', status: '', links: ['a', 'b'], body: '# looks like a heading\n\\ starts with a backslash\nplain' };
  assert.deepEqual(parseRefs(renderRef(entry), 'ACM', 'N'), [entry]);

  // A store over a hand-mangled file still answers and still adds.
  const refs = new ProjectRefs(tempDir('refs'));
  fs.mkdirSync(path.join(refs.root, 'ACM'), { recursive: true });
  fs.writeFileSync(path.join(refs.root, 'ACM', 'decisions.md'), text);
  assert.equal(refs.search('cards').length, 1);
  assert.equal(refs.addDecision('ACM', decision('After the mess')).id, 'ACM-D7');
});

test('adds are validated and capped, and secrets are refused', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  assert.throws(() => refs.addDecision('ACM', decision('')), e => status(e) === 400);
  assert.throws(() => refs.addDecision('ACM', decision('x'.repeat(121))), e => status(e) === 400);
  assert.throws(() => refs.addNote('ACM', { ...note('Big'), body: 'x'.repeat(4001) }), e => status(e) === 400);
  assert.throws(() => refs.addNote('ACM', { ...note('Links'), links: Array.from({ length: 11 }, (_, i) => `l${i}`) }), e => status(e) === 400);
  assert.throws(() => refs.addNote('ACM', { ...note('Key'), body: 'Use sk-ant-abcdefghijklmnopqrstuvwxyz012345' }), e => status(e) === 400);
  assert.throws(() => refs.addNote('../x', note('Escape')), e => status(e) === 400);
  assert.throws(() => refs.addNote('ACM', { ...note('Date'), date: 'yesterday' }), e => status(e) === 400);
  assert.equal(refs.addNote('ACM', note('Fine')).id, 'ACM-N1', 'refused adds spend no id');
});

test('the index lists active decisions first, then notes, then replaced ones, and is capped', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  refs.addDecision('ACM', decision('Old'));
  refs.addNote('ACM', note('A note'));
  refs.addDecision('ACM', decision('New', { replaces: 'ACM-D1' }));
  refs.addDecision('ACM', decision('Another'));
  assert.equal(refs.index('ACM'), [
    '- ACM-D3 Another (active; decided by You, added by Cy)',
    '- ACM-D2 New (active; decided by You, added by Cy)',
    '- ACM-N1 A note (note; added by Cy)',
    '- ACM-D1 Old (replaced by ACM-D2; decided by You, added by Cy)',
  ].join('\n'));
  assert.equal(refs.index('BKE'), '');

  const many: RefEntry[] = Array.from({ length: 200 }, (_, i) => ({ id: `ACM-D${i + 1}`, code: 'ACM', kind: 'D', num: i + 1, title: `A fairly long decision title number ${i + 1} that takes room`, by: 'You', date: '2026-11-10', why: '', status: 'active', links: [], body: '' }));
  const index = refIndex(many);
  assert.ok(index.length <= INDEX_LIMIT, `${index.length} characters`);
  assert.match(index, /^- ACM-D200 /, 'newest first');
  assert.match(index, /\((\d+) more left out; find them with ref_search\)$/);
  const shown = index.split('\n').length - 1;
  assert.equal(Number(/\((\d+) more/.exec(index)![1]), 200 - shown);
});

test('a seed file is applied once: re-running, or losing the record, never duplicates', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  fs.mkdirSync(refs.root, { recursive: true });
  const seed = {
    entries: [
      { key: 'd1', project: 'ACM', type: 'decision', title: 'Release 0.2.4 tag', decision: 'Tag pushed, never published.', decided_by: 'You', date: '2026-11-09' },
      { key: 'd2', project: 'ACM', type: 'decision', title: '0.2.5 is a tag only', decision: 'No published release for now.', decided_by: 'You', date: '2026-11-10', replaces: 'd1' },
      { key: 'n1', project: 'ACM', type: 'note', title: 'Notarize hangs', body: 'notarytool submit --wait has no timeout.', author: 'Fen', date: '2026-11-10' },
      { key: 'a1', project: 'ALL', type: 'decision', title: 'Cost caps', decision: 'Only stop work the SuperAgent starts.', decided_by: 'You', date: '2026-11-09' },
      { key: 'bad', project: '../nope', type: 'note', title: 'Bad project' },
      { key: 'constructor', project: 'ALL', type: 'note', title: 'A key named like a prototype property', body: 'Still seeded.', author: 'Cy', date: '2026-11-10' },
    ],
  };
  fs.writeFileSync(path.join(refs.root, 'seed.json'), JSON.stringify(seed));
  const first = refs.seed();
  assert.deepEqual(first.added.map(e => e.id), ['ACM-D1', 'ACM-D2', 'ACM-N1', 'ALL-D1', 'ALL-N1'], 'a key like constructor is not mistaken for one already seeded');
  assert.deepEqual(first.skipped, ['bad']);
  assert.equal(refs.get('ACM-D1')!.status, 'replaced by ACM-D2');
  assert.equal(refs.get('ACM-D1')!.date, '2026-11-09');
  assert.equal(refs.get('ACM-N1')!.by, 'Fen');
  assert.equal(refs.get('ACM-N1')!.addedBy, 'seed file', 'the server says who really added it');
  assert.match(refs.index('ACM'), /- ACM-D2 0\.2\.5 is a tag only \(active; decided by You, added by seed file\)/);

  assert.deepEqual(refs.seed().added, [], 'a second run adds nothing');
  fs.rmSync(path.join(refs.root, '.seeded.json'));
  assert.deepEqual(refs.seed().added, [], 'nor does one after the record is lost');
  assert.equal(refs.entries('ACM', 'D').length, 2);
  assert.equal(refs.entries('ACM', 'N').length, 1);

  // A new seed entry added later goes in once, after what is there.
  seed.entries.push({ key: 'd3', project: 'ACM', type: 'decision', title: 'No shadows', decision: 'No shadows anywhere.', decided_by: 'You', date: '2026-11-09' });
  fs.writeFileSync(path.join(refs.root, 'seed.json'), JSON.stringify(seed));
  assert.deepEqual(refs.seed().added.map(e => e.id), ['ACM-D3']);
  assert.deepEqual(refs.seed().added, []);
});

test('project codes: the user\'s codes.json, else derived; unique, never ALL, and the same folder gets its code back', () => {
  const refs = new ProjectRefs(tempDir('refs'));
  // Without codes.json, codes are derived from the name.
  assert.equal(deriveCode({ name: 'backend', path: '/w/backend' }, new Set(), refs), 'BAC');
  assert.equal(deriveCode({ name: 'test-rig', path: '/w/test-rig' }, new Set(), refs), 'TRI');
  // The user's own choices live in the data folder, not the repo; bad entries and prototype names are ignored.
  fs.mkdirSync(refs.root, { recursive: true });
  fs.writeFileSync(path.join(refs.root, 'codes.json'), JSON.stringify({ 'acme-web': 'ACM', Backend: 'bke', 'test-rig': 'RIG', 'docs-site': 'DOC', bad: '../x', constructor: 7 }));
  assert.equal(deriveCode({ name: 'constructor', path: '/w/constructor' }, new Set(), refs), 'CON');
  assert.equal(deriveCode({ name: 'bad', path: '/w/bad' }, new Set(), refs), 'BAD');
  const taken = new Set<string>();
  const code = (name: string, dir = `/w/${name}`) => {
    const c = deriveCode({ name, path: dir }, taken, refs);
    taken.add(c);
    return c;
  };
  assert.equal(code('acme-web'), 'ACM');
  assert.equal(code('Rig', '/x/test-rig'), 'RIG', 'by folder name');
  assert.equal(code('backend'), 'BKE');
  assert.equal(code('docs-site'), 'DOC');
  assert.equal(code('My Web App'), 'MWA');
  assert.equal(code('allegro'), 'ALE', 'never ALL');
  assert.equal(code('All Lovely Lists'), 'ALO');
  assert.equal(code('mwa', '/w/mwa2'), 'MWA2', 'a number when every letter choice is taken');
  assert.equal(code('123'), 'PRJ');
  for (const c of taken) assert.match(c, /^[A-Z][A-Z0-9]{1,5}$/);

  // A removed project's folder keeps its code: another project does not take it, the same path gets it back.
  refs.recordProject('WEB', { name: 'web', path: '/w/web' });
  assert.notEqual(deriveCode({ name: 'web', path: '/elsewhere/web' }, new Set(), refs), 'WEB');
  assert.equal(deriveCode({ name: 'renamed', path: '/w/web' }, new Set(), refs), 'WEB');
});

test('agents add, read and search notes through the tools, and see the index in their instructions', async () => {
  const h = harness();
  fs.mkdirSync(path.join(h.store.dataDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(h.store.dataDir, 'projects', 'codes.json'), JSON.stringify({ 'acme-web': 'ACM', backend: 'BKE' }));
  const web = h.manager.addProject({ path: projectDir(h.dir, 'acme-web') });
  const other = h.manager.addProject({ path: projectDir(h.dir, 'backend') });
  assert.equal(web.code, 'ACM');
  assert.equal(other.code, 'BKE');
  h.manager.renameProject(web.id, { name: 'Web' });
  assert.equal(h.manager.project(web.id).code, 'ACM', 'a rename keeps the code');

  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const nova = await h.manager.create({ name: 'Nova', engine: 'codex', projectId: null });
  const boss = await h.manager.createSuper();
  for (const agent of [ada, nova, boss]) h.manager.send(agent.id, 'Go.');
  await settle();
  const runner = (id: string) => h.runner(id);
  for (const agent of [ada, nova, boss]) runner(agent.id).ctx.instructions!();
  const call = (id: string, tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner(id).ctx.commsToken!, tool, args);

  const added = await call(ada.id, 'decision_add', { project: 'acm', title: 'No shadows', decision: 'No shadows anywhere in the UI.', why: 'The user asked.', decided_by: 'You' }) as { added: { id: string } };
  assert.equal(added.added.id, 'ACM-D1');
  const replaced = await call(ada.id, 'decision_add', { project: 'Web', title: 'Soft shadows on menus only', decision: 'Menus may cast a faint shadow.', why: 'The user changed their mind.', decided_by: 'You', replaces: 'ACM-D1' }) as { added: { id: string }; replaced: string };
  assert.equal(replaced.added.id, 'ACM-D2');
  assert.equal(replaced.replaced, 'ACM-D1');
  const noted = await call(nova.id, 'note_add', { project: 'BKE', title: 'Build needs Node 24', body: 'Older Node fails on import attributes.' }) as { added: { id: string; author: string } };
  assert.deepEqual([noted.added.id, noted.added.author], ['BKE-N1', 'Nova']);
  await call(nova.id, 'decision_add', { project: 'ALL', title: 'Reviewer before the user', decision: 'Every dev task goes through a reviewer.', why: 'Standing approval.', decided_by: 'You' });

  assert.equal((await call(nova.id, 'ref_get', { id: 'acm-d1' }) as { status: string }).status, 'replaced by ACM-D2');
  await assert.rejects(call(nova.id, 'ref_get', { id: 'ACM-D9' }), e => status(e) === 404);
  const found = await call(nova.id, 'ref_search', { query: 'shadow', project: 'ACM' }) as { results: { id: string }[] };
  assert.deepEqual(found.results.map(r => r.id), ['ACM-D2', 'ACM-D1']);
  assert.deepEqual((await call(nova.id, 'ref_search', { query: 'node' }) as { results: { id: string }[] }).results.map(r => r.id), ['BKE-N1']);
  await assert.rejects(call(nova.id, 'note_add', { project: 'nowhere', title: 'x', body: 'y' }), e => status(e) === 404);
  await assert.rejects(call(nova.id, 'decision_add', { project: 'ACM', title: 'No why', decision: 'x', decided_by: 'You' }), e => status(e) === 400);

  // Ada, on the project: its index and ALL's; not BKE's.
  const adaText = runner(ada.id).ctx.instructions!();
  assert.match(adaText, /Web \(ACM\):\n- ACM-D2 Soft shadows on menus only \(active; decided by You, added by Ada\)\n- ACM-D1 No shadows \(replaced by ACM-D2; decided by You, added by Ada\)/);
  assert.match(adaText, /All projects \(ALL\):\n- ALL-D1 Reviewer before the user \(active; decided by You, added by Nova\)/);
  assert.doesNotMatch(adaText, /BKE-N1/);
  // Nova, across projects: ALL's index and counts per project.
  const novaText = runner(nova.id).ctx.instructions!();
  assert.match(novaText, /ALL-D1 Reviewer before the user/);
  assert.match(novaText, /- Web \(ACM\): 1 active decision \(2 in all\), 0 notes/);
  assert.match(novaText, /- backend \(BKE\): 0 active decisions \(0 in all\), 1 note/);
  assert.doesNotMatch(novaText, /ACM-D2/);
  // The SuperAgent: every index.
  const bossText = runner(boss.id).ctx.instructions!();
  for (const id of ['ALL-D1', 'ACM-D2', 'ACM-D1', 'BKE-N1']) assert.ok(bossText.includes(id), id);

  // A new entry reaches the others on their next turn, once; the writer already knows.
  await call(boss.id, 'note_add', { project: 'ACM', title: 'Shadow audit done', body: 'Checked every panel.' });
  assert.doesNotMatch(runner(boss.id).ctx.preparePrompt!('Next.'), /Shadow audit done/);
  assert.match(runner(ada.id).ctx.preparePrompt!('Next.'), /ACM-N1 Shadow audit done \(note; added by SuperAgent\)/);
  assert.doesNotMatch(runner(ada.id).ctx.preparePrompt!('Again.'), /Shadow audit done/);

  // The files are where agent memory lives, under the data folder.
  assert.ok(fs.existsSync(path.join(h.store.dataDir, 'projects', 'ACM', 'decisions.md')));
  assert.ok(fs.existsSync(path.join(h.store.dataDir, 'projects', 'BKE', 'notes.md')));
});

test('codes are assigned on load to projects from before codes, and a seed file in the data folder is applied once', async () => {
  const dir = tempDir('state');
  const dataDir = path.join(dir, '.agentscode');
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'projects', 'codes.json'), JSON.stringify({ 'docs-site': 'DOC' }));
  const projects = ['acme-web-app', 'docs-site', 'lonely'].map((name, i) => ({ id: `p${i}`, name, path: projectDir(dir, name), createdAt: 0, exists: true, isGit: false }));
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, agents: [], projects, settings: {}, messages: [], conversations: [] }));
  fs.writeFileSync(path.join(dataDir, 'projects', 'seed.json'), JSON.stringify([
    { key: 'x', project: 'AWA', type: 'decision', title: 'Seeded', decision: 'Seeded once.', decided_by: 'You', date: '2026-11-09' },
  ]));
  const { Store } = await import('../server/store.ts');
  const { AgentManager } = await import('../server/manager.ts');
  const boot = () => {
    const store = new Store(dataDir);
    store.load();
    const available = { available: true, path: '/usr/bin/false', version: '0.0.0' };
    const manager = new AgentManager(store, { broadcast: () => {} }, { claude: available, codex: available, orcacode: available }, { createRunner: () => { throw new Error('no runs'); }, worktreesRoot: path.join(dir, 'worktrees') });
    manager.init();
    store.flush();
    return { store, manager };
  };
  const first = boot();
  assert.deepEqual([...first.store.projects.values()].map(p => p.code), ['AWA', 'DOC', 'LON']);
  const second = boot();
  assert.deepEqual([...second.store.projects.values()].map(p => p.code), ['AWA', 'DOC', 'LON'], 'codes are kept');
  const refs = new ProjectRefs(path.join(dataDir, 'projects'));
  assert.deepEqual(refs.entries('AWA', 'D').map(e => e.id), ['AWA-D1']);
});
