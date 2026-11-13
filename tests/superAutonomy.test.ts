import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { claudeToolPolicy, superMayUse } from '../server/agents/claude.ts';
import { HttpError } from '../server/errors.ts';
import { Store } from '../server/store.ts';
import { ACTION_KINDS, actionVerdict, ALL_ASK_FIRST, autonomyInstructions, cleanAutonomy, createCapText, SOUL_LINE_FROM, SOUL_LINE_TO, suggestedSoul, type ActionKind, type AskFirst } from '../shared/autonomy.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';
import { redeemOverride } from '../server/pushGuard.ts';
import { forbiddenGit, gatedVerbs } from '../shared/gitGuard.ts';
import { execFileSync } from 'node:child_process';

// The SuperAgent's Autonomy setting (ALL-D9): Full by default with every ask-first switch on;
// enforced by take_action on the server, not by the prompt alone.

const status = (e: unknown) => (assert.ok(e instanceof HttpError, String(e)), (e as HttpError).status);
const NONE: AskFirst = { deleteData: false, outsideAccounts: false, removeUserAgents: false, forcePush: false };
const UNDOABLE: ActionKind[] = ['merge', 'restart', 'push', 'release', 'deploy', 'cleanup', 'project', 'costly'];

test('the policy: Full acts on every undoable step; Standard is ALL-D1; Ask asks; ask-first follows its switch; shared history never', () => {
  for (const kind of UNDOABLE) {
    assert.equal(actionVerdict(kind, 'full', ALL_ASK_FIRST), 'act', `full ${kind}`);
    assert.equal(actionVerdict(kind, 'ask', ALL_ASK_FIRST), 'ask', `ask ${kind}`);
    assert.equal(actionVerdict(kind, 'standard', ALL_ASK_FIRST), ['merge', 'restart', 'cleanup'].includes(kind) ? 'act' : 'ask', `standard ${kind}`);
  }
  const switches: [ActionKind, keyof AskFirst][] = [['delete_data', 'deleteData'], ['outside_account', 'outsideAccounts'], ['remove_user_agent', 'removeUserAgents'], ['force_push', 'forcePush']];
  for (const [kind, key] of switches) {
    assert.equal(actionVerdict(kind, 'full', ALL_ASK_FIRST), 'ask', `${kind} with its switch on`);
    assert.equal(actionVerdict(kind, 'full', { ...ALL_ASK_FIRST, [key]: false }), 'act', `${kind} with its switch off`);
    assert.equal(actionVerdict(kind, 'ask', NONE), 'ask', `${kind} on Ask even with the switch off`);
  }
  for (const level of ['ask', 'standard', 'full'] as const) {
    assert.equal(actionVerdict('rewrite_history', level, NONE), 'never', level);
  }
  assert.equal(ACTION_KINDS.length, 13);
});

test('defaults and stored settings: Full with all four ask-first switches on; old or broken values made whole', () => {
  assert.equal(DEFAULT_SETTINGS.superAutonomy, 'full');
  assert.deepEqual(DEFAULT_SETTINGS.superAskFirst, { deleteData: true, outsideAccounts: true, removeUserAgents: true, forcePush: true });
  assert.equal(DEFAULT_SETTINGS.superPaused, false);
  assert.deepEqual(cleanAutonomy({}), { superAutonomy: 'full', superAskFirst: ALL_ASK_FIRST });
  assert.deepEqual(cleanAutonomy({ superAutonomy: 'yolo', superAskFirst: { deleteData: false, forcePush: 'x' } }), { superAutonomy: 'full', superAskFirst: { ...ALL_ASK_FIRST, deleteData: false } });
  // A state.json from before the setting existed loads as Full, every switch on, not paused.
  const dir = tempDir('autonomy-store');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ agents: [], projects: [], settings: { superWake: true, superDailyBudgetUsd: 5 } }));
  const store = new Store(dir);
  store.load();
  assert.equal(store.settings.superAutonomy, 'full');
  assert.deepEqual(store.settings.superAskFirst, ALL_ASK_FIRST);
  assert.equal(store.settings.superPaused, false);
  assert.equal(store.settings.superDailyBudgetUsd, 5, 'other settings untouched');
});

test('the engine lets the SuperAgent use take_action (Claude policy), and nobody else', () => {
  assert.equal(superMayUse('mcp__podcode__take_action'), true);
  assert.equal(superMayUse('mcp__podcode__ask_user'), true);
  const allowed = claudeToolPolicy({ role: 'super', autonomy: 'readonly', useMcp: false }, true).allowedTools ?? [];
  assert.ok(allowed.includes('mcp__podcode__take_action'));
  const dev = claudeToolPolicy({ role: 'dev', autonomy: 'full', useMcp: false }, true).allowedTools ?? [];
  assert.ok(!dev.includes('mcp__podcode__take_action'));
});

