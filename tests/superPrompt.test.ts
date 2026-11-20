import assert from 'node:assert/strict';
import test from 'node:test';
import { systemInstructions } from '../server/agents/runner.ts';
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

test('staffing: list_agents first, an idle agent that fits, a new one only with a reason, slices, no duplicates or removals', () => {
  assert.match(role, /call list_agents before every delegate_task or create_agent/);
  assert.match(role, /Pick an idle agent whose role, engine and project fit/);
  assert.match(role, /a reviewer to review, a tester to run tests/);
  assert.match(role, /Create an agent only when none fits, or all that fit are busy and the work cannot wait; say which in its why/);
  assert.match(role, /never make a near-duplicate/);
  assert.match(role, /Split large work into slices that own separate files/);
  assert.match(role, /Never remove an agent the user made without asking first/);
  assert.match(SUPER_PRESET.instructions, /staff work from the team you have/);
});

test('the standard flow: issues, tasks with criteria and a pull-latest step, review before merge, demos for looks, status in percent', () => {
  assert.match(role, /issues backlog, PodCode's own and not GitHub issues/);
  assert.match(role, /acceptance criteria/);
  assert.match(role, /pull the latest and branch from it/);
  assert.match(role, /merge only what a reviewer passed/);
  assert.match(role, /hand test runs to a tester/);
  assert.match(role, /standalone HTML demo/);
  assert.match(role, /create_walkthrough with image steps\) and get their OK with ask_user before it goes into the app/);
  assert.match(role, /percent complete across all active work and one per workstream/);
  assert.match(role, /record it as a decision and save it with remember scope "user"/);
});

test('a fresh SuperAgent\'s whole prompt names every feature it has', () => {
  const text = fresh();
  for (const feature of [
    'list_issues', 'delegate_task', 'take_action', 'ask_user', 'create_channel', 'post_to_channel', 'decision_add', 'note_add', 'ref_search',
    'create_walkthrough', 'browser_open', 'app_screenshot', 'propose_routine', 'list_routines', 'run_check', 'gh_runs', 'gh_pr', 'gh_issues',
    'read_transcript', 'openui-lang', 'mermaid', 'remember', 'scope "user"', 'new session', 'stop a runaway turn',
  ]) assert.ok(text.includes(feature), feature);
});

test('the defaults stay generic and within budget', () => {
  for (const text of [role, SUPER_PRESET.instructions]) {
    assert.doesNotMatch(text, /\b(Ada|Bo|Cy|Dee|Eli|Fen|Gus|Hal|Ivy|Rhea)\b/, 'no agent names');
    assert.doesNotMatch(text, /agent-comms-harness|orca|brain-dump|\b(ACH|OSI|BDU|ALL)-[DN]?\d/, 'no projects or decision ids');
  }
  // Measured on ACH-70: role 3276 -> 4358 characters, a fresh whole prompt 10749 -> 11866.
  assert.ok(role.length <= 4500, `role ${role.length} characters`);
  assert.ok(fresh().length <= 12_200, `whole ${fresh().length} characters`);
});

test('an update turn hands the next issue to a free agent that fits', () => {
  const issue = { id: 'i1', key: 'X-1', title: 'Do it', status: 'todo', priority: 'none' } as unknown as SuperIssue;
  assert.match(updatePrompt([], [], Date.now(), [issue]), /give the next todo one to a free agent that fits, from list_agents/);
});
