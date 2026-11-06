import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Agent, Entry } from '../shared/types.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { discoverOrcacodeModels, listingProblem, orcacodeContextWindow, parseOrcacodeModelList, parseOrcacodeModels, parseOrcacodeProviders } from '../server/models.ts';
import { filterOptions } from '../web/mono/filter.ts';
import { discoverCommands } from '../server/skills.ts';
import type { ApprovalRequest, RunnerHooks, TurnResult } from '../server/agents/runner.ts';
import {
  normalizeTool, ORCACODE_COMMS_NOTE, ORCACODE_MAX_STEPS, orcacodeArgs, orcacodeMcpConfig, OrcacodeRunner, orcacodeUsage,
} from '../server/agents/orcacode.ts';
import { harness, projectDir, tempDir } from './helpers.ts';
import { engineProblem, ORCACODE_MIN_VERSION, orcacodeModelValue, splitOrcacodeModel, versionBelow } from '../shared/engines.ts';

const base: Agent = {
  id: 'a1', name: 'Ada', engine: 'orcacode', projectId: 'p1', worktree: null, home: '/tmp/agentscode-test/agents/a1', dreaming: true, model: '', effort: '',
  autonomy: 'ask', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
  currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
  costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
};
const files = { prompt: '/tmp/p dir/prompt.md', mcp: '/tmp/p dir/mcp.json' };

test('orcacode args read the prompt and MCP config from files and map autonomy to modes', () => {
  assert.deepEqual(orcacodeArgs(base, files), [
    '--json', '--prompt-file', '/tmp/p dir/prompt.md', '--max-steps', String(ORCACODE_MAX_STEPS), '--approvals', 'stdio', '--mcp-config', '/tmp/p dir/mcp.json',
  ]);
  const flags = (autonomy: Agent['autonomy']) => orcacodeArgs({ ...base, autonomy }, files);
  assert.ok(flags('readonly').includes('--read-only') && flags('readonly').includes('stdio'));
  assert.ok(flags('edits').includes('--auto') && !flags('edits').includes('--approvals'));
  assert.ok(flags('full').includes('--yolo') && !flags('full').includes('--approvals'));
  assert.ok(!orcacodeArgs(base, { prompt: files.prompt }).includes('--mcp-config'));
});

test('orcacode resume, model, effort and images are passed as separate arguments', () => {
  const args = orcacodeArgs({ ...base, sessionId: 'sess-1', model: 'gpt-6-sol', effort: 'high' }, files, [{ path: '/tmp/a b.png', mediaType: 'image/png' }]);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after('--resume'), 'sess-1');
  assert.equal(after('--model'), 'gpt-6-sol');
  assert.equal(after('--effort'), 'high');
  assert.equal(after('--image'), '/tmp/a b.png');
});

test('the comms server goes to orcacode as one --mcp-config entry with the token in env', () => {
  const config = JSON.parse(orcacodeMcpConfig('secret-token'));
  assert.deepEqual(Object.keys(config), [COMMS_SERVER]);
  assert.equal(config[COMMS_SERVER].env.AGENTSCODE_TOKEN, 'secret-token');
  assert.ok(Array.isArray(config[COMMS_SERVER].args) && typeof config[COMMS_SERVER].command === 'string');
});

test('orcacode usage maps cacheCreateTokens to cache writes and ignores junk', () => {
  assert.deepEqual(orcacodeUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheCreateTokens: 3, cost: 0.1 }), { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 3 });
  assert.deepEqual(orcacodeUsage({ inputTokens: -1, outputTokens: 'x' }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(orcacodeUsage(undefined), undefined);
});

test('orcacode tools are shown under the names the transcript describes', () => {
  assert.deepEqual(normalizeTool('shell', { command: 'npm test' }), { name: 'Bash', input: { command: 'npm test' } });
  assert.deepEqual(normalizeTool('read_file', { path: 'src/a.ts' }), { name: 'Read', input: { file_path: 'src/a.ts' } });
  assert.deepEqual(normalizeTool('edit_file', { path: 'a.ts', old: 'x', new: 'y' }), { name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } });
  assert.equal(normalizeTool('edit_file', { edits: [{ path: 'a.ts', old: 'x', new: 'y' }] }).name, 'MultiEdit');
  assert.deepEqual(normalizeTool('grep', { query: 'TODO' }), { name: 'Grep', input: { pattern: 'TODO', path: undefined } });
  assert.deepEqual(normalizeTool(`mcp__${COMMS_SERVER}__list_agents`, {}), { name: `mcp__${COMMS_SERVER}__list_agents`, input: {} });
});

