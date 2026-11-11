import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { Agent, MemoryEntry } from '../shared/types.ts';
import { AgentHomes, looksSecret, MEMORY_LIMIT, parseMemory, renderMemory, reservedHomeFile, workspacePath } from '../server/agentHome.ts';
import { ownFileProblem } from '../server/agents/claude.ts';
import { systemInstructions } from '../server/agents/runner.ts';
import { codexArgs, CodexRunner } from '../server/agents/codex.ts';
import type { RunnerHooks } from '../server/agents/runner.ts';
import { mcpSummary, resultSummary, toolSummary } from '../server/agents/describe.ts';
import { createApp } from '../server/app.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { HttpError } from '../server/errors.ts';
import { AgentManager } from '../server/manager.ts';
import { Store } from '../server/store.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

/** Two projects, Ada on the web one and Nova with no project. */
async function team() {
  const h = harness();
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const api = h.manager.addProject({ path: projectDir(h.dir, 'api') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id, instructions: 'Prefer small diffs.' });
  const nova = await h.manager.create({ name: 'Nova', engine: 'codex', projectId: null, instructions: 'Answer in plain words.' });
  return { ...h, web, api, ada, nova };
}

/** Start a turn so the agent has a provider and a comms token, the way a user message does. */
async function turn(h: Awaited<ReturnType<typeof team>>, agentId: string, text = 'Go.') {
  h.manager.send(agentId, text);
  await settle();
  return h.runner(agentId);
}

