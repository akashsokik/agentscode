import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalTool } from '../server/comms/tools.ts';
import { issueWording, migrateAction, storedIssues, SuperStore } from '../server/superAgent.ts';
import { claudeToolPolicy, superMayUse } from '../server/agents/claude.ts';
import { currentToolName, ISSUE_TOOL_ALIASES } from '../shared/issues.ts';
import type { SuperAction } from '../shared/types.ts';
import { migrateSuperView } from '../web/layout.ts';
import { migrateSeen } from '../web/superText.ts';
import { presentTool } from '../web/toolPresentation.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

// Goals became Issues (ACH-D38): new names everywhere, the old ones still work, and the data
// saved before the rename reads the same.

test('the old goal commands map to the issue commands, goal_id read as issue_id; others pass through', () => {
  assert.deepEqual(ISSUE_TOOL_ALIASES, { list_goals: 'list_issues', add_goal: 'add_issue', update_goal: 'update_issue', complete_goal: 'complete_issue' });
  assert.deepEqual(canonicalTool('update_goal', { goal_id: 'g1', status: 'done', why: 'x' }), { tool: 'update_issue', args: { issue_id: 'g1', status: 'done', why: 'x' } });
  assert.deepEqual(canonicalTool('complete_goal', { goal_id: 'g1', issue_id: 'i2' }), { tool: 'complete_issue', args: { issue_id: 'i2' } }, 'an explicit issue_id wins');
  assert.deepEqual(canonicalTool('add_goal', { text: 't' }), { tool: 'add_issue', args: { text: 't' } });
  assert.deepEqual(canonicalTool('send_message', { goal_id: 'kept' }), { tool: 'send_message', args: { goal_id: 'kept' } });
  assert.equal(currentToolName('list_goals'), 'list_issues');
  assert.equal(currentToolName('list_routines'), 'list_routines');
});

test('a SuperAgent session from before the rename can still call add_goal and update_goal; they run as issues', async () => {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(h.runner(sup.id).ctx.commsToken!, tool, args);
  const { added } = await call('add_goal', { text: 'Ship dark mode', why: 'old session' }) as { added: { id: string } };
  await call('update_goal', { goal_id: added.id, status: 'in_progress', why: 'old session' });
  const listed = await call('list_goals', {}) as { issues: { id: string; status: string }[] };
  assert.deepEqual(listed.issues.map(i => [i.id, i.status]), [[added.id, 'in_progress']]);
  await call('complete_goal', { goal_id: added.id, why: 'old session' });
  const state = h.manager.superView();
  assert.equal(state.issues[0].status, 'done');
  assert.deepEqual(state.log.map(a => a.tool).slice(0, 3), ['complete_issue', 'update_issue', 'add_issue'], 'logged under the new names');
});

test('super.json written before the rename: goals read as issues, goal undo records as issue ones; the next write keeps only the new names, once', () => {
  const dir = tempDir('issues-migrate');
  const goal = { id: 'g1', text: 'Ship dark mode', projectId: null, status: 'queued', order: 0, createdAt: 1, updatedAt: 1, by: 'user' };
  const action = { id: 'a1', at: 2, tool: 'add_goal', summary: 'Added the goal "Ship dark mode"', why: 'asked', undo: { kind: 'goal', goalId: 'g1', before: null } };
  fs.writeFileSync(path.join(dir, 'super.json'), JSON.stringify({ asks: [], log: [action], wakes: [], goals: [goal], routines: [] }));
  const store = new SuperStore(dir);
  const view = store.view(null);
  assert.deepEqual(view.issues.map(i => i.id), ['g1'], 'nothing lost');
  assert.deepEqual(view.log[0].undo, { kind: 'issue', issueId: 'g1', before: null });
  assert.equal(view.log[0].summary, 'Added the issue "Ship dark mode"', 'the server\'s own goal wording reads as Issue');
  store.updateIssue('g1', { status: 'in_progress' });
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'super.json'), 'utf8'));
  assert.deepEqual(written.issues.map((i: { id: string; status: string }) => [i.id, i.status]), [['g1', 'in_progress']]);
  assert.deepEqual(written.goals, written.issues, 'for one release the same list is also written as "goals", so a downgrade keeps the backlog');
  // A build from before the rename reads only "goals": it finds the current backlog there.
  assert.deepEqual(written.goals.map((i: { id: string; status: string }) => [i.id, i.status]), [['g1', 'in_progress']]);
  const again = new SuperStore(dir).view(null);
  assert.deepEqual(again.issues.map(i => [i.id, i.status]), [['g1', 'in_progress']], 'reading again changes nothing');
  assert.deepEqual(storedIssues({ issues: [], goals: [goal] }), [goal], 'an empty new list does not hide old goals');
  assert.deepEqual(storedIssues({ issues: [goal] }), [goal]);
  assert.deepEqual(storedIssues({}), []);
  const plain = { id: 'a2', at: 1, tool: 'send_message', summary: 's', why: '' } as SuperAction;
  assert.equal(migrateAction(plain), plain, 'other actions are left alone');
});

