import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { HttpError } from '../server/errors.ts';
import type { Exec } from '../server/github.ts';
import { NO_PROJECT_LEGACY, Store } from '../server/store.ts';
import { isAllProjects, normalizeProjectIds, otherProjectIds, sharesProject, startProjectId, worksOn } from '../shared/agentProjects.ts';
import type { Agent, PeerMessage } from '../shared/types.ts';
import { beyondOneFolder, choiceFrom, choiceValue, filterProjects, initialChoice, makeStart, removeProject, sameChoice, setMode, toggleProject } from '../web/projectPicker.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

const status = (e: unknown) => (e instanceof HttpError ? e.status : 0);

// ---- the shared rules -------------------------------------------------------------------------

test('project choices: null is every project, the first is the start folder, overlap decides sharing', () => {
  assert.equal(normalizeProjectIds(undefined, 'p1')?.join(), 'p1', 'the old single id becomes a list');
  assert.equal(normalizeProjectIds(undefined, null), null);
  assert.deepEqual(normalizeProjectIds(['p2', 'p1', 'p2', '', 7]), ['p2', 'p1'], 'order kept, repeats and junk dropped');
  assert.equal(normalizeProjectIds([]), undefined, 'an empty choice is no choice');
  assert.equal(normalizeProjectIds(undefined, undefined), undefined);
  const multi = { projectIds: ['web', 'api'] };
  const all = { projectIds: null };
  assert.equal(startProjectId(multi), 'web');
  assert.equal(startProjectId(all), null);
  assert.deepEqual(otherProjectIds(multi), ['api']);
  assert.ok(isAllProjects(all) && !isAllProjects(multi));
  assert.ok(worksOn(multi, 'api') && !worksOn(multi, 'docs') && worksOn(all, 'docs'));
  assert.ok(sharesProject(multi, { projectIds: ['api'] }));
  assert.ok(!sharesProject(multi, { projectIds: ['docs'] }));
  assert.ok(sharesProject(multi, all) && sharesProject(all, { projectIds: ['docs'] }));
});

// ---- migration ------------------------------------------------------------------------------------

test('stored agents with the old projectId load as projectIds; save writes both, consistent', () => {
  const dir = tempDir('migrate');
  const base = { worktree: null, home: '/h', model: '', effort: '', autonomy: 'edits', useMcp: false, status: 'idle', createdAt: 1, turns: 0, costUsd: 0 };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, projects: [{ id: 'p1', name: 'web', path: '/w/web' }, { id: 'p2', name: 'api', path: '/w/api' }], settings: {}, messages: [], conversations: [],
    agents: [
      { ...base, id: 'a', name: 'Ada', engine: 'claude', projectId: 'p1' },
      { ...base, id: 'b', name: 'Bo', engine: 'claude', projectId: null },
      { ...base, id: 'd', name: 'Dee', engine: 'claude', projectIds: ['p1', 'p2'] },
      // Both fields, disagreeing: projectIds wins.
      { ...base, id: 'e', name: 'Eli', engine: 'claude', projectIds: ['p2', 'p1'], projectId: null },
      { ...base, id: 'f', name: 'Fay', engine: 'claude', projectIds: null, projectId: 'p1' },
    ],
  }));
  const store = new Store(dir);
  store.load();
  const ids = (id: string) => store.agents.get(id)!.projectIds;
  assert.deepEqual(ids('a'), ['p1']);
  assert.equal(ids('b'), null, 'an old agent on every project stays on every project');
  assert.deepEqual(ids('d'), ['p1', 'p2']);
  assert.deepEqual(ids('e'), ['p2', 'p1'], 'projectIds is the authority');
  assert.equal(ids('f'), null);
  assert.ok([...store.agents.values()].every(a => !('projectId' in a)), 'the old key is not kept in memory');
  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { agents: { id: string; projectIds: string[] | null; projectId: string | null }[] };
  const row = (id: string) => saved.agents.find(a => a.id === id)!;
  // An older build reads projectId: the start folder, and every project only for a real all-projects agent.
  assert.deepEqual([row('a').projectIds, row('a').projectId], [['p1'], 'p1']);
  assert.deepEqual([row('b').projectIds, row('b').projectId], [null, null]);
  assert.deepEqual([row('d').projectIds, row('d').projectId], [['p1', 'p2'], 'p1']);
  assert.deepEqual([row('e').projectIds, row('e').projectId], [['p2', 'p1'], 'p2']);
  for (const a of saved.agents) assert.equal(a.projectId, a.projectIds === null ? null : a.projectIds[0], `${a.id}: both fields agree`);
});