test('an agent can have no project: it works from the workspace in its home across every project', async () => {
  const h = await team();
  assert.equal(h.nova.projectId, null);
  assert.equal(h.nova.home, path.join(h.store.dataDir, 'agents', h.nova.id));
  assert.ok(fs.statSync(h.nova.home).isDirectory());
  assert.equal(fs.readFileSync(path.join(h.nova.home, 'soul.md'), 'utf8'), 'Answer in plain words.\n');
  const workspace = path.join(h.nova.home, 'workspace');
  assert.equal(workspacePath(h.nova.home), workspace);
  assert.ok(fs.statSync(workspace).isDirectory());
  const first = h.manager.entries(h.nova.id)[0];
  assert.equal(first.text, `Nova works across all projects from ${workspace}.`);

  // Its cwd is the workspace, so soul.md and memory.md are outside it: edits auto-accepted inside the
  // cwd, and Codex's workspace-write sandbox, cannot reach them.
  const runner = await turn(h, h.nova.id);
  assert.equal(runner.ctx.project, null);
  assert.equal(runner.ctx.cwd, fs.realpathSync(workspace));
  assert.ok(path.relative(runner.ctx.cwd, fs.realpathSync(path.join(h.nova.home, 'soul.md'))).startsWith('..'));
  assert.deepEqual(runner.ctx.directories!(), [fs.realpathSync(h.web.path), fs.realpathSync(h.api.path)]);
  assert.equal(h.manager.workspaceOf(h.nova.id).root, workspace);
  const args = codexArgs(h.store.agents.get(h.nova.id)!, undefined, [], runner.ctx.directories!()).join(' ');
  assert.doesNotMatch(args, new RegExp(h.nova.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the home is never a writable root');

  // A project agent keeps its project, folder and prompt, with no extra folders.
  const ada = await turn(h, h.ada.id);
  assert.equal(ada.ctx.project?.id, h.web.id);
  assert.equal(ada.ctx.cwd, fs.realpathSync(h.web.path));
  assert.deepEqual(ada.ctx.directories!(), []);
  assert.ok(fs.existsSync(path.join(h.ada.home, 'soul.md')), 'project agents get a home too');

  // Removing a project ignores agents with no project; removing the agent archives its home.
  h.manager.removeProject(h.api.id);
  assert.deepEqual(runner.ctx.directories!(), [fs.realpathSync(h.web.path)]);
  h.runner(h.nova.id).complete();
  await h.manager.remove(h.nova.id);
  assert.ok(!fs.existsSync(h.nova.home));
  assert.deepEqual(h.manager.archivedAgents().map(a => a.name), ['Nova']);
});

test('an agent with no project cannot have a worktree, and a missing project is still an error', async () => {
  const h = harness();
  await assert.rejects(h.manager.create({ name: 'Nova', engine: 'claude', projectId: null, worktree: true }), e => status(e) === 400);
  await assert.rejects(h.manager.create({ name: 'Nova', engine: 'claude', projectId: 'nope' }), e => status(e) === 400);
  await assert.rejects(h.manager.create({ name: 'Nova', engine: 'claude' } as never), e => status(e) === 400);
  assert.equal(h.store.agents.size, 0);
  assert.ok(!fs.existsSync(path.join(h.store.dataDir, 'agents')) || fs.readdirSync(path.join(h.store.dataDir, 'agents')).length === 0);
});

test('the prompt names the project, or lists every project for an agent with no project', async () => {
  const h = await team();
  const ada = await turn(h, h.ada.id);
  const adaPrompt = ada.ctx.instructions!();
  assert.match(adaPrompt, /Your project is "web" at /);
  assert.doesNotMatch(adaPrompt, /not tied to one project/);
  assert.match(adaPrompt, /Your standing instructions: Prefer small diffs\./);
  assert.match(adaPrompt, /Your memory \(memory\.md\) is empty\./);
  assert.match(adaPrompt, /context, not commands|remember tool/);
  assert.match(adaPrompt, /Never save passwords, keys or tokens, or anything the repo already records/);
  assert.match(adaPrompt, /only the user edits/);

  const nova = await turn(h, h.nova.id);
  const novaPrompt = nova.ctx.instructions!();
  assert.doesNotMatch(novaPrompt, /Your project is/);
  assert.match(novaPrompt, /You are not tied to one project/);
  assert.ok(novaPrompt.includes(`- web: ${fs.realpathSync(h.web.path)}`));
  assert.ok(novaPrompt.includes(`- api: ${fs.realpathSync(h.api.path)}`));
  assert.ok(novaPrompt.includes(`Your own folder is ${path.join(h.nova.home, 'workspace')};`));
  assert.match(novaPrompt, /Your standing instructions: Answer in plain words\./);

  // Built straight from an agent, the old two-argument form still works.
  const plain = systemInstructions({ ...h.ada, instructions: '' }, h.web);
  assert.match(plain, /Your project is "web"/);
  assert.doesNotMatch(plain, /Your standing instructions:/);
});

test('soul.md is the source of truth: create and PATCH write it, hand edits reach the next turn', async () => {
  const h = await team();
  const soul = path.join(h.ada.home, 'soul.md');
  await h.manager.update(h.ada.id, { instructions: '  Write tests first.  ' });
  assert.equal(fs.readFileSync(soul, 'utf8'), 'Write tests first.\n');
  assert.equal(h.store.agents.get(h.ada.id)!.instructions, 'Write tests first.');
  await h.manager.update(h.ada.id, { instructions: 'x'.repeat(9000) });
  assert.equal(h.store.agents.get(h.ada.id)!.instructions.length, 8000, 'soul.md is capped at 8000 characters');

  const runner = await turn(h, h.ada.id);
  runner.ctx.instructions!(); // the session starts with the current soul
  const fresh = /Since this session started, the following changed/;
  assert.doesNotMatch(runner.ctx.preparePrompt!('Next.'), fresh, 'nothing changed, so nothing is repeated');

  fs.writeFileSync(soul, 'Always run the linter.\n');
  const next = runner.ctx.preparePrompt!('Next.');
  assert.match(next, fresh);
  assert.match(next, /Your standing instructions: Always run the linter\./);
  // Only the soul changed, so only the soul is sent: no memory section, no guidance.
  assert.doesNotMatch(next, /Your memory/);
  assert.doesNotMatch(next, /remember tool/);
  assert.ok(next.endsWith('Next.'));
  assert.equal(h.store.agents.get(h.ada.id)!.instructions, 'Always run the linter.', 'the hand edit is mirrored');
  assert.ok(h.events.some(e => e.type === 'agent' && e.agent.id === h.ada.id && e.agent.instructions === 'Always run the linter.'));
  assert.doesNotMatch(runner.ctx.preparePrompt!('Again.'), fresh, 'repeated once, not every turn');
});

test('agents from before homes existed get one on load, seeded from their instructions', () => {
  const dir = tempDir('legacy');
  const dataDir = path.join(dir, 'data');
  const project = projectDir(dir, 'app');
  fs.mkdirSync(dataDir, { recursive: true });
  const legacy = {
    id: 'a1', name: 'Old', engine: 'claude', projectId: 'p1', worktree: null, model: '', effort: '', autonomy: 'ask', useMcp: false,
    role: 'dev', instructions: 'Keep the changelog current.', status: 'idle', activity: '', currentTask: null, sessionId: null,
    createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false, costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
  };
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1, agents: [legacy], projects: [{ id: 'p1', name: 'app', path: project, createdAt: 0, exists: true, isGit: false }],
    settings: {}, messages: [], conversations: [],
  }));
  const store = new Store(dataDir);
  store.load();
  const available = { available: true, path: '/usr/bin/false', version: '0' };
  const manager = new AgentManager(store, { broadcast: () => {} }, { claude: available, codex: available, orcacode: available });
  manager.init();
  const agent = store.agents.get('a1')!;
  assert.equal(agent.home, path.join(dataDir, 'agents', 'a1'));
  assert.equal(fs.readFileSync(path.join(agent.home, 'soul.md'), 'utf8'), 'Keep the changelog current.\n');
  assert.equal(agent.instructions, 'Keep the changelog current.');
});