test('orcacode --list-models lines become model ids with context windows', () => {
  assert.deepEqual(parseOrcacodeModels('gpt-6.1-sol  500k ctx\ngpt-6-luna  272k ctx\nlocal-model\n\n'), [
    { id: 'gpt-6.1-sol', window: 500_000 }, { id: 'gpt-6-luna', window: 272_000 }, { id: 'local-model', window: undefined },
  ]);
});

test('orcacode skills come from its own roots', () => {
  const dir = tempDir('orca-skills');
  const cwd = projectDir(dir, 'repo');
  const home = projectDir(dir, 'home');
  for (const [root, name] of [[path.join(cwd, '.orca', 'skills'), 'release'], [path.join(home, '.config', 'orcacode', 'skills'), 'review']]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} things\n---\nDo ${name}.\n`);
  }
  const found = discoverCommands('orcacode', cwd, home);
  assert.deepEqual(found.map(c => [c.name, c.scope]).sort(), [['release', 'project'], ['review', 'user']]);
});

/**
 * A stand-in orcacode: records its arguments and files, streams one turn's NDJSON events, asks
 * for one approval over stdin when --approvals stdio is on, and ends with a summary.
 */
function fakeOrcacode(dir: string): string {
  const bin = path.join(dir, 'orca code bin', 'orcacode');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const after = flag => args[args.indexOf(flag) + 1];
const out = ${JSON.stringify(dir)};
const prompt = fs.readFileSync(after('--prompt-file'), 'utf8');
fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({ args, prompt, mcp: args.includes('--mcp-config') ? fs.readFileSync(after('--mcp-config'), 'utf8') : null }));
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const sessionId = args.includes('--resume') ? after('--resume') : 'sess-1';
emit({ type: 'metadata', model: 'gpt-6-sol', sessionId, resumed: args.includes('--resume') });
emit({ type: 'tool_call', tool_call_id: 'c1', tool_name: 'shell', input: { command: 'npm test' } });
const finish = decision => {
  fs.writeFileSync(path.join(out, 'decision.txt'), decision);
  emit({ type: 'tool_result', tool_call_id: 'c1', tool_name: 'shell', output: 'all passed', is_error: false });
  emit({ type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheCreateTokens: 0 } });
  emit({ type: 'assistant', message: 'Done.' });
  emit({ type: 'result', message: 'Done.' });
  const status = prompt.includes('MAXSTEPS') ? 'max_steps' : 'success';
  emit({ type: 'summary', status, sessionId, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheCreateTokens: 5, cost: 0.01 } });
  process.exit(status === 'success' ? 0 : 1);
};
if (args.includes('stdio')) {
  emit({ type: 'approval_request', id: 'approval-1', tool_call_id: 'c1', tool_name: 'shell', input: { command: 'npm test' } });
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const line = buffer.split('\\n')[0];
    if (buffer.includes('\\n')) finish(line);
  });
} else finish('none');
`, { mode: 0o755 });
  return bin;
}