test('an unreadable project choice narrows to the old project if it exists, else to none, never to every project', () => {
  const dir = tempDir('corrupt');
  const base = { worktree: null, home: '/h', model: '', effort: '', autonomy: 'edits', useMcp: false, status: 'idle', createdAt: 1, turns: 0, costUsd: 0, engine: 'claude' };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1, projects: [{ id: 'p1', name: 'web', path: '/w/web' }], settings: {}, messages: [], conversations: [],
    agents: [
      { ...base, id: 'g', name: 'Gus', projectIds: 'p1,p2', projectId: 'p1' },
      { ...base, id: 'h', name: 'Hal', projectIds: [7], projectId: 'gone' },
      { ...base, id: 'i', name: 'Ivy', projectIds: {}, projectId: null },
      { ...base, id: 'j', name: 'Jo' },
      { ...base, id: 'k', name: 'Kai', projectIds: [] },
    ],
  }));
  const store = new Store(dir);
  store.load();
  const ids = (id: string) => store.agents.get(id)!.projectIds;
  assert.deepEqual(ids('g'), ['p1'], 'damaged projectIds: the old project, which exists');
  assert.deepEqual(ids('h'), [], 'its old project is gone: none');
  assert.deepEqual(ids('i'), [], 'a damaged choice never widens to every project, even beside projectId null');
  assert.deepEqual(ids('j'), [], 'no usable field at all: none');
  assert.deepEqual(ids('k'), [], 'none stays none');
  store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as { agents: { id: string; projectIds: string[] | null; projectId: string | null }[] };
  const kai = saved.agents.find(a => a.id === 'k')!;
  assert.deepEqual([kai.projectIds, kai.projectId], [[], NO_PROJECT_LEGACY], 'an older build gets an id no project has, so it fails closed');
  const again = new Store(dir);
  again.load();
  assert.deepEqual(again.agents.get('k')!.projectIds, [], 'and it reads back as none');
});

test('an agent with no projects works only in its own folder, reaches no project, and is asked to get some', async () => {
  const t = await team();
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.web.id] });
  t.store.agents.get(cy.id)!.projectIds = [];
  t.manager.send(cy.id, 'Hi.');
  await settle();
  const ctx = t.runner(cy.id).ctx;
  assert.equal(ctx.cwd, fs.realpathSync(path.join(t.store.agents.get(cy.id)!.home, 'workspace')), 'its own folder, as for an agent with no project');
  assert.deepEqual(ctx.directories?.(), []);
  assert.match(ctx.instructions!(), /You have no projects right now: your project choice could not be read/);
  await assert.rejects(t.manager.commsTool(ctx.commsToken!, 'gh_prs', { project: 'web' }), e => status(e) === 403);
  // Picking projects in its settings restores it; the start folder moves, so a fresh session follows.
  t.runner(cy.id).complete();
  await settle();
  await t.manager.update(cy.id, { projectIds: [t.web.id] });
  assert.deepEqual(t.store.agents.get(cy.id)!.projectIds, [t.web.id]);
  const { railAgents } = await import('../web/sidebar/agentRail.ts');
  assert.deepEqual(railAgents([{ name: 'Nil', projectIds: [], createdAt: 1 }, { name: 'Web', projectIds: ['p'], createdAt: 2 }]).map(a => a.name), ['Nil'], 'it stays in the sidebar, under no project');
});