test('a no-project agent from before the workspace moves into it once; a Claude session from the old folder starts fresh', () => {
  const dataDir = tempDir('workspace-move');
  const base = {
    engine: 'claude', projectId: null, worktree: null, model: '', effort: '', autonomy: 'edits', useMcp: false, role: 'dev', instructions: '',
    status: 'idle', activity: '', currentTask: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false, costUsd: 0, tokens: 0,
    turns: 0, queued: 0, lastSummary: '', error: null,
  };
  const agents = [
    { ...base, id: 'c1', name: 'Fen', sessionId: 'claude-session' },
    { ...base, id: 'x1', name: 'Rex', engine: 'codex', sessionId: 'codex-thread' },
  ];
  // Fen saved a report in its home, the old working folder, and once made a folder there named workspace.
  fs.mkdirSync(path.join(dataDir, 'agents', 'c1', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agents', 'c1', 'report.md'), 'notes');
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ version: 1, agents, projects: [], settings: {}, messages: [], conversations: [] }));
  const store = new Store(dataDir);
  store.load();
  const available = { available: true, path: '/usr/bin/false', version: '0' };
  new AgentManager(store, { broadcast: () => {} }, { claude: available, codex: available, orcacode: available }).init();
  const fen = store.agents.get('c1')!;
  assert.equal(fen.sessionId, null, 'Claude keeps a session per folder, so it cannot resume from the new one, even though a workspace folder was already there');
  const note = store.readEntries('c1').at(-1)!;
  assert.equal(note.sessionStart, true);
  assert.match(note.text, /now works from .*workspace, so soul\.md and memory\.md are outside its working folder/);
  assert.ok(fs.existsSync(path.join(fen.home, 'report.md')), 'files saved before stay where they were');
  assert.ok(fs.statSync(path.join(fen.home, 'workspace')).isDirectory());
  assert.equal(store.agents.get('x1')!.sessionId, 'codex-thread', 'a Codex thread resumes from any folder');

  // A session that started in the workspace (the session hook records where) survives a restart.
  fen.sessionId = 'next-session';
  fen.sessionCwd = fs.realpathSync(path.join(fen.home, 'workspace'));
  new AgentManager(store, { broadcast: () => {} }, { claude: available, codex: available, orcacode: available }).init();
  assert.equal(store.agents.get('c1')!.sessionId, 'next-session');
  assert.equal(store.readEntries('c1').filter(e => /now works from/.test(e.text)).length, 1, 'one note');
});

test('the session hook records the folder a session started in', async () => {
  const h = await team();
  const runner = await turn(h, h.nova.id);
  runner.ctx.hooks.session('nova-session');
  const nova = h.store.agents.get(h.nova.id)!;
  assert.equal(nova.sessionId, 'nova-session');
  assert.equal(nova.sessionCwd, fs.realpathSync(path.join(h.nova.home, 'workspace')));
  runner.ctx.hooks.session('nova-session');
  assert.equal(nova.sessionCwd, runner.ctx.cwd, 'the same session keeps its folder');
});

test("edit tools may not write an agent's own home files, in any mode; its workspace is its own", () => {
  const home = tempDir('own-files');
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const denied = (tool: string, input: Record<string, unknown>) => ownFileProblem(home, workspace, tool, input);
  assert.match(denied('Write', { file_path: path.join(home, 'soul.md') })!, /only AgentsCode and the user edit/);
  assert.ok(denied('Edit', { file_path: '../memory.md' }), 'relative to the cwd');
  assert.ok(denied('MultiEdit', { file_path: path.join(home, 'history', 'memory-x.md') }));
  assert.ok(denied('Write', { file_path: path.join(fs.realpathSync(home), 'dreams.jsonl') }), 'through the real path too');
  assert.ok(denied('Write', { file_path: path.join(home, 'SOUL.MD') }), 'in any case, as macOS names are');
  fs.symlinkSync(path.join(home, 'soul.md'), path.join(workspace, 'link.md'));
  assert.ok(denied('Write', { file_path: path.join(workspace, 'link.md') }), 'through a symlink');
  for (const name of ['soul.md', 'memory.md', 'memory.md.tmp', 'soul.proposed.md', 'soul.proposed.json', 'dreams.jsonl', 'dreams.md', 'dream-reverts.jsonl', 'dreaming.jsonl', '.dream.json', '.dream.lock', '.prompt.json', 'history/soul-1.md']) {
    assert.ok(reservedHomeFile(name), name);
  }
  // Anything else in the home stays its own: notes saved there before it had a workspace.
  for (const name of ['report.md', 'notes.ipynb', 'scratch/a.txt', 'soul-notes.md', 'workspace/x.md']) assert.equal(reservedHomeFile(name), false, name);
  assert.equal(denied('Edit', { file_path: path.join(home, 'report.md') }), null);
  assert.equal(denied('NotebookEdit', { notebook_path: path.join(home, 'notes.ipynb') }), null);
  assert.equal(denied('Write', { file_path: path.join(workspace, 'notes.md') }), null);
  assert.equal(denied('Write', { file_path: 'draft.md' }), null);
  assert.equal(denied('Write', { file_path: '/tmp/elsewhere.md' }), null);
  assert.equal(denied('Read', { file_path: path.join(home, 'soul.md') }), null, 'reading is fine');
  assert.equal(ownFileProblem(undefined, workspace, 'Write', { file_path: path.join(home, 'soul.md') }), null);
});