test('the saved Goals tab opens as Issues; what was seen on it carries over; old transcripts read with the new names', () => {
  assert.equal(migrateSuperView('goals'), 'issues');
  assert.equal(migrateSuperView('issues'), 'issues');
  assert.equal(migrateSuperView('routines'), 'routines');
  assert.equal(migrateSuperView('nonsense'), undefined);
  assert.equal(migrateSuperView(undefined), undefined);
  assert.deepEqual(migrateSeen({ decisions: 5, goals: 9 }), { decisions: 5, issues: 9 });
  assert.deepEqual(migrateSeen({ goals: 9, issues: 12 }), { issues: 12 }, 'a newer issues mark wins');
  const shown = (name: string) => presentTool({ name, summary: name, status: 'ok' });
  assert.deepEqual(shown('mcp__podcode__add_goal'), shown('mcp__podcode__add_issue'));
  assert.equal(shown('mcp__podcode__update_goal').target, 'update issue');
  assert.equal(shown('mcp__github__add_goal').target, 'add goal', 'only PodCode\'s own commands are renamed');
});

test('GitHub issues are named as such wherever the backlog could be confused with them', () => {
  const tools = fs.readFileSync(new URL('../server/comms/tools.ts', import.meta.url), 'utf8');
  assert.match(tools, /registerTool\('gh_issues', \{ description: `Open GitHub issues/);
  const roles = fs.readFileSync(new URL('../shared/roles.ts', import.meta.url), 'utf8');
  assert.match(roles, /issues backlog, PodCode\\'s own and not GitHub issues/);
  assert.match(roles, /gh_issues \(GitHub issues, not your issues backlog\)/);
});

test('the SuperAgent\'s engine allows the old goal names (they are not refused before the IDE maps them)', () => {
  for (const name of ['list_goals', 'add_goal', 'update_goal', 'complete_goal', 'list_issues', 'add_issue', 'update_issue', 'complete_issue']) {
    assert.equal(superMayUse(`mcp__podcode__${name}`), true, name);
  }
  const allowed = claudeToolPolicy({ role: 'super', autonomy: 'readonly', useMcp: false }, true).allowedTools ?? [];
  assert.ok(allowed.includes('mcp__podcode__add_goal') && allowed.includes('mcp__podcode__add_issue'));
  const dev = claudeToolPolicy({ role: 'dev', autonomy: 'full', useMcp: false }, true).allowedTools ?? [];
  assert.ok(!dev.includes('mcp__podcode__add_goal') && !dev.includes('mcp__podcode__add_issue'), 'other agents get neither');
});

test('old log lines: only the server\'s fixed goal wording becomes Issue, only for goal commands, never the text itself', () => {
  assert.equal(issueWording('Added the goal "Ship the goal page"'), 'Added the issue "Ship the goal page"');
  assert.equal(issueWording('Completed the goal "x"'), 'Completed the issue "x"');
  assert.equal(issueWording('Goal "Reach the goal": in progress, given to Ada'), 'Issue "Reach the goal": in progress, given to Ada');
  assert.equal(issueWording('Messaged Ada: our goal is calm'), 'Messaged Ada: our goal is calm');
  const message = { id: 'm', at: 1, tool: 'send_message', summary: 'Goal "x" is near', why: '' } as SuperAction;
  assert.equal(migrateAction(message), message, 'a message that happens to start with Goal is left alone');
  const update = { id: 'u', at: 1, tool: 'update_goal', summary: 'Goal "x": done', why: '' } as SuperAction;
  assert.equal(migrateAction(update).summary, 'Issue "x": done');
});