// ---- creating, running and sharing ----------------------------------------------------------------------

async function team() {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const api = h.manager.addProject({ path: projectDir(h.dir, 'api') });
  const docs = h.manager.addProject({ path: projectDir(h.dir, 'docs') });
  return { ...h, web, api, docs };
}

test('an agent on two projects runs in the first, reaches the other, and is told both', async () => {
  const t = await team();
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.web.id, t.api.id] });
  assert.deepEqual(cy.projectIds, [t.web.id, t.api.id]);
  t.manager.send(cy.id, 'Start.');
  await settle();
  const ctx = t.runner(cy.id).ctx;
  assert.equal(ctx.cwd, fs.realpathSync(t.web.path), 'sessions run in the start folder');
  assert.deepEqual(ctx.directories?.(), [fs.realpathSync(t.api.path)], 'the other project is reachable');
  const prompt = ctx.instructions!();
  assert.match(prompt, /Your project is "web"/);
  assert.match(prompt, /Besides web \(your start folder[^)]*\), you also work on these projects, used in place:\n- api: /);
  assert.match(prompt, /You may read and write in them too/);
  assert.match(prompt, /Notes and decisions you record go to web/);

  // The old single form still creates a one-project agent; an empty choice is refused.
  const ada = await t.manager.create({ name: 'Ada', engine: 'claude', projectId: t.web.id });
  assert.deepEqual(ada.projectIds, [t.web.id]);
  await assert.rejects(t.manager.create({ name: 'Bo', engine: 'claude', projectIds: [] }), e => status(e) === 400 && /at least one/.test((e as Error).message));
  await assert.rejects(t.manager.create({ name: 'Bo', engine: 'claude', projectIds: ['nope'] }), e => status(e) === 400);
  await assert.rejects(t.manager.create({ name: 'Bo', engine: 'claude', projectIds: null, worktree: true }), e => status(e) === 400);
});

test('a Codex agent on two projects writes only in its start folder, and is told so', async () => {
  const t = await team();
  const cx = await t.manager.create({ name: 'Cx', engine: 'codex', projectIds: [t.web.id, t.api.id], autonomy: 'edits' });
  t.manager.send(cx.id, 'Start.');
  await settle();
  const ctx = t.runner(cx.id).ctx;
  assert.equal(ctx.cwd, fs.realpathSync(t.web.path));
  assert.deepEqual(ctx.directories?.(), [], 'no other folder is made writable');
  assert.match(ctx.instructions!(), /You can read them, but your sandbox lets you write only in web, your start folder/);
});

test('visibility on Same project is any shared project; agents on every project see everyone', async () => {
  const t = await team();
  t.manager.updateSettings({ awareness: 'project' });
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.web.id, t.api.id] });
  const ana = await t.manager.create({ name: 'Ana', engine: 'claude', projectIds: [t.api.id] });
  const dot = await t.manager.create({ name: 'Dot', engine: 'claude', projectIds: [t.docs.id] });
  const roam = await t.manager.create({ name: 'Roam', engine: 'claude', projectIds: null });
  t.manager.send(cy.id, 'Hi.');
  await settle();
  const seen = (await t.manager.commsTool(t.runner(cy.id).ctx.commsToken!, 'list_agents', {}) as { name: string; project: { name: string } | null; alsoProjects?: { name: string }[] }[]);
  assert.deepEqual(seen.map(a => a.name).sort(), ['Ana', 'Roam'], 'Ana shares api; Dot shares nothing');
  assert.ok(ana.id && dot.id && roam.id);
  // Ana sees Cy, listed with its start folder and the rest of its projects.
  t.manager.send(ana.id, 'Hi.');
  await settle();
  const fromAna = (await t.manager.commsTool(t.runner(ana.id).ctx.commsToken!, 'list_agents', {}) as { name: string; project: { name: string } | null; alsoProjects?: { name: string }[] }[]).find(a => a.name === 'Cy')!;
  assert.equal(fromAna.project?.name, 'web');
  assert.deepEqual(fromAna.alsoProjects?.map(p => p.name), ['api']);
});

