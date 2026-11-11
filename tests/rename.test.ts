import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { envVar, linkClaudeSessions, migrateDataDir, resolveDataDir, rewriteStatePaths } from '../server/dataDir.ts';
import { commsTool, commsToolPattern, currentCommsName, isCommsServer } from '../shared/commsTools.ts';
import { toolSummary } from '../server/agents/describe.ts';
import { MEMORY_TOOLS, SENDING_TOOLS } from '../web/activity.ts';
import { migrateStorage } from '../web/storageMigration.ts';
import { commsMcpConfig } from '../server/comms/tools.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { tempDir } from './helpers.ts';

// PodCode was AgentsCode (ALL-D4, ALL-D5, ALL-D6). Every test here works in a temp home: the real
// ~/.agentscode (where the running app and its agents live) is never touched.

const quiet = () => {};

function home(): string {
  return fs.realpathSync(tempDir('home'));
}

function oldHome(h: string, agents: Record<string, unknown>[] = []): string {
  const old = path.join(h, '.agentscode');
  fs.mkdirSync(path.join(old, 'agents', 'a1', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(old, 'state.json'), JSON.stringify({ version: 1, agents, projects: [], messages: [{ text: `see ${old}/agents/a1` }] }));
  fs.writeFileSync(path.join(old, 'agents', 'a1', 'memory.md'), 'kept');
  return old;
}

// ---- the data folder ------------------------------------------------------------------------------

test('fresh install: ~/.podcode is made, and nothing named .agentscode appears', () => {
  const h = home();
  const r = migrateDataDir({ home: h, env: {}, log: quiet });
  assert.equal(r.action, 'fresh');
  assert.equal(r.dir, path.join(h, '.podcode'));
  assert.ok(fs.statSync(path.join(h, '.podcode')).isDirectory());
  assert.ok(!fs.existsSync(path.join(h, '.agentscode')));
});

test('old only: the folder moves, the old name links to it, agent paths are rewritten, prose is not', () => {
  const h = home();
  const old = path.join(h, '.agentscode');
  const fresh = path.join(h, '.podcode');
  oldHome(h, [{
    id: 'a1', name: 'Ada', home: `${old}/agents/a1`, sessionCwd: `${old}/agents/a1/workspace`,
    worktree: { path: `${old}/worktrees/p/ada`, cwd: `${old}/worktrees/p/ada`, gitDir: '/repo/.git/worktrees/ada', branch: 'b' },
    workingIn: { projectId: 'p', root: `${old}/worktrees/p/ada`, at: 1 },
  }, { id: 'a2', name: 'Bo', home: '/elsewhere/a2' }]);
  const lines: string[] = [];
  const r = migrateDataDir({ home: h, env: {}, log: line => lines.push(line) });
  assert.equal(r.action, 'moved');
  assert.ok(fs.lstatSync(fresh).isDirectory() && !fs.lstatSync(fresh).isSymbolicLink());
  assert.ok(fs.lstatSync(old).isSymbolicLink(), '~/.agentscode is now a link');
  assert.equal(fs.realpathSync(old), fresh);
  assert.equal(fs.readFileSync(path.join(old, 'agents', 'a1', 'memory.md'), 'utf8'), 'kept', 'old paths still reach the data');
  const state = JSON.parse(fs.readFileSync(path.join(fresh, 'state.json'), 'utf8'));
  const ada = state.agents[0];
  assert.equal(ada.home, `${fresh}/agents/a1`);
  assert.equal(ada.sessionCwd, `${fresh}/agents/a1/workspace`);
  assert.equal(ada.worktree.path, `${fresh}/worktrees/p/ada`);
  assert.equal(ada.worktree.gitDir, '/repo/.git/worktrees/ada', 'a path outside the data folder is left alone');
  assert.equal(ada.workingIn.root, `${fresh}/worktrees/p/ada`);
  assert.equal(state.agents[1].home, '/elsewhere/a2');
  assert.equal(state.messages[0].text, `see ${old}/agents/a1`, 'messages are history: untouched');
  assert.ok(lines.some(l => /Moved/.test(l)) && lines.some(l => /Rewrote 5 saved paths/.test(l)), lines.join('\n'));
});

test('running it again changes nothing; a link already in place is left as it is', () => {
  const h = home();
  oldHome(h);
  migrateDataDir({ home: h, env: {}, log: quiet });
  const before = fs.readlinkSync(path.join(h, '.agentscode'));
  const again = migrateDataDir({ home: h, env: {}, log: quiet });
  assert.equal(again.action, 'ready');
  assert.equal(fs.readlinkSync(path.join(h, '.agentscode')), before);
});

test('both real folders: ~/.podcode is used and ~/.agentscode is left exactly as it is', () => {
  const h = home();
  oldHome(h);
  fs.mkdirSync(path.join(h, '.podcode'));
  fs.writeFileSync(path.join(h, '.podcode', 'state.json'), '{"version":1,"agents":[]}');
  const lines: string[] = [];
  const r = migrateDataDir({ home: h, env: {}, log: line => lines.push(line) });
  assert.equal(r.action, 'both');
  assert.ok(!fs.lstatSync(path.join(h, '.agentscode')).isSymbolicLink(), 'not replaced by a link');
  assert.equal(fs.readFileSync(path.join(h, '.agentscode', 'agents', 'a1', 'memory.md'), 'utf8'), 'kept');
  assert.ok(lines.some(l => /left as it is/.test(l)));
});

test('a dangling link (to nothing, or to a missing ~/.podcode) and no ~/.podcode: a new folder is made and the link is left alone', () => {
  for (const pick of [(h: string) => path.join(h, 'gone'), (h: string) => path.join(h, '.podcode')]) {
    const h = home();
    const target = pick(h);
    fs.symlinkSync(target, path.join(h, '.agentscode'));
    const r = migrateDataDir({ home: h, env: {}, log: quiet });
    assert.equal(r.action, 'fresh', target);
    assert.ok(fs.statSync(path.join(h, '.podcode')).isDirectory());
    assert.equal(fs.readlinkSync(path.join(h, '.agentscode')), target);
  }
});

test('~/.agentscode as the user\'s own link to data elsewhere: the link moves to ~/.podcode and the data is used', () => {
  const h = home();
  const synced = path.join(h, 'Dropbox', 'agentscode');
  fs.mkdirSync(path.join(synced, 'agents', 'a1'), { recursive: true });
  const old = path.join(h, '.agentscode');
  const fresh = path.join(h, '.podcode');
  fs.writeFileSync(path.join(synced, 'state.json'), JSON.stringify({ version: 1, agents: [{ id: 'a1', home: `${old}/agents/a1` }] }));
  fs.writeFileSync(path.join(synced, 'agents', 'a1', 'memory.md'), 'kept');
  fs.symlinkSync(synced, old, 'dir');
  const r = migrateDataDir({ home: h, env: {}, log: quiet });
  assert.equal(r.action, 'moved');
  assert.equal(fs.realpathSync(fresh), synced, '~/.podcode points at the same data');
  assert.equal(fs.realpathSync(old), synced, 'and so does the old name');
  assert.equal(fs.readFileSync(path.join(fresh, 'agents', 'a1', 'memory.md'), 'utf8'), 'kept');
  assert.equal(JSON.parse(fs.readFileSync(path.join(synced, 'state.json'), 'utf8')).agents[0].home, `${fresh}/agents/a1`);
  assert.equal(resolveDataDir(h, {}), fresh);
  assert.equal(migrateDataDir({ home: h, env: {}, log: quiet }).action, 'ready');
});

test('an empty ~/.podcode beside ~/.agentscode with state: the empty one is set aside and the data moves in', () => {
  const h = home();
  oldHome(h);
  fs.mkdirSync(path.join(h, '.podcode'));
  const r = migrateDataDir({ home: h, env: {}, log: quiet });
  assert.equal(r.action, 'moved');
  assert.equal(fs.readFileSync(path.join(h, '.podcode', 'agents', 'a1', 'memory.md'), 'utf8'), 'kept');
  assert.ok(fs.statSync(path.join(h, '.podcode-unused-1')).isDirectory(), 'set aside, not deleted');
  assert.ok(fs.lstatSync(path.join(h, '.agentscode')).isSymbolicLink());
});

test('PODCODE_HOME (or the old AGENTSCODE_HOME) set: no migration, and that folder is used', () => {
  const h = home();
  oldHome(h);
  assert.equal(migrateDataDir({ home: h, env: { PODCODE_HOME: '/x' }, log: quiet }).action, 'skipped');
  assert.equal(migrateDataDir({ home: h, env: { AGENTSCODE_HOME: '/y' }, log: quiet }).action, 'skipped');
  assert.ok(!fs.lstatSync(path.join(h, '.agentscode')).isSymbolicLink(), 'nothing moved');
  assert.equal(resolveDataDir(h, { PODCODE_HOME: '/x', AGENTSCODE_HOME: '/y' }), '/x', 'the new name wins');
  assert.equal(resolveDataDir(h, { AGENTSCODE_HOME: '/y' }), '/y');
});

test('before the first PodCode start, the data folder resolves to ~/.agentscode, never an empty new one', () => {
  const h = home();
  assert.equal(resolveDataDir(h, {}), path.join(h, '.podcode'), 'fresh install');
  oldHome(h);
  assert.equal(resolveDataDir(h, {}), path.join(h, '.agentscode'), 'old data, not migrated yet');
  assert.ok(!fs.existsSync(path.join(h, '.podcode')), 'resolving creates nothing');
  migrateDataDir({ home: h, env: {}, log: quiet });
  assert.equal(resolveDataDir(h, {}), path.join(h, '.podcode'));
});

test('rewriteStatePaths: an unreadable state file is left alone', () => {
  const h = home();
  const file = path.join(h, 'state.json');
  fs.writeFileSync(file, 'not json');
  assert.equal(rewriteStatePaths(file, '/a/.agentscode', '/a/.podcode'), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
});

test('Claude Code sessions: a link under the new path name for each old one, never replacing one', () => {
  const h = home();
  const projects = path.join(h, '.claude', 'projects');
  const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const oldName = enc(path.join(h, '.agentscode', 'agents', 'a1', 'workspace'));
  const newName = enc(path.join(h, '.podcode', 'agents', 'a1', 'workspace'));
  const otherOld = enc(path.join(h, '.agentscode', 'agents', 'a2', 'workspace'));
  const otherNew = enc(path.join(h, '.podcode', 'agents', 'a2', 'workspace'));
  for (const n of [oldName, otherOld, otherNew, enc('/some/project')]) fs.mkdirSync(path.join(projects, n), { recursive: true });
  fs.writeFileSync(path.join(projects, oldName, 's1.jsonl'), 'session');
  assert.equal(linkClaudeSessions(h), 1, 'a2 already has its new name');
  assert.ok(fs.lstatSync(path.join(projects, newName)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(projects, newName, 's1.jsonl'), 'utf8'), 'session');
  assert.ok(!fs.lstatSync(path.join(projects, otherNew)).isSymbolicLink(), 'an existing folder is not replaced');
  assert.equal(linkClaudeSessions(h), 0, 'idempotent');
});

test('env settings: the PodCode name first, the AgentsCode name as a fallback', () => {
  assert.equal(envVar('TOKEN', { PODCODE_TOKEN: 'new', AGENTSCODE_TOKEN: 'old' }), 'new');
  assert.equal(envVar('TOKEN', { AGENTSCODE_TOKEN: 'old' }), 'old');
  assert.equal(envVar('TOKEN', {}), undefined);
});

// ---- the MCP server name ----------------------------------------------------------------------------

test('the team tools are served as podcode; calls under either name and either form are recognised', () => {
  assert.equal(COMMS_SERVER, 'podcode');
  const config = commsMcpConfig('tok');
  assert.deepEqual(Object.keys(config.env).filter(k => /CODE_/.test(k)).sort(), ['PODCODE_TOKEN', 'PODCODE_TOOLS_URL']);
  for (const name of ['mcp__podcode__send_message', 'mcp__agentscode__send_message', 'podcode.send_message', 'agentscode.send_message']) {
    assert.equal(commsTool(name), 'send_message', name);
    assert.ok(SENDING_TOOLS.test(name), name);
  }
  assert.ok(MEMORY_TOOLS.test('mcp__agentscode__remember') && MEMORY_TOOLS.test('mcp__podcode__forget'));
  assert.equal(commsTool('mcp__github__list_prs'), null);
  assert.equal(commsTool('mcp__podcodex__send_message'), null, 'a different server is not ours');
  assert.equal(currentCommsName('mcp__agentscode__remember'), 'mcp__podcode__remember');
  assert.equal(currentCommsName('Bash'), 'Bash');
  assert.ok(isCommsServer('agentscode') && isCommsServer('podcode') && !isCommsServer('github'));
  assert.ok(commsToolPattern('ref_get').test('agentscode.ref_get'));
});

test('a transcript from before the rename reads the same: old tool names get the same summaries', () => {
  const input = { text: 'Ship on Fridays', why: 'the user said so' };
  assert.equal(toolSummary('mcp__agentscode__remember', input), toolSummary('mcp__podcode__remember', input));
  assert.match(toolSummary('mcp__agentscode__remember', input), /^Remembered: Ship on Fridays/);
  assert.equal(toolSummary('mcp__agentscode__browser_open', { url: 'http://x' }), toolSummary('mcp__podcode__browser_open', { url: 'http://x' }));
});

test('an agent process started before the rename (AGENTSCODE_* env) still reaches the team tools', async () => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { createApp } = await import('../server/app.ts');
  const { harness, projectDir } = await import('./helpers.ts');
  const h = harness();
  const project = h.manager.addProject({ path: projectDir(h.dir, 'site') });
  const server = createApp(h.manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: project.id });
    const bo = await h.manager.create({ name: 'Bo', engine: 'claude', projectId: project.id });
    h.manager.send(ada.id, 'Hi');
    const token = h.runner(ada.id).ctx.commsToken!;
    const config = commsMcpConfig(token);
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // The old names only, as the old server set them.
      env: { AGENTSCODE_TOKEN: token, AGENTSCODE_TOOLS_URL: `http://127.0.0.1:${port}/api/comms`, PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'agent', version: '1.0.0' });
    await client.connect(transport);
    try {
      const listed = await client.callTool({ name: 'list_agents', arguments: {} });
      const roster = JSON.parse((listed.content as { text: string }[])[0].text) as { id: string }[];
      assert.deepEqual(roster.map(r => r.id), [bo.id]);
    } finally {
      await client.close();
    }
  } finally {
    server.close();
  }
});

// ---- the window's settings ----------------------------------------------------------------------------

test('localStorage: agentscode keys are copied to podcode names, never overwriting, and the old ones stay', () => {
  const data = new Map<string, string>([
    ['agentscode:layout', '{"tabs":[]}'],
    ['agentscode.commsSeen', '5'],
    ['agentscode:theme', 'light'],
    ['podcode:theme', 'dark'],
    ['other', 'x'],
  ]);
  const storage = {
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
  assert.equal(migrateStorage(storage), 2);
  assert.equal(data.get('podcode:layout'), '{"tabs":[]}');
  assert.equal(data.get('podcode.commsSeen'), '5');
  assert.equal(data.get('podcode:theme'), 'dark', 'an existing PodCode value wins');
  assert.equal(data.get('agentscode:layout'), '{"tabs":[]}', 'the old key stays, for an older build');
  assert.equal(migrateStorage(storage), 0, 'idempotent');
});