function runnerFor(dir: string, agent: Agent, approve: (request: ApprovalRequest) => boolean) {
  const results: TurnResult[] = [];
  const entries: Entry[] = [];
  const approvals: ApprovalRequest[] = [];
  const contexts: { used?: number; window?: number }[] = [];
  const hooks: RunnerHooks = {
    session: id => { agent.sessionId = id; },
    entry: entry => { entries.push(entry as Entry); },
    activity: () => {}, turnStart: () => {}, closed: () => {},
    context: reading => { contexts.push(reading); },
    turnEnd: result => { results.push(result); },
    approval: async request => { approvals.push(request); return { allow: approve(request) }; },
  };
  const runner = new OrcacodeRunner({
    agent: () => agent,
    project: { id: 'p1', name: 'App', path: dir, createdAt: 0, exists: true, isGit: false },
    cwd: dir, binPath: fakeOrcacode(dir), hooks, commsToken: 'tok-1',
  });
  const turn = async (text: string) => {
    runner.send(text);
    for (let i = 0; i < 300 && runner.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const run = () => JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as { args: string[]; prompt: string; mcp: string | null };
  return { runner, results, entries, approvals, contexts, turn, run };
}

test('the OrcaCode runner runs a turn: session, tools, approval over stdin, usage, then resumes', async () => {
  const dir = tempDir('orca-runner');
  const agent: Agent = { ...base };
  const r = runnerFor(dir, agent, () => true);

  await r.turn('First');
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].ok, true, r.results[0].error ?? '');
  assert.equal(r.results[0].summary, 'Done.');
  assert.deepEqual(r.results[0].usage, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 5 });
  assert.equal(r.results[0].costUsd, 0.01);
  assert.equal(agent.sessionId, 'sess-1');

  // The approval went to the user and the answer back over stdin.
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].toolName, 'Bash');
  assert.match(r.approvals[0].title, /npm test/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'decision.txt'), 'utf8')), { type: 'approval', id: 'approval-1', decision: 'allow' });

  // One tool row, running then finished with its output, and the reply.
  const tool = r.entries.filter(e => e.kind === 'tool');
  assert.equal(new Set(tool.map(e => e.id)).size, 1);
  assert.deepEqual(tool.map(e => e.tool?.status), ['running', 'ok']);
  assert.equal(tool[1].tool?.output, 'all passed');
  assert.ok(r.entries.some(e => e.kind === 'agent' && e.text === 'Done.'));
  assert.ok(r.contexts.some(c => c.used === 1000));

  // The first prompt carries the instructions and the OrcaCode MCP note; the config the token.
  const first = r.run();
  assert.match(first.prompt, /You are Ada/);
  assert.ok(first.prompt.includes(ORCACODE_COMMS_NOTE));
  assert.equal(JSON.parse(first.mcp!)[COMMS_SERVER].env.AGENTSCODE_TOKEN, 'tok-1');
  // The private folder with the prompt and token is gone after the turn.
  assert.equal(fs.existsSync(path.dirname(first.args[first.args.indexOf('--prompt-file') + 1])), false);

  await r.turn('Second');
  const second = r.run();
  assert.equal(second.args[second.args.indexOf('--resume') + 1], 'sess-1');
  assert.doesNotMatch(second.prompt, /You are Ada/);
  assert.match(second.prompt, /Second$/);
  assert.equal(r.results[1].ok, true);
});

test('a denied approval is written as deny, and a turn that runs out of steps says so', async () => {
  const dir = tempDir('orca-deny');
  const r = runnerFor(dir, { ...base }, () => false);
  await r.turn('Go MAXSTEPS');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'decision.txt'), 'utf8')).decision, 'deny');
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error ?? '', new RegExp(`${ORCACODE_MAX_STEPS} model steps`));
  assert.ok(r.results[0].usage, 'usage is still reported');
});

test('full autonomy runs with --yolo and keeps stdin closed', async () => {
  const dir = tempDir('orca-yolo');
  const r = runnerFor(dir, { ...base, autonomy: 'full' }, () => true);
  await r.turn('Go');
  assert.equal(r.approvals.length, 0);
  assert.ok(r.run().args.includes('--yolo'));
  assert.equal(fs.readFileSync(path.join(dir, 'decision.txt'), 'utf8'), 'none');
  assert.equal(r.results[0].ok, true);
});

test('the manager creates OrcaCode agents and names the engine in errors', async () => {
  const h = harness({ orcacode: { available: false, path: null, version: null } });
  const project = h.manager.addProject({ path: projectDir(h.dir, 'app') });
  await assert.rejects(h.manager.create({ name: 'Orc', engine: 'orcacode', projectId: project.id }), /OrcaCode is not installed/);
  await assert.rejects(h.manager.create({ name: 'Orc', engine: 'nope' as Agent['engine'], projectId: project.id }), /Pick Claude Code, Codex or OrcaCode/);
  const old = harness({ orcacode: { available: true, path: '/bin/orcacode', version: '0.9.0' } });
  const oldProject = old.manager.addProject({ path: projectDir(old.dir, 'app') });
  await assert.rejects(old.manager.create({ name: 'Orc', engine: 'orcacode', projectId: oldProject.id }), /0\.10\.0 or newer is needed \(found 0\.9\.0\)/);
  const ok = harness({ orcacode: { available: true, path: '/bin/orcacode', version: '0.10.0' } });
  const app = ok.manager.addProject({ path: projectDir(ok.dir, 'app') });
  const orc = await ok.manager.create({ name: 'Orc', engine: 'orcacode', projectId: app.id });
  assert.equal(orc.engine, 'orcacode');
  assert.equal(orc.useMcp, false);
  // Its file tools stay inside the folder it runs in, so it needs a project.
  await assert.rejects(ok.manager.create({ name: 'Roam', engine: 'orcacode', projectId: null }), /OrcaCode agents need a project/);
});