test('notes and decisions: an agent on two projects is given both indexes and ALL, not others', async () => {
  const t = await team();
  const codes = Object.fromEntries([t.web, t.api, t.docs].map(p => [p.name, t.manager.project(p.id).code!]));
  const root = path.join(t.store.dataDir, 'projects');
  const write = (code: string, title: string) => {
    fs.mkdirSync(path.join(root, code), { recursive: true });
    fs.writeFileSync(path.join(root, code, 'decisions.md'), `# Decisions (${code})\n\n## ${code}-D1  ${title}\n- decided by: You\n- date: 2026-11-10\n- why: x\n- status: active\n- links:\n\nBody.\n`);
  };
  write(codes.web, 'Web rule');
  write(codes.api, 'Api rule');
  write(codes.docs, 'Docs rule');
  write('ALL', 'Shared rule');
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.api.id, t.web.id] });
  t.manager.send(cy.id, 'Hi.');
  await settle();
  const prompt = t.runner(cy.id).ctx.instructions!();
  for (const rule of ['Web rule', 'Api rule', 'Shared rule']) assert.match(prompt, new RegExp(rule));
  assert.doesNotMatch(prompt, /Docs rule/);
  assert.ok(prompt.indexOf('Api rule') < prompt.indexOf('Web rule'), 'the start folder first');
});

test('GitHub and checks: an agent on two projects looks at both, and only those', async () => {
  const t = await team();
  const manager = t.manager as unknown as { ghExec: Exec; gitRemote: (dir: string) => Promise<string | null> };
  const asked: string[] = [];
  manager.ghExec = async (_bin, args) => { asked.push(args[args.indexOf('--repo') + 1]); return { stdout: '[]', stderr: '' }; };
  manager.gitRemote = async dir => `git@github.com:me/${path.basename(dir)}.git`;
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.web.id, t.api.id], role: 'reviewer' });
  t.manager.send(cy.id, 'Look.');
  await settle();
  const call = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(t.runner(cy.id).ctx.commsToken!, tool, args);
  const all = await call('gh_prs', {}) as { results: { project: string }[] };
  assert.deepEqual(all.results.map(r => r.project), ['web', 'api']);
  await call('gh_runs', { project: 'api' });
  await assert.rejects(call('gh_prs', { project: 'docs' }), e => status(e) === 403 && /web and api/.test((e as Error).message));
  assert.deepEqual(asked, ['me/web', 'me/api', 'me/api'], 'docs was never asked');
});