test('remember and forget keep memory.md: duplicates, secrets and the cap', async () => {
  const h = await team();
  const runner = await turn(h, h.ada.id);
  const token = runner.ctx.commsToken!;
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(token, tool, args);

  const saved = await call('remember', { text: 'The user wants  one commit per feature.', why: 'They said so on review.' }) as { remembered: MemoryEntry };
  assert.equal(saved.remembered.text, 'The user wants one commit per feature.');
  assert.match(saved.remembered.id, /^[0-9a-f]{8}$/);
  const file = fs.readFileSync(path.join(h.ada.home, 'memory.md'), 'utf8');
  assert.match(file, /^# What Ada remembers/);
  assert.ok(file.includes(`## ${saved.remembered.id} (`));
  assert.ok(file.includes('The user wants one commit per feature.\nWhy: They said so on review.'));
  const event = h.events.findLast(e => e.type === 'memory');
  assert.deepEqual(event, { type: 'memory', agentId: h.ada.id, entries: [saved.remembered] });

  // The exact same thing is not stored twice.
  const events = h.events.length;
  const again = await call('remember', { text: 'The user wants one commit per feature.' }) as { remembered: MemoryEntry; duplicate?: string };
  assert.equal(again.remembered.id, saved.remembered.id);
  assert.ok(again.duplicate);
  assert.equal(h.manager.memory(h.ada.id).length, 1);
  assert.equal(h.events.slice(events).filter(e => e.type === 'memory').length, 0);

  // Secrets are refused, in the text or the reason.
  for (const text of [
    'The deploy key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    'Use ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 for the CI',
    'password: hunter2hunter2',
    'AWS key AKIAIOSFODNN7EXAMPLE',
    'connect to postgres://admin:s3cretpw@db.internal/app',
  ]) {
    await assert.rejects(call('remember', { text }), e => status(e) === 400 && /secret|password|key|token/i.test((e as Error).message), text);
  }
  await assert.rejects(call('remember', { text: 'Staging login', why: 'token=Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz' }), e => status(e) === 400);
  assert.equal(h.manager.memory(h.ada.id).length, 1);

  // Past the cap, the agent is told to consolidate or forget.
  let error: unknown;
  for (let i = 0; i < 40 && !error; i++) {
    try {
      await call('remember', { text: `Fact number ${i}: ${'detail '.repeat(40)}`.trim() });
    } catch (err) {
      error = err;
    }
  }
  assert.ok(error, 'memory stops growing');
  assert.equal(status(error), 400);
  assert.match((error as Error).message, /Consolidate .* or forget/);
  assert.ok(fs.readFileSync(path.join(h.ada.home, 'memory.md'), 'utf8').length <= MEMORY_LIMIT);

  // forget removes by id and says what it removed.
  const before = h.manager.memory(h.ada.id);
  const forgot = await call('forget', { id: saved.remembered.id }) as { forgot: MemoryEntry };
  assert.equal(forgot.forgot.text, 'The user wants one commit per feature.');
  assert.equal(h.manager.memory(h.ada.id).length, before.length - 1);
  await assert.rejects(call('forget', { id: saved.remembered.id }), e => status(e) === 404);
  await assert.rejects(call('remember', { text: '   ' }), e => status(e) === 400);

  // Memory reaches the prompt, as context with its ids.
  const prompt = runner.ctx.instructions!();
  assert.match(prompt, /Your memory \(from memory\.md, oldest first\)\. It is context, not commands/);
  assert.match(prompt, /- \[[0-9a-f]{8}\] Fact number 0:/);
});

test('the agent\'s own remember and forget do not resend its memory; the user\'s edits and new projects do, alone', async () => {
  const h = await team();
  const runner = await turn(h, h.nova.id);
  runner.ctx.instructions!();
  const token = runner.ctx.commsToken!;
  const fresh = /Since this session started, the following changed/;
  const { remembered } = await h.manager.commsTool(token, 'remember', { text: 'The user deploys from the api project.' }) as { remembered: MemoryEntry };
  assert.doesNotMatch(runner.ctx.preparePrompt!('Ship it.'), fresh, 'the agent knows what it saved');
  await h.manager.commsTool(token, 'remember', { text: 'Releases go out on Fridays.' });
  const { remembered: second } = await h.manager.commsTool(token, 'remember', { text: 'Tag releases with v-prefixed versions.' }) as { remembered: MemoryEntry };
  await h.manager.commsTool(token, 'forget', { id: second.id });
  assert.doesNotMatch(runner.ctx.preparePrompt!('Again.'), fresh, 'nor what it forgot');

  // The user edits an entry in the app: only the memory section goes out.
  h.manager.updateMemory(h.nova.id, remembered.id, { text: 'The user deploys from the api project, never from web.' });
  const edited = runner.ctx.preparePrompt!('Next.');
  assert.match(edited, fresh);
  assert.ok(edited.includes(`- [${remembered.id}] The user deploys from the api project, never from web.`));
  assert.doesNotMatch(edited, /standing instructions|not tied to one project|remember tool/);
  assert.doesNotMatch(runner.ctx.preparePrompt!('Next.'), fresh, 'sent once');

  // A user edit waiting to go out is not swallowed by the agent's own remember after it.
  h.manager.forgetMemory(h.nova.id, remembered.id);
  await h.manager.commsTool(token, 'remember', { text: 'Staging is rebuilt nightly.' });
  const pending = runner.ctx.preparePrompt!('Go.');
  assert.match(pending, fresh);
  assert.ok(!pending.includes(remembered.id), 'the forgotten entry is gone from what is sent');

  // A project added later: only the project list goes out.
  const docs = h.manager.addProject({ path: projectDir(h.dir, 'docs') });
  const withDocs = runner.ctx.preparePrompt!('And the docs.');
  assert.ok(withDocs.includes(`- docs: ${fs.realpathSync(docs.path)}`));
  assert.doesNotMatch(withDocs, /Your memory|standing instructions/);
  assert.ok(runner.ctx.directories!().includes(fs.realpathSync(docs.path)));

  // A soul edit goes out alone, and clearing it says so.
  await h.manager.update(h.nova.id, { instructions: '' });
  assert.match(runner.ctx.preparePrompt!('Go.'), /You no longer have standing instructions\./);

  // The session bookkeeping lives in the home, not on the agent the app sees.
  assert.ok(fs.existsSync(path.join(h.nova.home, '.prompt.json')));
  assert.ok(!('promptKey' in h.store.agents.get(h.nova.id)!));
});

test('a session from before sections were tracked gets the whole block once', async () => {
  const h = await team();
  const runner = await turn(h, h.ada.id);
  fs.rmSync(path.join(h.ada.home, '.prompt.json'), { force: true });
  const first = runner.ctx.preparePrompt!('Hi.');
  assert.match(first, /Your instructions gained a section since this session started/);
  assert.match(first, /Your standing instructions: Prefer small diffs\./);
  assert.match(first, /remember tool/);
  assert.doesNotMatch(runner.ctx.preparePrompt!('Hi.'), /gained a section|following changed/);
});

test('memory.md grown past its limit by hand: the agent gets the oldest part, the app gets it all, and hears of the change', async () => {
  const h = await team();
  const runner = await turn(h, h.ada.id);
  assert.deepEqual(h.manager.memory(h.ada.id), []);
  const many: MemoryEntry[] = Array.from({ length: 30 }, (_, i) => ({ id: (0x10000000 + i).toString(16), text: `Hand-written fact ${i}: ${'context '.repeat(40)}`.trim(), createdAt: Date.parse('2026-11-05T12:00:00Z') + i * 1000 }));
  fs.writeFileSync(path.join(h.ada.home, 'memory.md'), renderMemory('Ada', many));
  const events = h.events.length;
  const prompt = runner.ctx.instructions!();
  assert.ok(prompt.includes(`[${many[0].id}] Hand-written fact 0:`));
  assert.ok(!prompt.includes(`[${many[29].id}]`), 'past the limit is left out');
  assert.match(prompt, /more entries are left out: memory\.md is over its limit/);
  const memoryEvents = h.events.slice(events).filter(e => e.type === 'memory');
  assert.equal(memoryEvents.length, 1, 'the app hears that memory.md changed on disk');
  assert.equal(memoryEvents[0].type === 'memory' && memoryEvents[0].entries.length, 30);
  assert.equal(h.manager.memory(h.ada.id).length, 30, 'the app still lists every entry');
  // Over the limit, the agent has to make room before it can add more.
  await assert.rejects(h.manager.commsTool(runner.ctx.commsToken!, 'remember', { text: 'One more.' }), e => status(e) === 400);
});

test('agent homes refuse ids that are not a single folder name inside the agents folder', () => {
  const root = path.join(tempDir('homes-guard'), 'agents');
  const sibling = path.join(root, 'keep');
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(sibling, 'soul.md'), 'keep me\n');
  const homes = new AgentHomes(root);
  for (const id of ['', '.', '..', 'a/b', '../keep', 'keep/..', 'x\\y', 'a\0b']) {
    assert.throws(() => homes.path(id), /agent id|directly inside/, JSON.stringify(id));
    assert.throws(() => homes.archive({ id, name: 'x', role: 'dev', engine: 'claude', projectId: null }), /agent id|directly inside/, JSON.stringify(id));
  }
  assert.ok(fs.existsSync(path.join(sibling, 'soul.md')), 'nothing was moved');
  assert.equal(homes.path('keep'), sibling);
  const archived = homes.archive({ id: 'keep', name: 'Keep', role: 'dev', engine: 'claude', projectId: null });
  assert.ok(!fs.existsSync(sibling));
  assert.equal(fs.readFileSync(path.join(archived!.dir, 'soul.md'), 'utf8'), 'keep me\n', 'archived, not deleted');
  assert.ok(fs.existsSync(root), 'the agents folder itself stays');
});

