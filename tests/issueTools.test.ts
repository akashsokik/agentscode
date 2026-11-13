import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { claudeToolPolicy, superMayUse } from '../server/agents/claude.ts';
import { createCommsMcpServer } from '../server/comms/tools.ts';
import { HttpError } from '../server/errors.ts';
import type { SuperIssue } from '../shared/types.ts';
import { harness, projectDir, settle } from './helpers.ts';

// Issues phase 2 (ACH-D41, ACH-D43; proposal phase 2 and section 6.5): the agent tools take every
// field and filter, and delegate_task carries an issue. Tested through the engine's tool path
// (ALL-N5): the Claude tool policy, then the MCP server's schemas, then the IDE's handling.

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

/** The SuperAgent's MCP server, wired to the real manager, as an engine calls it. */
async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const lea = await h.manager.create({ name: 'Lea', engine: 'claude', projectId: web.id, role: 'lead' });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const token = h.runner(sup.id).ctx.commsToken!;
  const server = createCommsMcpServer((tool, args) => h.manager.commsTool(token, tool, args), { executive: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  /** A tool call as the engine makes it: MCP schemas first, then the IDE. Throws with the error text. */
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = result.content.map(c => c.text).join('');
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  return { ...h, web, ada, lea, sup, client, mcp };
}

test('the SuperAgent\'s engine lets the issue tools and delegate_task through; other agents get no issue tools', () => {
  for (const name of ['list_issues', 'add_issue', 'update_issue', 'complete_issue', 'delegate_task']) assert.equal(superMayUse(`mcp__podcode__${name}`), true, name);
  const allowed = claudeToolPolicy({ role: 'super', autonomy: 'readonly', useMcp: false }, true).allowedTools ?? [];
  for (const name of ['list_issues', 'add_issue', 'update_issue', 'delegate_task']) assert.ok(allowed.includes(`mcp__podcode__${name}`), name);
  const dev = claudeToolPolicy({ role: 'dev', autonomy: 'full', useMcp: false }, true).allowedTools ?? [];
  assert.ok(!dev.includes('mcp__podcode__add_issue'));
});

test('the MCP schemas: new fields and filters, old status names accepted, nothing for git, branch or activity', async () => {
  const t = await team();
  const { tools } = await t.client.listTools();
  const props = (name: string) => Object.keys((tools.find(x => x.name === name)!.inputSchema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props('list_issues').sort(), ['assignee', 'due', 'label', 'parent', 'priority', 'project', 'query', 'status']);
  for (const f of ['title', 'priority', 'due_date', 'labels', 'parent', 'assignee', 'status']) assert.ok(props('add_issue').includes(f), `add_issue ${f}`);
  for (const f of ['title', 'priority', 'due_date', 'labels', 'parent', 'relations', 'assignee', 'comment']) assert.ok(props('update_issue').includes(f), `update_issue ${f}`);
  for (const name of ['add_issue', 'update_issue']) {
    for (const f of ['branch', 'activityText', 'activity_text', 'activityRef', 'actor', 'by']) assert.ok(!props(name).includes(f), `${name} has no ${f}`);
  }
  assert.ok(props('delegate_task').includes('issue'));
  const update = tools.find(x => x.name === 'update_issue')!;
  assert.match(update.description!, /needs_you[\s\S]*the old names queued and blocked still work/);
  assert.match(tools.find(x => x.name === 'list_issues')!.description!, /by status, then priority, then order/);
  // Validated by the schema before the IDE sees it.
  await assert.rejects(t.mcp('add_issue', { text: 'X', priority: 'asap', why: 'x' }), /priority|Invalid/i);
  await assert.rejects(t.mcp('add_issue', { text: 'X', due_date: 'tomorrow', why: 'x' }), /due_date|Invalid/i);
  await assert.rejects(t.mcp('list_issues', { due: 'someday' }), /due|Invalid/i);
});

test('add, update and list through the engine: every field, keys for refs, filters, and the agent as the actor', async () => {
  const t = await team();
  const { added: parent } = await t.mcp('add_issue', { text: 'Dark mode. All of it.', project: 'web', why: 'asked' }) as { added: SuperIssue };
  assert.equal(parent.key, 'WEB-1');
  const { added: child } = await t.mcp('add_issue', {
    text: 'Settings toggle\n\n- persists\n- follows the system', title: 'Toggle', project: 'web', status: 'backlog', priority: 'high',
    due_date: '2026-12-01', labels: ['UI'], parent: 'WEB-1', assignee: 'user', why: 'part of it',
  }) as { added: SuperIssue };
  assert.deepEqual([child.key, child.title, child.status, child.priority, child.dueDate, child.labels, child.parentId, child.forUser], ['WEB-2', 'Toggle', 'backlog', 'high', '2026-12-01', ['ui'], parent.id, true]);
  assert.equal(child.text, 'Settings toggle\n\n- persists\n- follows the system');

  // Old status names still work; refs by key; the whole relation list; a comment; the assignee by name.
  const { updated } = await t.mcp('update_issue', {
    issue_id: 'web-2', status: 'queued', relations: [{ type: 'blocks', issue: 'WEB-1' }], comment: 'Started on it.\nTwo lines.', assignee: 'Ada', labels: ['ui', 'settings'], due_date: '', why: 'go',
  }) as { updated: SuperIssue };
  assert.deepEqual([updated.status, updated.relations, updated.agentId, updated.forUser, updated.labels, updated.dueDate], ['todo', [{ type: 'blocks', issueId: parent.id }], t.ada.id, undefined, ['ui', 'settings'], undefined]);
  const comment = updated.activity.find(e => e.kind === 'comment')!;
  assert.deepEqual([comment.text, comment.by], ['Started on it.\nTwo lines.', { kind: 'super' }], 'the actor is the SuperAgent, never git');
  assert.ok(!updated.activity.some(e => e.by.kind === 'git'));
  // An agent cannot pass git-only fields: the schema drops them, so the branch stays unset.
  const sneaky = await t.mcp('update_issue', { issue_id: 'WEB-2', priority: 'low', branch: 'feat/x', activityText: 'Merged', why: 'x' }) as { updated: SuperIssue };
  assert.equal(sneaky.updated.branch, undefined);
  assert.ok(!sneaky.updated.activity.some(e => e.text === 'Merged'));
  await t.mcp('update_issue', { issue_id: 'WEB-2', parent: '', why: 'top level' });
  const cleared = await t.mcp('update_issue', { issue_id: 'WEB-1', assignee: 'none', why: 'nobody' }) as { updated: SuperIssue };
  assert.equal(cleared.updated.agentId, undefined, '"none" clears, as list_issues names it');

  const list = async (args: Record<string, unknown>) => ((await t.mcp('list_issues', args)) as { issues: (SuperIssue & { activityCount: number })[] }).issues.map(i => i.key);
  assert.deepEqual(await list({}), ['WEB-1', 'WEB-2']);
  assert.deepEqual(await list({ status: ['todo'], priority: ['low'] }), ['WEB-2']);
  assert.deepEqual(await list({ assignee: 'Ada' }), ['WEB-2']);
  assert.deepEqual(await list({ assignee: 'none' }), ['WEB-1']);
  assert.deepEqual(await list({ label: 'UI' }), ['WEB-2']);
  assert.deepEqual(await list({ project: 'ALL' }), []);
  assert.deepEqual(await list({ query: 'dark' }), ['WEB-1']);
  assert.deepEqual(await list({ due: 'none' }), ['WEB-1', 'WEB-2']);
  const [first] = ((await t.mcp('list_issues', {})) as { issues: Record<string, unknown>[] }).issues;
  assert.equal(first.activity, undefined, 'activity is left out of the list');
  assert.equal(typeof first.activityCount, 'number');
  await assert.rejects(t.mcp('update_issue', { issue_id: 'WEB-99', priority: 'low', why: 'x' }), /No issue WEB-99/);
});

test('delegate_task with an issue: the key and branch rule in the handoff, the delegation on the issue, the report logged back', async () => {
  const t = await team();
  const { added } = await t.mcp('add_issue', { text: 'Ship dark mode', project: 'web', why: 'asked' }) as { added: SuperIssue };
  const receipt = await t.mcp('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Build it', acceptance_criteria: 'Tests pass', issue: 'WEB-1' }) as { id: string; text: string };
  assert.match(receipt.text, /^Issue: WEB-1 Ship dark mode$/m);
  assert.match(receipt.text, /branch named feat\/WEB-1-<short-slug> \(for example feat\/WEB-1-ship-dark-mode\)/);
  assert.match(receipt.text, /cite WEB-1 in every commit/);
  const issue = t.manager.superView().issues.find(i => i.id === added.id)!;
  assert.deepEqual([issue.agentId, issue.delegationId], [t.ada.id, receipt.id]);
  assert.match(issue.activity.at(-1)!.text!, /Handed to Ada as implementation/);
  assert.deepEqual(issue.activity.at(-1)!.by, { kind: 'super' });

  await settle();
  const adaToken = t.runners.get(t.ada.id)!.at(-1)!.ctx.commsToken!;
  const report = await t.manager.commsTool(adaToken, 'report_result', { message_id: receipt.id, outcome: 'done', summary: 'Built on feat/WEB-1-ship-dark-mode.', evidence: 'npm test' }) as { id: string; text: string };
  assert.match(report.text, /^IMPLEMENTATION RESULT: DONE\n\nIssue: WEB-1 Ship dark mode\n/);
  const after = t.manager.superView().issues.find(i => i.id === added.id)!;
  const logged = after.activity.at(-1)!;
  assert.deepEqual([logged.by, logged.text], [{ kind: 'agent', id: t.ada.id }, 'Reported done: Built on feat/WEB-1-ship-dark-mode.']);
  // The same report again is the same receipt and logs nothing more.
  await t.manager.commsTool(adaToken, 'report_result', { message_id: receipt.id, outcome: 'done', summary: 'Built on feat/WEB-1-ship-dark-mode.', evidence: 'npm test' });
  assert.equal(t.manager.superView().issues.find(i => i.id === added.id)!.activity.length, after.activity.length);

  // A lead may hand out an issue too; the issue records it by that agent. An unknown issue is refused.
  t.manager.send(t.lea.id, 'Lead the review.');
  await settle();
  const leaToken = t.runners.get(t.lea.id)!.at(-1)!.ctx.commsToken!;
  await t.manager.commsTool(leaToken, 'delegate_task', { to_agent_id: t.ada.id, kind: 'review', task: 'Review it', acceptance_criteria: 'Read it', issue: added.key });
  const reviewed = t.manager.superView().issues.find(i => i.id === added.id)!;
  assert.deepEqual(reviewed.activity.at(-1)!.by, { kind: 'agent', id: t.lea.id });
  assert.match(reviewed.activity.at(-1)!.text!, /Handed to Ada as review/);
  assert.deepEqual([reviewed.agentId, reviewed.delegationId], [t.ada.id, receipt.id], 'a review leaves the implementer\'s handoff alone');
  // A lead hands out only issues of its own projects.
  const api = t.manager.addProject({ path: projectDir(t.dir, 'api') });
  const { added: other } = await t.mcp('add_issue', { text: 'API work', project: api.id, why: 'x' }) as { added: SuperIssue };
  await assert.rejects(t.manager.commsTool(leaToken, 'delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'X', acceptance_criteria: 'Y', issue: other.key }), e => status(e) === 403);
  await assert.rejects(t.mcp('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'X', acceptance_criteria: 'Y', issue: 'WEB-9' }), /No issue WEB-9/);
});

test('a plain delegate_task (no issue) is unchanged', async () => {
  const t = await team();
  const receipt = await t.mcp('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Build it', acceptance_criteria: 'Tests pass' }) as { text: string };
  assert.doesNotMatch(receipt.text, /Issue:|feat\//);
});