test('changing projects: the same start goes on; a new start begins a fresh session there; a worktree keeps its start', async () => {
  const t = await team();
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.web.id] });
  t.manager.send(cy.id, 'Work.');
  await settle();
  const first = t.runner(cy.id);
  // Mid-turn, adding a project is fine; moving the start folder waits.
  await t.manager.update(cy.id, { projectIds: [t.web.id, t.api.id] });
  assert.equal(first.closed, false, 'nothing restarts for an added project');
  assert.deepEqual(first.ctx.directories?.(), [fs.realpathSync(t.api.path)], 'read again from the live agent');
  await assert.rejects(t.manager.update(cy.id, { projectIds: [t.api.id, t.web.id] }), e => status(e) === 409 && /middle of a turn/.test((e as Error).message));
  first.complete();
  await settle();
  const live = t.store.agents.get(cy.id)!;
  live.sessionId = 'old-session';
  await t.manager.update(cy.id, { projectIds: [t.api.id, t.web.id] });
  assert.equal(first.closed, true, 'the old session closed');
  assert.equal(live.sessionId, null);
  assert.match(t.manager.entries(cy.id).at(-1)!.text, /now starts in api.*fresh session/);
  t.manager.send(cy.id, 'Again.');
  await settle();
  assert.equal(t.runner(cy.id).ctx.cwd, fs.realpathSync(t.api.path), 'the next session runs in the new start folder');

  // A worktree belongs to its start folder.
  live.worktree = { path: '/wt', cwd: '/wt', branch: 'cy/x', base: 'main', baseCommit: 'abc', gitDir: '/g' } as Agent['worktree'];
  t.runner(cy.id).complete();
  await settle();
  await assert.rejects(t.manager.update(cy.id, { projectIds: [t.web.id] }), e => status(e) === 409 && /worktree/.test((e as Error).message));
  await t.manager.update(cy.id, { projectIds: [t.api.id] });
  assert.deepEqual(live.projectIds, [t.api.id], 'dropping a non-start project is fine with a worktree');
  await assert.rejects(t.manager.update(cy.id, { projectIds: [] }), e => status(e) === 400);
  const sup = await t.manager.createSuper();
  await assert.rejects(t.manager.update(sup.id, { projectIds: [t.web.id] }), e => status(e) === 400);
});

test('removing a project: refused while it is someone\'s start folder, dropped from the others\' lists', async () => {
  const t = await team();
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.web.id, t.api.id] });
  assert.throws(() => t.manager.removeProject(t.web.id), e => status(e) === 409 && /Cy still starts in web/.test((e as Error).message));
  t.manager.removeProject(t.api.id);
  assert.deepEqual(t.store.agents.get(cy.id)!.projectIds, [t.web.id]);
});

test('the SuperAgent creates an agent on several projects, by name, and the log names them', async () => {
  const t = await team();
  t.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const sup = await t.manager.createSuper();
  t.manager.send(sup.id, 'Set up the team.');
  await settle();
  const call = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(t.runner(sup.id).ctx.commsToken!, tool, args);
  const made = await call('create_agent', { name: 'Tess', projects: ['api', 'web'], why: 'Both sides of the API.' }) as { created: { projectIds: string[] } };
  assert.deepEqual(made.created.projectIds, [t.api.id, t.web.id]);
  assert.match(t.manager.superView().log[0].summary, /on api and web/);
  await assert.rejects(call('create_agent', { name: 'Uma', project: 'web', projects: ['api'], why: 'x' }), e => status(e) === 400);
});

test('a lesson from an agent on two projects goes to its start folder\'s project', async () => {
  const t = await team();
  t.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.api.id, t.web.id] });
  const sup = await t.manager.createSuper();
  t.manager.send(sup.id, 'Run the team.');
  await settle();
  const request = await t.manager.commsTool(t.runner(sup.id).ctx.commsToken!, 'delegate_task', { to_agent_id: cy.id, kind: 'implementation', task: 'Do it.', acceptance_criteria: 'Done.' }) as PeerMessage;
  await settle();
  const sent = await t.manager.commsTool(t.runners.get(cy.id)!.at(-1)!.ctx.commsToken!, 'report_result', { message_id: request.id, outcome: 'done', summary: 'Done.', evidence: 'ok', lesson: 'The api keeps its schema in one file.' }) as PeerMessage;
  assert.equal(sent.report?.lesson?.id, `${t.manager.project(t.api.id).code}-N1`);
});

// ---- the picker -------------------------------------------------------------------------------------

