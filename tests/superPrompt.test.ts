import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { systemInstructions } from '../server/agents/runner.ts';
import { createCommsMcpServer } from '../server/comms/tools.ts';
import { updatePrompt } from '../server/superAgent.ts';
import { autonomyInstructions } from '../shared/autonomy.ts';
import { roleInstructions, SUPER_PRESET } from '../shared/roles.ts';
import type { Agent, SuperIssue } from '../shared/types.ts';

// ACH-70 / ACH-D96: a fresh SuperAgent (empty memory and user.md) knows every feature it has and
// staffs work from the team it has, in a prompt that stays within its size budget.

const role = roleInstructions('super');
const fresh = () => systemInstructions(
  { id: 's', name: 'SuperAgent', role: 'super', instructions: SUPER_PRESET.instructions, home: '/tmp/home', projectIds: null } as unknown as Agent,
  null,
  { projects: [{ name: 'app', path: '/tmp/app' }], autonomy: autonomyInstructions('full', { deleteData: true, outsideAccounts: true, removeUserAgents: true, forcePush: true }, false) },
);
/** Each pattern must match somewhere in the text: a concept, not one exact wording. */
const covers = (text: string, concepts: Record<string, RegExp>) => {
  for (const [name, pattern] of Object.entries(concepts)) assert.match(text, pattern, name);
};

test('staffing: the team first, an idle agent that fits, a new one only with a reason, slices, no duplicates or removals', () => {
  covers(role, {
    'list_agents before staffing': /list_agents[^.]*(before|start)[^.]*create_agent/,
    'an idle agent that fits': /idle agent[^.]*role, engine and project/,
    'reviewers review, testers test': /reviewer to review[^.]*tester to run tests/,
    'a new agent only when needed, with why': /Create an agent only when none fits[^.]*busy[^.]*cannot wait[^.]*why/,
    'no near-duplicates': /near-duplicate/,
    'file-ownership slices': /slices[^.]*own[^.]*files/,
    'no removing without asking, its own too': /Never remove[^.]*any agent without asking[^.]*including ones you created/,
  });
  assert.match(SUPER_PRESET.instructions, /staff work from the team/);
});

test('the standard flow: issues, tasks with criteria and a pull-latest step, review before merge, demos for looks, status in percent', () => {
  covers(role, {
    'issues, not GitHub issues': /issues backlog[^.]*not GitHub issues/,
    'user-asked work goes out at once': /user asks for work[^.]*same turn/,
    'acceptance criteria': /acceptance criteria/,
    'pull latest first': /pull the latest/,
    'merge only a pass from the user\'s reviewer': /merge only what a reviewer the user made passed/,
    'never a made-up reviewer for a merge': /never create a reviewer to gate a merge/,
    'tests to a tester': /test runs to a tester/,
    'demo, walkthrough, OK for looks': /HTML demo[^.]*walkthrough[^.]*OK/,
    'status in percent': /percent[^.]*per workstream/,
    'user rules become decisions': /record it as a decision/,
  });
});

test('a fresh SuperAgent\'s whole prompt names every feature it has', () => {
  const text = fresh();
  for (const feature of [
    'list_issues', 'delegate_task', 'take_action', 'ask_user', 'create_channel', 'post_to_channel', 'decision_add', 'note_add', 'ref_search',
    'create_walkthrough', 'browser_open', 'app_screenshot', 'propose_routine', 'list_routines', 'run_check', 'gh_runs', 'gh_pr', 'gh_issues',
    'read_transcript', 'openui-lang', 'mermaid', 'remember', 'scope "user"', 'new session', 'stop a runaway turn',
  ]) assert.ok(text.includes(feature), feature);
});

test('every tool the role names is one the SuperAgent really has', async () => {
  const server = createCommsMcpServer(async () => ({}), { executive: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const registered = new Set((await client.listTools()).tools.map(t => t.name));
  const named = new Set(role.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
  // Words with underscores that are values, not tools.
  for (const value of ['needs_you', 'in_progress', 'in_review']) named.delete(value);
  assert.ok(named.size >= 15, `found ${named.size}`);
  for (const name of named) assert.ok(registered.has(name), `${name} is not registered`);
  await client.close();
});

test('the defaults stay generic and within budget', () => {
  // The shared text's own examples of an id (such as ACH-D7, ALL-N2) are the only ids allowed.
  const whole = fresh().replace(/such as ACH-D7|ACH-D7, ALL-N2/g, '');
  assert.doesNotMatch(whole, /\b(Ada|Bo|Cy|Dee|Eli|Fen|Gus|Hal|Ivy|Rhea)\b/, 'no agent names');
  assert.doesNotMatch(whole, /agent-comms-harness|orca|brain-dump|\b[A-Z]{2,5}-[DN]\d+/, 'no projects or decision ids');
  assert.doesNotMatch(whole, /This replaces|rule in your role instructions/, 'no pointer to a rule that is not there');
  // Measured on ACH-70: role 3276 -> 4447 characters, a fresh whole prompt 10749 -> 11940.
  assert.ok(role.length <= 4500, `role ${role.length} characters`);
  assert.ok(fresh().length <= 12_200, `whole ${fresh().length} characters`);
});

test('an update turn hands the next issue to a free agent that fits', () => {
  const issue = { id: 'i1', key: 'X-1', title: 'Do it', status: 'todo', priority: 'none' } as unknown as SuperIssue;
  assert.match(updatePrompt([], [], Date.now(), [issue]), /free agent that fits, from list_agents/);
});