test('engine versions compare numerically and only OrcaCode has a minimum', () => {
  assert.equal(versionBelow('0.9.0', '0.10.0'), true);
  assert.equal(versionBelow('0.10.0', '0.10.0'), false);
  assert.equal(versionBelow('1.0.0', '0.10.0'), false);
  assert.equal(versionBelow('garbage', '0.10.0'), false);
  assert.equal(engineProblem('codex', { available: true, path: '/x', version: '0.0.1' }, true), null);
  assert.equal(engineProblem('orcacode', { available: true, path: '/x', version: ORCACODE_MIN_VERSION }, false), null);
  assert.match(engineProblem('orcacode', { available: false, path: null, version: null }, false) ?? '', /not installed/);
});

test('an orcacode too old for the headless flags fails with an update hint, not its help text', async () => {
  const dir = tempDir('orca-old');
  const bin = path.join(dir, 'orcacode');
  fs.writeFileSync(bin, `#!/bin/sh\necho "unknown flag: --prompt-file" >&2\necho "" >&2\necho "orcacode — terminal host for Orca Harness" >&2\nfor i in 1 2 3 4 5 6; do echo "  --option$i  some help line" >&2; done\nexit 1\n`, { mode: 0o755 });
  const results: TurnResult[] = [];
  const runner = new OrcacodeRunner({
    agent: () => ({ ...base }),
    project: { id: 'p1', name: 'App', path: dir, createdAt: 0, exists: true, isGit: false },
    cwd: dir, binPath: bin,
    hooks: { session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, closed: () => {}, turnEnd: r => { results.push(r); }, approval: async () => ({ allow: false }) },
  });
  runner.send('Hi');
  for (let i = 0; i < 300 && runner.busy; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? '', /does not know --prompt-file.*orcacode update/);
});

test('an OrcaCode model value carries its provider; ids keep their slashes and colons', () => {
  assert.equal(orcacodeModelValue('openrouter', 'meta-llama/llama-4:free'), 'openrouter::meta-llama/llama-4:free');
  assert.deepEqual(splitOrcacodeModel('openrouter::meta-llama/llama-4:free'), { provider: 'openrouter', model: 'meta-llama/llama-4:free' });
  assert.deepEqual(splitOrcacodeModel('gemma4:e2b-mlx'), { provider: null, model: 'gemma4:e2b-mlx' });
  assert.deepEqual(splitOrcacodeModel(''), { provider: null, model: '' });
  const args = orcacodeArgs({ ...base, model: 'openrouter::meta-llama/llama-4:free' }, files);
  assert.equal(args[args.indexOf('--provider') + 1], 'openrouter');
  assert.equal(args[args.indexOf('--model') + 1], 'meta-llama/llama-4:free');
  assert.ok(!orcacodeArgs({ ...base, model: 'gpt-6-sol' }, files).includes('--provider'));
});