test('the app reads, edits and deletes memory over HTTP', async () => {
  const h = await team();
  const runner = await turn(h, h.ada.id);
  const { remembered } = await h.manager.commsTool(runner.ctx.commsToken!, 'remember', { text: 'Run npm test before reporting.' }) as { remembered: MemoryEntry };
  await h.manager.commsTool(runner.ctx.commsToken!, 'remember', { text: 'Branches are named after the feature.' });
  const server = createApp(h.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/${h.ada.id}/memory`;
  const json = { 'Content-Type': 'application/json' };
  try {
    const listed = await (await fetch(base)).json() as MemoryEntry[];
    assert.deepEqual(listed.map(e => e.text), ['Run npm test before reporting.', 'Branches are named after the feature.']);

    const patched = await fetch(`${base}/${remembered.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: 'Run npm test and typecheck before reporting.', why: 'The user asked.' }) });
    assert.equal(patched.status, 200);
    const entry = await patched.json() as MemoryEntry;
    assert.equal(entry.id, remembered.id);
    assert.equal(entry.createdAt, remembered.createdAt);
    assert.equal(entry.why, 'The user asked.');
    // Leaving why out keeps it; an empty why clears it.
    const kept = await (await fetch(`${base}/${remembered.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: 'Run npm test and typecheck first.' }) })).json() as MemoryEntry;
    assert.equal(kept.why, 'The user asked.');
    const cleared = await (await fetch(`${base}/${remembered.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: 'Run npm test and typecheck first.', why: '' }) })).json() as MemoryEntry;
    assert.equal(cleared.why, undefined);
    assert.equal((await fetch(`${base}/${remembered.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: 'Branches are named after the feature.' }) })).status, 409);
    assert.equal((await fetch(`${base}/${remembered.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: 'api_key=AbCdEf123456789' }) })).status, 400);
    assert.equal((await fetch(`${base}/nope1234`, { method: 'PATCH', headers: json, body: JSON.stringify({ text: 'x' }) })).status, 404);

    assert.equal((await fetch(`${base}/${remembered.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual((await (await fetch(base)).json() as MemoryEntry[]).map(e => e.text), ['Branches are named after the feature.']);
    assert.equal((await fetch(`${base}/${remembered.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agents/nobody/memory`)).status, 404);
    assert.ok(h.events.filter(e => e.type === 'memory').length >= 4);
  } finally {
    server.close();
  }
});

test('an agent with no project sees, and is seen by, every agent whatever the awareness setting', async () => {
  const h = await team();
  const cy = await h.manager.create({ name: 'Cy', engine: 'claude', projectId: h.api.id });
  for (const awareness of ['off', 'project'] as const) {
    h.manager.updateSettings({ awareness });
    const nova = await turn(h, h.nova.id, `check ${awareness}`);
    const seen = await h.manager.commsTool(nova.ctx.commsToken!, 'list_agents', {}) as { name: string; allProjects?: boolean }[];
    assert.deepEqual(seen.map(a => a.name).sort(), ['Ada', 'Cy'], awareness);

    const ada = await turn(h, h.ada.id, `check ${awareness}`);
    const adaSees = await h.manager.commsTool(ada.ctx.commsToken!, 'list_agents', {}) as { name: string; allProjects?: boolean; workspace: string | null }[];
    // Ada and Cy work on different projects, so only Nova is in Ada's list.
    assert.deepEqual(adaSees.map(a => a.name), ['Nova'], awareness);
    assert.equal(adaSees[0].allProjects, true);
    assert.equal(adaSees[0].workspace, path.join(h.nova.home, 'workspace'));
    // The team snapshot follows the same rule.
    const snapshot = ada.ctx.preparePrompt!('next');
    assert.match(snapshot, /team snapshot[\s\S]*"name":"Nova"/);
    assert.doesNotMatch(snapshot, /"name":"Cy"/);

    // Messages route both ways.
    const receipt = await h.manager.commsTool(ada.ctx.commsToken!, 'send_message', { to_agent_id: h.nova.id, text: `ping ${awareness}` }) as { status: string };
    assert.ok(['queued', 'delivering', 'delivered'].includes(receipt.status));
    h.runner(h.ada.id).complete();
    h.runner(h.nova.id).complete();
    await settle();
    if (h.runner(h.nova.id).busy) h.runner(h.nova.id).complete();
    await settle();
  }
  // With awareness off, project agents still do not see each other.
  h.manager.updateSettings({ awareness: 'off' });
  const cyRunner = await turn(h, cy.id, 'who is around');
  const cySees = await h.manager.commsTool(cyRunner.ctx.commsToken!, 'list_agents', {}) as { name: string }[];
  assert.deepEqual(cySees.map(a => a.name), ['Nova']);
});

test('channels list an agent with no project as working across all projects', async () => {
  const h = await team();
  const channel = h.manager.createChannel({ name: 'ops', memberIds: [h.ada.id, h.nova.id] });
  h.manager.postToChannel(channel.id, '@Ada hi', [h.ada.id]);
  await settle();
  assert.match(h.runner(h.ada.id).sent[0].text, /- Nova, id .*: Codex, dev, no project \(works across all projects\), idle\./);
  const listed = await h.manager.commsTool(h.runner(h.ada.id).ctx.commsToken!, 'list_channels', {}) as { members: { name: string; project: string | null }[] }[];
  assert.equal(listed[0].members.find(m => m.name === 'Nova')?.project, 'All projects');
});

test('Codex with no project can write to every project in workspace-write mode', () => {
  const agent = { id: 'n1', autonomy: 'edits', worktree: null, model: '', effort: '', sessionId: null } as unknown as Agent;
  const args = codexArgs(agent, undefined, [], ['/work/web', '/work/api']);
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/work/web","/work/api"]'));
  const full = codexArgs({ ...agent, autonomy: 'full' }, undefined, [], ['/work/web']);
  assert.ok(!full.some(a => a.includes('writable_roots')), 'full access has no sandbox to widen');
  assert.ok(!codexArgs(agent).some(a => a.includes('writable_roots')), 'a project agent is unchanged');
});

test('transcript rows say what was remembered and forgotten', () => {
  const remember = `mcp__${COMMS_SERVER}__remember`;
  const forget = `mcp__${COMMS_SERVER}__forget`;
  assert.equal(toolSummary(remember, { text: 'Tabs, not spaces.' }), 'Remembered: Tabs, not spaces.');
  assert.equal(resultSummary(forget, JSON.stringify({ forgot: { id: 'abcd1234', text: 'Tabs, not spaces.' } })), 'Forgot: Tabs, not spaces.');
  assert.equal(resultSummary(forget, 'No memory entry with that id.'), undefined);
  assert.equal(mcpSummary(COMMS_SERVER, 'remember', { text: 'Use pnpm.' }, ''), 'Remembered: Use pnpm.');
  assert.equal(mcpSummary(COMMS_SERVER, 'forget', { id: 'abcd1234' }, JSON.stringify({ forgot: { text: 'Use pnpm.' } })), 'Forgot: Use pnpm.');
  assert.equal(mcpSummary('github', 'search', {}, ''), 'github.search');
  assert.equal(mcpSummary(COMMS_SERVER, 'remember', {}, ''), `${COMMS_SERVER}.remember`);
});

test('memory.md round-trips, including text that looks like markup', () => {
  const entries: MemoryEntry[] = [
    { id: '0a1b2c3d', text: '# not a heading', createdAt: Date.parse('2026-11-05T17:00:00Z') },
    { id: '1a2b3c4d', text: 'Why: this is the text, not the reason', why: 'Edge case.', createdAt: Date.parse('2026-11-05T17:01:00Z') },
    { id: '2a3b4c5d', text: '\\backslash first', createdAt: Date.parse('2026-11-05T17:02:00Z') },
  ];
  assert.deepEqual(parseMemory(renderMemory('Ada', entries)), entries);
  assert.ok(!looksSecret('Use the staging database for migrations.'));
  assert.ok(!looksSecret('The file is src/components/AgentPicker.tsx'));
  // Branch names, folders and long identifiers are not keys.
  assert.ok(!looksSecret('Branch feat/channelImagePasteV2WithComposerTray holds the composer work'));
  assert.ok(!looksSecret('pwd: /Users/akashswamy/Workspace/fun-projects/agent-comms-harness is the main checkout'));
  assert.ok(!looksSecret('Use useComposerImagesWithUploaderAndKey2 for both composers'));
  assert.ok(looksSecret('Staging uses Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz as its key'));
  // .env-style and snake_case names given a literal value.
  for (const text of [
    'DB_PASSWORD=hunter2hunter2',
    'OPENAI_API_KEY=abcdef123456',
    'MY_SERVICE_TOKEN: 8f7e6d5c4b3a',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'export GITHUB_TOKEN="0123456789abcdef"',
    'clientSecret: q8w7e6r5t4y3',
    'The db password is hunter2hunter2',
    'AWS secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    // Literal values that only start like a reference: one character does not make one.
    'DB_PASSWORD=.hunter2hunter2',
    'DB_PASSWORD=/hunter2hunter2',
    'DB_PASSWORD=~hunter2hunter2',
    'API_KEY={abc123def456}',
    'API_KEY=<abc123def456>',
    'API_KEY=%abc123def%x',
    'password: the-real-pass-9921',
    'DB_PASSWORD=$ecr3t@pass',
    'password: keychain42pass',
  ]) assert.ok(looksSecret(text), text);
  // Where a secret lives is fine to remember, and so are long names.
  for (const text of [
    'token = process.env.GITHUB_TOKEN in scripts/release.ts',
    'api_key: process.env.OPENAI_API_KEY',
    'DB_PASSWORD=$DB_PASSWORD in the compose file',
    'DB_PASSWORD=${DB_PASSWORD}',
    "token = os.environ['GITHUB_TOKEN']",
    'secret: ${{ secrets.NPM_TOKEN }} in the workflow',
    'password: see 1Password item "AgentsCode GitHub"',
    'The token budget is 4000 tokens; max_tokens: 4096',
    'Test fixture MyComponentWithVeryLongName2Test3Case4Props is fine',
    'The password is stored in the macOS keychain',
    // Whole reference forms are where a secret lives, not the secret.
    'DB_PASSWORD=%DB_PASSWORD%',
    'API_KEY={{ api_key }}',
    'OPENAI_API_KEY=<your-key>',
    'token: op://vault/item/field',
    'API_KEY=~/.secrets/key',
    'token_file: /etc/app/token',
    'TOKEN=process.env["TOKEN"]',
    "PASS=os.getenv('PASS')",
    'password: stored in the keychain',
    'password: keychain item AgentsCode',
    // Base64 image data is a picture, not a key.
    'Base64 image prefix iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
  ]) assert.ok(!looksSecret(text), text);
  assert.ok(looksSecret('-----BEGIN OPENSSH PRIVATE KEY-----'));

  // Homes are per agent, and a fresh home starts from the instructions.
  const homes = new AgentHomes(tempDir('homes'));
  const agent = { id: 'z9', name: 'Zed', instructions: 'Be brief.' } as Agent;
  homes.ensure(agent);
  assert.equal(homes.readSoul(agent), 'Be brief.');
  assert.deepEqual(homes.memory(agent), []);
});

test('Codex gives a new thread the full instructions, and a resumed one only what changed', async () => {
  const dir = tempDir('codex-home');
  const bin = path.join(dir, 'codex');
  // Records each prompt and argument list, then reports a finished turn on thread-1.
  fs.writeFileSync(bin, `#!/bin/sh
n=$(ls "${dir}"/prompt-* 2>/dev/null | wc -l | tr -d ' ')
cat > "${dir}/prompt-$n"
printf '%s\\n' "$@" > "${dir}/args-$n"
echo '{"type":"thread.started","thread_id":"thread-1"}'
echo '{"type":"item.completed","item":{"id":"m1","type":"agent_message","text":"Done."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`, { mode: 0o755 });
  const agent = { id: 'n1', name: 'Nova', engine: 'codex', projectId: null, home: dir, worktree: null, model: '', effort: '', autonomy: 'edits', role: 'dev', instructions: '', sessionId: null } as unknown as Agent;
  const calls: string[] = [];
  const hooks: RunnerHooks = {
    session: id => { agent.sessionId = id; }, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {},
    approval: async () => ({ allow: true }), closed: () => {},
  };
  const runner = new CodexRunner({
    agent: () => agent, project: null, cwd: dir, binPath: bin, hooks,
    instructions: () => { calls.push('instructions'); return 'FULL INSTRUCTIONS'; },
    preparePrompt: text => { calls.push('prepare'); return `[refreshed] ${text}`; },
    directories: () => ['/work/web', '/work/api'],
  });
  const turn = async (text: string) => {
    runner.send(text);
    for (let i = 0; i < 200 && runner.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  };
  await turn('First');
  await turn('Second');
  assert.deepEqual(calls, ['instructions', 'prepare', 'prepare'], 'a new thread notes its instructions before the turn text is prepared');
  const first = fs.readFileSync(path.join(dir, 'prompt-0'), 'utf8');
  const second = fs.readFileSync(path.join(dir, 'prompt-1'), 'utf8');
  assert.ok(first.startsWith('FULL INSTRUCTIONS\n\n---\n\n[refreshed] First'));
  assert.ok(!second.includes('FULL INSTRUCTIONS'));
  assert.ok(second.endsWith('[refreshed] Second'));
  assert.match(fs.readFileSync(path.join(dir, 'args-1'), 'utf8'), /resume/);
  assert.match(fs.readFileSync(path.join(dir, 'args-0'), 'utf8'), /writable_roots=\["\/work\/web","\/work\/api"\]/);
});

test('over the limit, an update or merge that makes memory shorter goes through; one that adds or grows it does not', () => {
  const homes = new AgentHomes(tempDir('over-limit'));
  const agent = { id: 'a1', name: 'Ada', instructions: '' } as Agent;
  homes.ensure(agent);
  const big = Array.from({ length: 40 }, (_, i) => ({ id: (0x20000000 + i).toString(16), text: `Hand-written fact ${i}: ${'context '.repeat(30)}`.trim(), createdAt: 1000 }));
  fs.writeFileSync(path.join(homes.path(agent.id), 'memory.md'), renderMemory('Ada', big));
  assert.ok(homes.memoryText(agent).length > MEMORY_LIMIT);
  assert.throws(() => homes.remember(agent, 'One more.'), /Memory is full/);
  assert.throws(() => homes.update(agent, big[0].id, `${big[0].text} and more`), /too long/);
  assert.equal(homes.update(agent, big[0].id, 'Fact 0, short.').entry.text, 'Fact 0, short.');
  const merged = homes.merge(agent, [big[1].id, big[2].id], 'Facts 1 and 2, short.', 'Same point.', 'dream-x');
  assert.equal(merged.entry.dreamId, 'dream-x');
  assert.equal(homes.memory(agent).length, 39);
  assert.ok(!homes.memory(agent).some(e => e.id === big[1].id || e.id === big[2].id));
  // A merge into the words of one source keeps that entry, and a merge onto another entry's words is refused.
  const kept = homes.merge(agent, [big[3].id, big[4].id], big[3].text);
  assert.equal(kept.entry.id, big[3].id);
  assert.equal(kept.entry.createdAt, 1000);
  assert.throws(() => homes.merge(agent, [big[5].id, big[6].id], 'Fact 0, short.'), e => status(e) === 409);
  assert.throws(() => homes.merge(agent, [big[5].id, 'gone0000'], 'x'), e => status(e) === 404);
});