test('its instructions follow the level and switches, replace the old always-ask rule, and say when it is paused', () => {
  const full = autonomyInstructions('full', ALL_ASK_FIRST, false);
  assert.match(full, /Autonomy \(Settings, SuperAgent\): Full\. This replaces the "Always ask the user first" rule/);
  assert.match(full, /without ask_user, through take_action/);
  assert.match(full, /push main \(fast-forward only\)/);
  assert.match(full, /Always ask first, before: deleting files or data.*outside accounts.*removing agents the user made.*force-pushing/);
  assert.match(full, /for_action \{kind, target, task\}; PodCode adds Yes and No/);
  assert.match(full, /push check, which refuses a push that overwrites or deletes what the remote has/);
  assert.doesNotMatch(full, /PAUSED/);
  assert.doesNotMatch(autonomyInstructions('full', NONE, false), /Always ask first/, 'no ask-first line with every switch off');
  assert.match(autonomyInstructions('standard', ALL_ASK_FIRST, false), /merge approved branches into local main.*\n.*Ask with ask_user before anything else of that kind \(push/);
  assert.match(autonomyInstructions('ask', ALL_ASK_FIRST, false), /Ask the user with ask_user before every merge, restart, push/);
  assert.match(autonomyInstructions('full', ALL_ASK_FIRST, true), /The user PAUSED you/);
  assert.equal(suggestedSoul(`You run the team: ${SOUL_LINE_FROM} You never edit.`), `You run the team: ${SOUL_LINE_TO} You never edit.`);
  assert.equal(suggestedSoul('Edited by hand already.'), 'Edited by hand already.');
});

test('the shared-history backstop catches force-pushes and rewrites, and lets everyday merge/push work through (only noted)', () => {
  for (const bad of ['git push -f origin main', 'git push --force origin main', 'git push --force-with-lease', 'git push origin +main', 'git reset --hard HEAD~3 && git push origin main', 'git filter-repo --path x', 'git push origin --delete fix/x', 'git push origin :refs/tags/v1', 'git rebase -i origin/main && git push origin main']) {
    assert.ok(forbiddenGit(bad), bad);
  }
  for (const ok of ['git merge --ff-only fix/x && npm test', 'git push origin main', 'git push -u origin fix/x', 'git reset --hard backup/main-before-x', 'git rebase main', 'Review fix/x and report']) {
    assert.equal(forbiddenGit(ok), null, ok);
  }
  assert.deepEqual(gatedVerbs('git merge --ff-only fix/x, then git push origin main and git branch -D fix/x'), ['merge', 'push', 'delete']);
  assert.deepEqual(gatedVerbs('Review fix/x and report'), []);
});

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: ENV, encoding: 'utf8' }).trim();

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const dir = projectDir(h.dir, 'web');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'checkout', '-q', '-b', 'fix/x');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'x');
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', 'backup/fix-x', 'fix/x');
  const web = h.manager.addProject({ path: dir });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const rhea = await h.manager.create({ name: 'Rhea', engine: 'claude', projectId: web.id, role: 'reviewer' });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const runner = h.runner(sup.id);
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner.ctx.commsToken!, tool, args);
  return { ...h, dir, web, ada, rhea, sup, runner, call, sha };
}
type Team = Awaited<ReturnType<typeof team>>;

/** The user's answer to a question bound to one step; the first option is the yes. */
async function approve(t: Team, kind: string, target: string, answer?: string, task?: string) {
  const { asked } = await t.call('ask_user', { question: `${kind} ${target}?`, options: ['Keep them', 'Delete them'], for_action: { kind, target, ...(task ? { task } : {}) } }) as { asked: { id: string; options: string[] } };
  assert.equal(asked.options[1], 'No', 'PodCode writes the choices: Yes first, then No');
  assert.match(asked.options[0], new RegExp(`^Yes, ${kind.replace('_', ' ')}`));
  t.manager.answerSuper(asked.id, { answer: answer ?? asked.options[0] });
  return asked.id;
}

const merge = (t: Team, extra: Record<string, unknown> = {}) => ({ kind: 'merge', summary: 'Merge fix/x into main', why: 'Approved and green.', agent: 'Ada', project: 'web', branch: 'fix/x', commit: t.sha.slice(0, 10), task: 'git merge --ff-only fix/x on main; run npm test.', undo: 'git reset --hard backup/main-before-fix-x (not pushed yet)', ...extra });