test('OrcaCode provider and model JSON become grouped picker options', () => {
  const listed = parseOrcacodeProviders(JSON.stringify({ active: 'openai-codex', providers: [
    { label: 'openai-codex', name: 'OpenAI Codex', auth: 'oauth', configured: true, model: 'gpt-6-sol' },
    { label: 'vercel', name: 'Vercel AI Gateway', auth: 'api_key', configured: false, model: null },
    { name: 'no label' },
  ] }));
  assert.deepEqual(listed, { active: 'openai-codex', providers: [
    { id: 'openai-codex', name: 'OpenAI Codex', configured: true, model: 'gpt-6-sol' },
    { id: 'vercel', name: 'Vercel AI Gateway', configured: false, model: null },
  ] });
  assert.equal(parseOrcacodeProviders('not json'), null);
  assert.equal(parseOrcacodeProviders(null), null);
  const catalog = parseOrcacodeModelList(JSON.stringify({ provider: 'openrouter', models: [
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, efforts: ['low', 'high'] },
    { id: 'x/y', name: null, contextWindow: null, efforts: null },
  ] }), { id: 'openrouter', name: 'OpenRouter', configured: true });
  assert.deepEqual(catalog?.options.map(o => [o.value, o.label, o.group, o.efforts]), [
    ['openrouter::anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'OpenRouter', ['low', 'high']],
    ['openrouter::x/y', 'x/y', 'OpenRouter', ['low', 'medium', 'high']],
  ]);
  assert.deepEqual(catalog?.windows, [['openrouter::anthropic/claude-opus-5.5', 1_000_000]]);
});

/** A stand-in orcacode for discovery: 0.11 answers --list-providers and per-provider JSON lists; 0.10 only text. */
function discoveryBin(dir: string, modern: boolean): string {
  const bin = path.join(dir, `orcacode-${modern ? '11' : '10'}`);
  fs.writeFileSync(bin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const modern = ${modern};
if (args.includes('--list-providers')) {
  if (!modern) { console.error('unknown flag: --list-providers'); process.exit(1); }
  console.log(JSON.stringify({ active: 'openrouter', providers: [
    { label: 'openrouter', name: 'OpenRouter', auth: 'api_key', configured: true, model: 'anthropic/claude-opus-5.5' },
    { label: 'local', name: 'Local', auth: 'none', configured: true, model: null },
    { label: 'anthropic', name: 'Anthropic', auth: 'api_key', configured: false, model: null },
  ] }));
  process.exit(0);
}
if (args.includes('--list-models')) {
  const provider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null;
  if (!args.includes('--json')) { console.log('gpt-6-sol  272k ctx'); process.exit(0); }
  if (provider === 'local') { console.error('connection refused'); process.exit(1); }
  console.log(JSON.stringify({ provider, models: [{ id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', contextWindow: 1000000, efforts: null }] }));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  return bin;
}

test('discovery lists every set-up provider\'s models, skips one that fails, and names the rest', async () => {
  const dir = tempDir('orca-discover');
  const found = await discoverOrcacodeModels(discoveryBin(dir, true));
  assert.equal(found.discovered, true);
  assert.deepEqual(found.models.map(m => [m.value, m.group]), [['openrouter::anthropic/claude-opus-5.5', 'OpenRouter']]);
  assert.equal(found.defaultLabel, 'OpenRouter · anthropic/claude-opus-5.5');
  assert.deepEqual(found.providers?.map(p => [p.id, p.configured, p.problem]), [['openrouter', true, undefined], ['local', true, 'not reachable'], ['anthropic', false, undefined]]);
  assert.equal(listingProblem('error: authentication failed: HTTP 401: invalid x-api-key'), 'key rejected');
  assert.equal(listingProblem('weird'), 'could not list models');
  assert.equal(orcacodeContextWindow('anthropic/claude-opus-5.5', 'openrouter'), 1_000_000);
});

test('discovery falls back to the 0.10 text list when OrcaCode cannot list providers', async () => {
  const dir = tempDir('orca-discover-old');
  const found = await discoverOrcacodeModels(discoveryBin(dir, false));
  assert.deepEqual(found.models.map(m => [m.value, m.group]), [['gpt-6-sol', undefined]]);
  assert.equal(found.providers, undefined);
});

test('the model search matches every word against name, id and provider', () => {
  const options = [
    { value: 'openrouter::anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', group: 'OpenRouter' },
    { value: 'openai-codex::gpt-6-sol', label: 'gpt-6-sol', group: 'OpenAI Codex' },
  ];
  assert.deepEqual(filterOptions(options, 'opus router').map(o => o.label), ['Claude Opus 5.5']);
  assert.deepEqual(filterOptions(options, 'CODEX').map(o => o.label), ['gpt-6-sol']);
  assert.equal(filterOptions(options, '  ').length, 2);
  assert.equal(filterOptions(options, 'nothing').length, 0);
});