test('the Projects picker: tick, make start, remove, All and back, and what it sends', () => {
  let c = initialChoice(undefined, 'web');
  assert.deepEqual(c, { mode: 'choose', ids: ['web'] }, 'a new agent starts on the first project');
  assert.deepEqual(initialChoice(null, 'web'), { mode: 'all', ids: [] });
  c = toggleProject(c, 'site');
  assert.deepEqual(choiceValue(c), ['web', 'site'], 'a ticked project goes last');
  assert.ok(beyondOneFolder(c));
  c = makeStart(c, 'site');
  assert.deepEqual(choiceValue(c), ['site', 'web'], 'Make start moves it to the front');
  c = toggleProject(c, 'site');
  assert.deepEqual(choiceValue(c), ['web'], 'unticking the start folder makes the next one start');
  c = removeProject(c, 'web');
  assert.equal(choiceValue(c), undefined, 'nothing picked: nothing to send yet');
  c = setMode(toggleProject(c, 'api'), 'all');
  assert.equal(choiceValue(c), null);
  c = setMode(c, 'choose');
  assert.deepEqual(choiceValue(c), ['api'], 'switching back keeps what was picked');

  // A worktree keeps its start folder: it can be neither moved nor removed.
  let locked = choiceFrom(['web', 'api'], 'web');
  locked = makeStart(locked, 'api');
  assert.deepEqual(choiceValue(locked), ['web', 'api']);
  locked = removeProject(locked, 'web');
  assert.deepEqual(choiceValue(locked), ['web', 'api']);
  assert.deepEqual(choiceValue(removeProject(locked, 'api')), ['web']);
  assert.deepEqual(choiceFrom(null), { mode: 'all', ids: [] });

  assert.ok(sameChoice(['a', 'b'], ['a', 'b']) && !sameChoice(['a', 'b'], ['b', 'a']) && sameChoice(null, null) && !sameChoice(null, ['a']));
  const projects = [{ name: 'agent-comms-harness', path: '/w/ach' }, { name: 'orca-site', path: '/w/site' }];
  assert.deepEqual(filterProjects(projects, 'orca').map(p => p.name), ['orca-site']);
  assert.deepEqual(filterProjects(projects, 'w ach').map(p => p.name), ['agent-comms-harness'], 'every word, in the name or the folder');
  assert.equal(filterProjects(projects, '  ').length, 2);
});

test('All projects from the picker (projectIds null) makes an agent on every project', async () => {
  const t = await team();
  const roam = await t.manager.create({ name: 'Roam', engine: 'claude', projectIds: null });
  assert.equal(roam.projectIds, null);
  assert.equal(choiceValue(choiceFrom(null)), null, 'the picker sends null for All projects');
});

test('note_add and decision_add default to the start folder\'s project; an agent on every project names one', async () => {
  const t = await team();
  const cy = await t.manager.create({ name: 'Cy', engine: 'claude', projectIds: [t.api.id, t.web.id] });
  const roam = await t.manager.create({ name: 'Roam', engine: 'claude', projectIds: null });
  t.manager.send(cy.id, 'Note it.');
  t.manager.send(roam.id, 'Note it.');
  await settle();
  const as = (id: string, tool: string, args: Record<string, unknown>) => t.manager.commsTool(t.runner(id).ctx.commsToken!, tool, args);
  const api = t.manager.project(t.api.id).code!;
  const note = await as(cy.id, 'note_add', { title: 'Schema lives in one file', body: 'api/schema.ts.' }) as { added: { id: string } };
  assert.equal(note.added.id, `${api}-N1`);
  const decision = await as(cy.id, 'decision_add', { title: 'Keep one schema', decision: 'One file.', why: 'Drift.', decided_by: 'You' }) as { added: { id: string } };
  assert.equal(decision.added.id, `${api}-D1`);
  const web = await as(cy.id, 'note_add', { project: 'web', title: 'Named', body: 'x' }) as { added: { id: string } };
  assert.equal(web.added.id, `${t.manager.project(t.web.id).code}-N1`, 'a named project still wins');
  await assert.rejects(as(roam.id, 'note_add', { title: 'Where?', body: 'x' }), e => status(e) === 400 && /Name the project/.test((e as Error).message));
});