test('M1, the merge gate: a passing review that names this branch and this commit, by a reviewer you made; the branch still at that commit', async () => {
  const t = await team();
  t.manager.updateSettings({ messageLimit: 0 }); // many review requests in one test
  // A turn of its own (an update), so what it creates is its own.
  t.runner.complete(); await settle();
  (t.manager as unknown as { wakeSuper(p: string, l: string): void }).wakeSuper('Update.', 'Update.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  const ownCall = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(own.ctx.commsToken!, tool, args);
  const reviewBy = async (reviewerId: string, summary: string, outcome: 'passed' | 'done' = 'passed', request = `Review fix/x at ${t.sha.slice(0, 7)}`) => {
    const asked = await ownCall('delegate_task', { to_agent_id: reviewerId, kind: 'review', task: request, acceptance_criteria: 'Typecheck and tests pass.' }) as { id: string };
    await settle();
    await t.manager.commsTool(t.runners.get(reviewerId)!.at(-1)!.ctx.commsToken!, 'report_result', { message_id: asked.id, outcome, summary, evidence: 'npm test 804/804' });
  };
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409 && /No reviewer you made has passed fix\/x/.test((e as Error).message));
  // A reviewer it made on its own does not count (Rhea B2).
  await ownCall('create_agent', { name: 'Rex', engine: 'claude', role: 'reviewer', why: 'A reviewer.' });
  const rex = [...t.store.agents.values()].find(a => a.name === 'Rex')!;
  assert.equal(rex.createdBy, 'super');
  await reviewBy(rex.id, `APPROVE fix/x at ${t.sha.slice(0, 7)}`);
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409, 'its own reviewer\'s pass does not count');
  await reviewBy(t.rhea.id, `APPROVE fix/y at ${t.sha.slice(0, 7)}`);
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409, 'a pass for another branch (Rhea B1)');
  await reviewBy(t.rhea.id, `APPROVE fix/x at ${t.sha.slice(0, 7)}`, 'passed', `Review fix/a at ${t.sha.slice(0, 7)}`);
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409, 'a pass to a request for another branch that names this one (Rhea B1b)');
  // A role it gave does not count (Rhea B4): Ada made a reviewer by the SuperAgent.
  await ownCall('update_agent', { agent_id: 'Ada', role: 'reviewer', why: 'More reviewers.' });
  assert.equal(t.store.agents.get(t.ada.id)!.roleSetBy, 'super');
  await reviewBy(t.ada.id, `APPROVE fix/x at ${t.sha.slice(0, 7)}`);
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409, 'a role it set on its own');
  await t.manager.update(t.ada.id, { role: 'dev' });
  await reviewBy(t.rhea.id, `fix/x looks fine at ${t.sha.slice(0, 7)}`, 'done');
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409, '"done" is not "passed"');
  await reviewBy(t.rhea.id, 'APPROVE fix/x', 'passed', 'Review fix/x');
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409, 'neither the request nor the pass names the commit');
  await reviewBy(t.rhea.id, `APPROVE fix/x at ${t.sha.slice(0, 7)}: typecheck 0, tests pass.`);
  assert.equal((await ownCall('take_action', merge(t)) as { verdict: string }).verdict, 'act');
  const entry = t.manager.superView().log[0];
  assert.equal(entry.autonomy, 'full');
  assert.deepEqual(entry.undo, { kind: 'reverse', how: merge(t).undo, agentId: t.ada.id });
  // New commits after the review: the branch moved, so no merge.
  git(t.dir, 'checkout', '-q', 'fix/x'); fs.writeFileSync(path.join(t.dir, 'y.txt'), 'y'); git(t.dir, 'add', '-A'); git(t.dir, 'commit', '-q', '-m', 'y'); git(t.dir, 'checkout', '-q', 'main');
  await assert.rejects(ownCall('take_action', merge(t)), e => status(e) === 409 && /changed since the review/.test((e as Error).message));
});

test('H1: an ask-first approval is for that kind and target only, needs the first option, is used once, and expires', async () => {
  const t = await team();
  t.manager.updateSettings({ superAskFirst: { ...ALL_ASK_FIRST } });
  const del = { kind: 'delete_data', summary: 'Delete old backups', why: 'Space.', agent: 'Ada', target: 'old backups', project: 'web', backup: 'backup/fix-x', branch: 'fix/x', task: 'rm -rf /tmp/old-backups' };
  await assert.rejects(t.call('take_action', del), e => status(e) === 409 && /no approved_ask_id/.test((e as Error).message));
  // An unrelated answered question approves nothing (Rhea A1).
  const { asked: colour } = await t.call('ask_user', { question: 'Which colour?', options: ['Blue', 'Red'] }) as { asked: { id: string } };
  t.manager.answerSuper(colour.id, { answer: 'Blue' });
  await assert.rejects(t.call('take_action', { ...del, approved_ask_id: colour.id }), e => status(e) === 409 && /was not for delete_data/.test((e as Error).message));
  // Bound to another kind or target: refused (A2, A3).
  const forcePush = await approve(t, 'force_push', 'fix/new', undefined, del.task);
  await assert.rejects(t.call('take_action', { ...del, approved_ask_id: forcePush }), e => status(e) === 409);
  const otherTarget = await approve(t, 'delete_data', 'the reports folder', undefined, del.task);
  await assert.rejects(t.call('take_action', { ...del, approved_ask_id: otherTarget }), e => status(e) === 409);
  // Any answer but the first option is no (A4, A5): "Keep them", "Nope", free text.
  for (const answer of ['Keep them', 'Nope', 'Later', 'sure, go ahead']) {
    const id = await approve(t, 'delete_data', 'old backups', answer, del.task);
    await assert.rejects(t.call('take_action', { ...del, approved_ask_id: id }), e => status(e) === 409 && /did not choose Yes/.test((e as Error).message), answer);
  }
  const otherTask = await approve(t, 'delete_data', 'old backups', undefined, 'rm -rf /tmp/old-backups/2025');
  await assert.rejects(t.call('take_action', { ...del, approved_ask_id: otherTask }), e => status(e) === 409 && /not the one the user approved/.test((e as Error).message), 'Rhea A8: the task is bound');
  const yes = await approve(t, 'delete_data', 'old backups', undefined, del.task);
  assert.equal((await t.call('take_action', { ...del, approved_ask_id: yes }) as { verdict: string }).verdict, 'ask');
  assert.ok(t.manager.superView().asks.find(a => a.id === yes)?.consumedBy, 'marked used');
  await assert.rejects(t.call('take_action', { ...del, approved_ask_id: yes }), e => status(e) === 409 && /used already/.test((e as Error).message), 'once only');
  // Over a day old: expired.
  const old = await approve(t, 'delete_data', 'old backups', undefined, del.task);
  const realNow = Date.now;
  Date.now = () => realNow() + 25 * 60 * 60 * 1000;
  try {
    await assert.rejects(t.call('take_action', { ...del, approved_ask_id: old }), e => status(e) === 409 && /over a day old/.test((e as Error).message));
  } finally { Date.now = realNow; }
  // With the switch off, Full deletes without asking.
  t.manager.updateSettings({ superAskFirst: { ...ALL_ASK_FIRST, deleteData: false } });
  assert.equal((await t.call('take_action', del) as { verdict: string }).verdict, 'act');
  // Lower levels ask before steps Full would take.
  t.manager.updateSettings({ superAutonomy: 'standard' });
  await assert.rejects(t.call('take_action', { kind: 'push', summary: 'Push main', why: 'Merged.', agent: 'Ada', task: 'git push origin main', undo: 'a revert' }), e => status(e) === 409);
  t.manager.updateSettings({ superAutonomy: 'ask' });
  await assert.rejects(t.call('take_action', { kind: 'restart', summary: 'Restart', why: 'Merged.', agent: 'Ada', task: 'restart', undo: 'previous build' }), e => status(e) === 409);
});

test('H2: shared-history rewrites are refused in take_action (any kind, task or undo) and in delegate_task, send_message and create_agent; other gated steps are noted in Decisions', async () => {
  const t = await team();
  const push = { kind: 'push', summary: 'Push main', why: 'x', agent: 'Ada', undo: 'a revert' };
  await assert.rejects(t.call('take_action', { ...push, task: 'git reset --hard HEAD~3 && git push -f origin main' }), e => status(e) === 403, 'Rhea C2: kind push, a force in the task');
  await assert.rejects(t.call('take_action', { ...push, task: 'git push origin main', undo: 'git push --force origin main' }), e => status(e) === 403, 'in the undo');
  t.manager.updateSettings({ superAskFirst: { ...ALL_ASK_FIRST, forcePush: false } });
  await assert.rejects(t.call('take_action', { kind: 'force_push', summary: 'Force main', why: 'x', agent: 'Ada', task: 'git push -f origin main', undo: 'x' }), e => status(e) === 403, 'Rhea C1: force_push of main with the switch off and no approval: refused early');
  await assert.rejects(t.call('take_action', { kind: 'rewrite_history', summary: 'Tidy', why: 'x', agent: 'Ada', task: 'squash' }), e => status(e) === 403);
  await assert.rejects(t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'git push --force origin main; rm -rf backups', acceptance_criteria: 'done' }), e => status(e) === 403, 'D1');
  await assert.rejects(t.call('send_message', { to_agent_id: t.ada.id, text: 'Please git push -f origin main now' }), e => status(e) === 403, 'D2');
  await assert.rejects(t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Please force-push main so it matches backup/x.', acceptance_criteria: 'done' }), e => status(e) === 403, 'D1b, plain English');
  await assert.rejects(t.call('post_to_channel', { channel: 'nowhere', text: 'git push --force origin main', mention_agent_ids: [] }), e => status(e) === 403, 'D8, a channel post');
  await assert.rejects(t.call('reply', { message_id: 'm-none', text: 'Run git push --force origin main' }), e => status(e) === 403, 'a reply');
  await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Do not run git push --force; just open a PR.', acceptance_criteria: 'done' });
  await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'git reset --hard origin/fix/x, then git push origin fix/x', acceptance_criteria: 'done' });
  await assert.rejects(t.call('create_agent', { name: 'Bad', engine: 'claude', role: 'dev', why: 'x', task: 'git filter-repo --path secrets' }), e => status(e) === 403, 'D3');
  await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'Merge fix/x into main and push origin main', acceptance_criteria: 'done' });
  const entry = t.manager.superView().log[0];
  assert.deepEqual(entry.gated, ['merge', 'push'], 'noted in Decisions');
  await t.call('delegate_task', { to_agent_id: t.ada.id, kind: 'review', task: 'Review fix/x', acceptance_criteria: 'done' });
  assert.equal(t.manager.superView().log[0].gated, undefined, 'everyday work is not flagged');
});

test('M2: a backup must exist (a ref in the project, or a path); L1: a FULL step says how to undo it or why it cannot be', async () => {
  const t = await team();
  const cleanup = { kind: 'cleanup', summary: 'Remove fix/x worktree', why: 'Merged.', agent: 'Ada', project: 'web', branch: 'fix/x', task: 'git worktree remove ../wt-x', undo: 'git worktree add ../wt-x backup/fix-x' };
  await assert.rejects(t.call('take_action', cleanup), e => status(e) === 400 && /Name the backup/.test((e as Error).message));
  for (const bad of ['none', 'HEAD', 'fix/x', '/', 'main']) {
    await assert.rejects(t.call('take_action', { ...cleanup, backup: bad }), e => status(e) === 400, `Rhea B3: ${bad}`);
  }
  git(t.dir, 'branch', 'backup/old', 'main');
  await assert.rejects(t.call('take_action', { ...cleanup, backup: 'backup/old' }), e => status(e) === 400 && /does not hold/.test((e as Error).message), 'a backup that does not hold the branch');
  assert.ok(await t.call('take_action', { ...cleanup, backup: 'backup/fix-x' }));
  const copy = path.join(t.dir, '..', 'backups', 'fix-x-copy');
  fs.mkdirSync(copy, { recursive: true });
  assert.ok(await t.call('take_action', { ...cleanup, backup: copy }), 'a copy in a backups folder');
  await assert.rejects(t.call('take_action', { ...cleanup, backup: t.dir }), e => status(e) === 400, 'a path outside a backups folder');
  await assert.rejects(t.call('take_action', { kind: 'deploy', summary: 'Deploy', why: 'x', agent: 'Ada', task: 'deploy' }), e => status(e) === 400 && /undo/.test((e as Error).message), 'Rhea F1');
  await t.call('take_action', { kind: 'deploy', summary: 'Deploy', why: 'x', agent: 'Ada', task: 'deploy', no_undo: 'This host keeps no previous version.' });
  assert.equal(t.manager.superView().log[0].noUndo, 'This host keeps no previous version.');
});

test('remove_user_agent: an agent you made needs a yes; one it made on its own it may remove; errors surface', async () => {
  const t = await team();
  await assert.rejects(t.call('take_action', { kind: 'remove_user_agent', summary: 'Remove Ada', why: 'Idle.', agent: 'Ada' }), e => status(e) === 409);
  t.runner.complete(); await settle();
  (t.manager as unknown as { wakeSuper(p: string, l: string): void }).wakeSuper('Update.', 'Update.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  const ownCall = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(own.ctx.commsToken!, tool, args);
  await ownCall('create_agent', { name: 'Ivy', engine: 'claude', role: 'tester', why: 'A tester.' });
  const removed = await ownCall('take_action', { kind: 'remove_user_agent', summary: 'Remove Ivy', why: 'Done testing.', agent: 'Ivy' }) as { verdict: string };
  assert.equal(removed.verdict, 'act');
  assert.ok(![...t.store.agents.values()].some(a => a.name === 'Ivy'), 'removed before the reply');
  assert.match(t.manager.superView().log[0].noUndo ?? '', /removed/);
});

test('M3, Pause: in a turn of its own, take_action, delegate_task, send_message, create_agent, create_channel and issue hand-outs are refused; turns are held; your own work goes', async () => {
  const t = await team();
  t.runner.complete();
  await settle();
  (t.manager as unknown as { wakeSuper(prompt: string, line: string): void }).wakeSuper('Update: Ada finished.', 'Update: Ada finished.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  const ownCall = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(own.ctx.commsToken!, tool, args);
  t.manager.addIssue({ text: 'Ship it', projectId: null });
  const issue = t.manager.superView().issues[0];
  t.manager.updateSettings({ superPaused: true });
  const paused = (e: unknown) => status(e) === 409 && /paused you/.test((e as Error).message);
  await assert.rejects(ownCall('take_action', { kind: 'restart', summary: 'Restart', why: 'x', agent: 'Ada', task: 'restart', undo: 'x' }), paused);
  await assert.rejects(ownCall('create_agent', { name: 'Ivy', engine: 'claude', role: 'tester', why: 'x' }), paused);
  await assert.rejects(ownCall('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'x', acceptance_criteria: 'y' }), paused, 'Rhea D5');
  await assert.rejects(ownCall('send_message', { to_agent_id: t.ada.id, text: 'Start on it' }), paused, 'D6');
  await assert.rejects(ownCall('update_issue', { issue_id: issue.id, status: 'in_progress', agent_id: 'Ada', why: 'x' }), paused, 'D7');
  await assert.rejects(ownCall('create_channel', { name: 'ops', member_ids: [t.ada.id], why: 'x' }), e => status(e) === 409 || status(e) === 400);
  own.complete();
  await settle();
  assert.equal((t.manager as unknown as { watcher: { held(): string | null } }).watcher.held(), 'you paused it');
  t.manager.send(t.sup.id, 'Restart PodCode now.');
  await settle();
  const userTurn = t.runners.get(t.sup.id)!.at(-1)!;
  const r = await t.manager.commsTool(userTurn.ctx.commsToken!, 'take_action', { kind: 'restart', summary: 'Restart', why: 'You asked.', agent: 'Ada', task: 'restart', undo: 'previous build' }) as { verdict: string };
  assert.equal(r.verdict, 'act', 'work you asked for still goes');
  t.manager.updateSettings({ superPaused: false });
  assert.equal((t.manager as unknown as { watcher: { held(): string | null } }).watcher.held(), null);
});

test('M5: costly work on its own stays in budget, counting the turns of agents it started on its own', async () => {
  const t = await team();
  t.manager.updateSettings({ superDailyBudgetUsd: 1 });
  t.runner.complete(); await settle();
  (t.manager as unknown as { wakeSuper(p: string, l: string): void }).wakeSuper('Update.', 'Update.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  const ownCall = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(own.ctx.commsToken!, tool, args);
  await ownCall('delegate_task', { to_agent_id: t.ada.id, kind: 'implementation', task: 'A big job', acceptance_criteria: 'done' });
  await settle();
  // Ada's turn on that delegation costs $2: it counts toward the SuperAgent's own budget.
  const adaRun = t.runners.get(t.ada.id)!.at(-1)! as unknown as { busy: boolean; ctx: { hooks: { turnEnd(r: unknown): void; ready?(): void } } };
  adaRun.busy = false;
  adaRun.ctx.hooks.turnEnd({ ok: true, summary: 'Did it.', costUsd: 2 });
  adaRun.ctx.hooks.ready?.();
  await settle();
  assert.ok((t.manager as unknown as { superStore: { spentToday(d: Date): number } }).superStore.spentToday(new Date()) >= 2);
  await assert.rejects(ownCall('take_action', { kind: 'costly', summary: 'Start the big refactor', why: 'x', agent: 'Ada', task: 'refactor', undo: 'stop' }), e => status(e) === 409 && /budget/.test((e as Error).message));
});

test('Undo on a FULL step hands the reverse step back to the SuperAgent as your request, once', async () => {
  const t = await team();
  await t.call('take_action', { kind: 'push', summary: 'Push main 28833e9', why: 'Merged.', agent: 'Ada', task: 'git push origin main', undo: 'Push a revert commit of 28833e9.' });
  const entry = t.manager.superView().log[0];
  t.runner.complete();
  await settle();
  await t.manager.undoSuper(entry.id);
  await settle();
  const sent = t.runners.get(t.sup.id)!.flatMap(r => r.sent);
  assert.ok(sent.some(s => /pressed Undo on "Push main 28833e9".*Push a revert commit of 28833e9/s.test(s.text) && s.task?.source === 'user'));
  assert.ok(t.manager.superView().log.find(a => a.id === entry.id)?.undoneAt);
  await assert.rejects(t.manager.undoSuper(entry.id), e => status(e) === 409);
});

test('settings: validated, saved, and a running SuperAgent session hears the change in its next turn', async () => {
  const t = await team();
  for (const bad of [{ superAutonomy: 'yolo' }, { superPaused: 'yes' }, { superAskFirst: { nukes: true } }, { superAskFirst: { deleteData: 'no' } }]) {
    assert.throws(() => t.manager.updateSettings(bad as never), e => status(e) === 400, JSON.stringify(bad));
  }
  assert.match(t.runner.ctx.instructions!(), /Autonomy \(Settings, SuperAgent\): Full/);
  const saved = t.manager.updateSettings({ superAutonomy: 'standard', superAskFirst: { forcePush: false } as AskFirst });
  assert.equal(saved.superAutonomy, 'standard');
  assert.deepEqual(saved.superAskFirst, { ...ALL_ASK_FIRST, forcePush: false });
  const next = t.runner.ctx.preparePrompt!('Next update.');
  assert.match(next, /Since this session started, the following changed[\s\S]*Autonomy \(Settings, SuperAgent\): Standard/);
});

test('ALL-D10: no agents-a-day cap on Full (Settings says so); the cap holds on Standard; the daily budget still holds on Full', async () => {
  assert.match(createCapText('full'), /^Not used on Full/);
  assert.match(createCapText('standard'), /asks you before creating more/);
  const t = await team();
  t.manager.updateSettings({ superMaxCreatesPerDay: 1 });
  t.runner.complete(); await settle();
  (t.manager as unknown as { wakeSuper(p: string, l: string): void }).wakeSuper('Update.', 'Update.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  const ownCall = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(own.ctx.commsToken!, tool, args);
  for (const name of ['Ivy', 'Jo', 'Kit']) await ownCall('create_agent', { name, engine: 'claude', role: 'tester', why: 'Work needs it.' });
  assert.equal([...t.store.agents.values()].filter(a => ['Ivy', 'Jo', 'Kit'].includes(a.name)).length, 3, 'three past a cap of one, on Full');
  t.manager.updateSettings({ superAutonomy: 'standard' });
  await assert.rejects(ownCall('create_agent', { name: 'Lu', engine: 'claude', role: 'tester', why: 'x' }), e => status(e) === 429);
  t.manager.updateSettings({ superAutonomy: 'full', superDailyBudgetUsd: 1 });
  (t.manager as unknown as { superStore: { addAutonomousCost(usd: number): void } }).superStore.addAutonomousCost(5);
  await assert.rejects(ownCall('take_action', { kind: 'costly', summary: 'Big job', why: 'x', agent: 'Ada', task: 'go', undo: 'stop' }), e => status(e) === 409 && /budget/.test((e as Error).message));
});

test('M1: one approval cannot be used by two concurrent take_action calls; an approved force_push hands the agent one push token', async () => {
  const t = await team();
  const del = { kind: 'delete_data', summary: 'Delete old backups', why: 'Space.', agent: 'Ada', target: 'old backups', project: 'web', backup: 'backup/fix-x', branch: 'fix/x', task: 'rm -rf /tmp/old-backups' };
  const id = await approve(t, 'delete_data', 'old backups', undefined, del.task);
  // The backup check awaits git, so both calls would pass the check before either consumed it.
  const results = await Promise.allSettled([t.call('take_action', { ...del, approved_ask_id: id }), t.call('take_action', { ...del, approved_ask_id: id })]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'Rhea A9: exactly one goes');
  // An approved force-push: one feature branch of one project, a token bound to its remote (Rhea round 4).
  const dir = t.dir;
  git(dir, 'remote', 'add', 'origin', '/srv/web.git');
  git(dir, 'tag', 'v1');
  const force = { kind: 'force_push', summary: 'Force-push fix/x', why: 'Rebased.', agent: 'Ada', target: 'fix/x', project: 'web', branch: 'fix/x', task: 'git push --force origin fix/x', undo: 'Push the old tip back from backup/fix-x.' };
  const ok = await approve(t, 'force_push', 'fix/x', undefined, force.task);
  await t.call('take_action', { ...force, approved_ask_id: ok });
  const sent = t.store.messages.filter(m => m.toAgentId === t.ada.id && m.delegation?.task === force.task).at(-1)!;
  const token = /PODCODE_PUSH_OVERRIDE=([a-f0-9]{24})/.exec(sent.delegation!.acceptanceCriteria)?.[1];
  assert.ok(token, 'the token is in the task');
  // Kept in PodCode's memory: nothing on disk an agent could write (Rhea round 3).
  assert.ok(!fs.existsSync(path.join(t.store.dataDir, 'git-hooks', 'overrides', token!)), 'not a file');
  assert.equal(redeemOverride(token, 'refs/heads/fix/x(overwrite)', '/elsewhere.git').ok, false, 'another repository');
  assert.equal(redeemOverride(token, 'refs/heads/main(overwrite)', '/srv/web.git').ok, false, 'another branch');
  assert.equal(redeemOverride(token, 'refs/heads/fix/x(overwrite)', '/srv/web.git').ok, true, 'fix/x on its remote, after the misses (they do not use it up)');
  assert.equal(redeemOverride(token, 'refs/heads/fix/x(overwrite)', '/srv/web.git').ok, false, 'once');
  // Never main, master, the default branch or a tag; a branch and project are required (M1, L2).
  for (const [branch, project, why] of [['main', 'web', /shared main line/], ['master', 'web', /shared main line/], ['develop', 'web', /shared main line/], ['v1', 'web', /a tag/], ['refs/tags/v1', 'web', /Tags/], ['', 'web', /names its project and the branch/], ['fix/x', '', /names its project and the branch/]] as const) {
    const task = `git push --force origin ${branch || 'x'}`;
    const id = await approve(t, 'force_push', branch || 'fix/x', undefined, task);
    await assert.rejects(t.call('take_action', { ...force, target: branch || 'fix/x', branch: branch || undefined, project: project || undefined, task, approved_ask_id: id }), e => [400, 403].includes(status(e)) && why.test((e as Error).message), `${branch}/${project}`);
  }
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  const trunk = await approve(t, 'force_push', 'trunk', undefined, 'git push --force origin trunk');
  await assert.rejects(t.call('take_action', { ...force, target: 'trunk', branch: 'trunk', task: 'git push --force origin trunk', approved_ask_id: trunk }), e => status(e) === 403 && /shared main line/.test((e as Error).message), 'the remote\'s default branch');
  // With the switch off and no approval, a force_push gets no token: the push check still refuses overwriting.
  t.manager.updateSettings({ superAskFirst: { ...ALL_ASK_FIRST, forcePush: false } });
  await t.call('take_action', { ...force, target: 'fix/new', task: 'git push -u origin fix/new', summary: 'Push fix/new' });
  const plain = t.store.messages.filter(m => m.toAgentId === t.ada.id).at(-1)!;
  assert.doesNotMatch(plain.delegation!.acceptanceCriteria, /PODCODE_PUSH_OVERRIDE/);
});

test('M4: paused, its own turns cannot start agents through a channel mention, a reply that expects an answer, or change an agent', async () => {
  const t = await team();
  t.runner.complete(); await settle();
  (t.manager as unknown as { wakeSuper(p: string, l: string): void }).wakeSuper('Update.', 'Update.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  const ownCall = (tool: string, args: Record<string, unknown>) => t.manager.commsTool(own.ctx.commsToken!, tool, args);
  t.manager.updateSettings({ superPaused: true });
  const paused = (e: unknown) => status(e) === 409 && /paused you/.test((e as Error).message);
  await assert.rejects(ownCall('post_to_channel', { channel: 'ops', text: 'Ada, take this', mention_agent_ids: [t.ada.id] }), paused, 'Rhea P3');
  await assert.rejects(ownCall('reply', { message_id: 'm-x', text: 'Go ahead', expects_reply: true }), paused);
  await assert.rejects(ownCall('update_agent', { agent_id: 'Ada', model: 'opus', why: 'x' }), paused, 'Rhea P4');
  await assert.rejects(ownCall('new_session', { agent_id: 'Ada', why: 'fresh start' }), paused, 'Rhea P5: a fresh session waits too');
});

test('the text warning: dots inside commands do not split a sentence; "without" and "never mind" still ask for it (Rhea round 3)', () => {
  for (const bad of ['git -c core.x=1 push -f origin main', 'Force-push main without waiting for CI.', 'Please force-push main, never mind the warning.', 'Run v1.2.3 checks. Then git push --force origin main.', 'Avoid nothing: force push main now']) assert.ok(forbiddenGit(bad), bad);
  for (const ok of ['Do not run git push --force.', 'Push the fix, but never force-push main.', 'Merge fix/a into main. Do not force-push.', 'Avoid git push -f; push a revert instead.', 'Run npm test. Then git push origin fix/a.', 'Note: do not force-push main.']) assert.equal(forbiddenGit(ok), null, ok);
});
