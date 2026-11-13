import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { claudeToolPolicy, superMayUse } from '../server/agents/claude.ts';
import { HttpError } from '../server/errors.ts';
import { Store } from '../server/store.ts';
import { ACTION_KINDS, actionVerdict, ALL_ASK_FIRST, autonomyInstructions, cleanAutonomy, SOUL_LINE_FROM, SOUL_LINE_TO, suggestedSoul, type ActionKind, type AskFirst } from '../shared/autonomy.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { harness, projectDir, settle, tempDir } from './helpers.ts';

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
  assert.match(full, /Always ask first with ask_user.*deleting files or data.*outside accounts.*removing agents the user made.*force-pushing/);
  assert.match(full, /never: rewrite or force-push shared history/);
  assert.doesNotMatch(full, /PAUSED/);
  assert.doesNotMatch(autonomyInstructions('full', NONE, false), /Always ask first/, 'no ask-first line with every switch off');
  assert.match(autonomyInstructions('standard', ALL_ASK_FIRST, false), /merge approved branches into local main.*\n.*Ask with ask_user before anything else of that kind \(push/);
  assert.match(autonomyInstructions('ask', ALL_ASK_FIRST, false), /Ask the user with ask_user before every merge, restart, push/);
  assert.match(autonomyInstructions('full', ALL_ASK_FIRST, true), /The user PAUSED you/);
  assert.equal(suggestedSoul(`You run the team: ${SOUL_LINE_FROM} You never edit.`), `You run the team: ${SOUL_LINE_TO} You never edit.`);
  assert.equal(suggestedSoul('Edited by hand already.'), 'Edited by hand already.');
});

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const web = h.manager.addProject({ path: projectDir(h.dir, 'web') });
  const ada = await h.manager.create({ name: 'Ada', engine: 'claude', projectId: web.id });
  const rhea = await h.manager.create({ name: 'Rhea', engine: 'claude', projectId: web.id, role: 'reviewer' });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const runner = h.runner(sup.id);
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner.ctx.commsToken!, tool, args);
  return { ...h, web, ada, rhea, sup, runner, call };
}

/** The reviewer's passing report on a branch, through the real tools. */
async function reviewerPasses(t: Awaited<ReturnType<typeof team>>, branch: string) {
  const asked = await t.call('delegate_task', { to_agent_id: t.rhea.id, kind: 'review', task: `Review ${branch}`, acceptance_criteria: 'Typecheck and tests pass.' }) as { id: string };
  await settle();
  const rheaToken = t.runners.get(t.rhea.id)!.at(-1)!.ctx.commsToken!;
  await t.manager.commsTool(rheaToken, 'report_result', { message_id: asked.id, outcome: 'passed', summary: `APPROVE ${branch}: typecheck 0, tests pass.`, evidence: 'npm test 794/794' });
}

test('take_action on Full: a reviewed merge goes to the agent and is logged FULL with its undo; no review, no merge; removals need a backup; shared history never', async () => {
  const t = await team();
  const merge = { kind: 'merge', summary: 'Merge fix/x into main', why: 'Approved and green.', agent: 'Ada', branch: 'fix/x', task: 'git merge --ff-only fix/x on main; run npm test.', undo: 'git reset --hard backup/main-before-fix-x (not pushed yet)' };
  await assert.rejects(t.call('take_action', merge), e => status(e) === 409 && /No reviewer has passed fix\/x/.test((e as Error).message));
  await reviewerPasses(t, 'fix/x');
  const done = await t.call('take_action', merge) as { verdict: string; by: string };
  assert.deepEqual([done.verdict, done.by], ['act', 'Ada']);
  const entry = t.manager.superView().log[0];
  assert.equal(entry.tool, 'take_action');
  assert.equal(entry.autonomy, 'full', 'marked FULL in Decisions');
  assert.deepEqual(entry.undo, { kind: 'reverse', how: merge.undo, agentId: t.ada.id });
  assert.ok(t.store.messages.some(m => m.toAgentId === t.ada.id && m.delegation?.task === merge.task), 'handed to Ada as a delegation');
  await assert.rejects(t.call('take_action', { kind: 'cleanup', summary: 'Remove merged worktrees', why: 'Merged.', agent: 'Ada', task: 'git worktree remove …' }), e => status(e) === 400 && /backup/.test((e as Error).message));
  assert.ok(await t.call('take_action', { kind: 'cleanup', summary: 'Remove merged worktrees', why: 'Merged.', agent: 'Ada', task: 'git worktree remove …', backup: 'backup/fix-x' }));
  await assert.rejects(t.call('take_action', { kind: 'rewrite_history', summary: 'Force-push main', why: 'Tidy.', agent: 'Ada', task: 'git push -f' }), e => status(e) === 403);
  for (const kind of ['restart', 'push', 'release', 'deploy', 'project', 'costly']) {
    const r = await t.call('take_action', { kind, summary: kind, why: 'Full.', agent: 'Ada', task: `Do the ${kind}.` }) as { verdict: string };
    assert.equal(r.verdict, 'act', kind);
  }
});

test('ask-first switches and lower levels need the user\'s yes to an ask_user question, checked on the server', async () => {
  const t = await team();
  const railway = { kind: 'outside_account', summary: 'Delete Railway project x', why: 'Unused.', agent: 'Ada', task: 'railway delete x' };
  await assert.rejects(t.call('take_action', railway), e => status(e) === 409 && /asks the user first/.test((e as Error).message));
  const { asked } = await t.call('ask_user', { question: 'Delete Railway project x?', options: ['Delete it', 'Not now'], why: 'Unused.' }) as { asked: { id: string } };
  await assert.rejects(t.call('take_action', { ...railway, approved_ask_id: asked.id }), e => status(e) === 409, 'not answered yet');
  t.manager.answerSuper(asked.id, { answer: 'Not now' });
  await assert.rejects(t.call('take_action', { ...railway, approved_ask_id: asked.id }), e => status(e) === 409, 'a no is not a yes');
  const { asked: again } = await t.call('ask_user', { question: 'Delete Railway project x now?', options: ['Delete it', 'Keep it'], why: 'Unused.' }) as { asked: { id: string } };
  t.manager.answerSuper(again.id, { answer: 'Delete it' });
  const ok = await t.call('take_action', { ...railway, approved_ask_id: again.id }) as { verdict: string };
  assert.equal(ok.verdict, 'ask');
  assert.equal(t.manager.superView().log[0].autonomy, undefined, 'asked first, so not marked FULL');
  // The switch off: Full does it without asking.
  t.manager.updateSettings({ superAskFirst: { ...ALL_ASK_FIRST, outsideAccounts: false } });
  assert.equal((await t.call('take_action', railway) as { verdict: string }).verdict, 'act');
  // Standard asks before a push; Ask asks before a restart.
  t.manager.updateSettings({ superAutonomy: 'standard' });
  await assert.rejects(t.call('take_action', { kind: 'push', summary: 'Push main', why: 'Merged.', agent: 'Ada', task: 'git push' }), e => status(e) === 409);
  assert.equal((await t.call('take_action', { kind: 'restart', summary: 'Restart', why: 'Merged.', agent: 'Ada', task: 'restart' }) as { verdict: string }).verdict, 'act');
  t.manager.updateSettings({ superAutonomy: 'ask' });
  await assert.rejects(t.call('take_action', { kind: 'restart', summary: 'Restart', why: 'Merged.', agent: 'Ada', task: 'restart' }), e => status(e) === 409);
});

test('remove_user_agent: an agent the user made needs a yes; one it created itself it may remove', async () => {
  const t = await team();
  await assert.rejects(t.call('take_action', { kind: 'remove_user_agent', summary: 'Remove Ada', why: 'Idle.', agent: 'Ada' }), e => status(e) === 409);
  await t.call('create_agent', { name: 'Ivy', engine: 'claude', role: 'tester', why: 'A tester for the re-test.' });
  const removed = await t.call('take_action', { kind: 'remove_user_agent', summary: 'Remove Ivy', why: 'Done testing.', agent: 'Ivy' }) as { verdict: string };
  assert.equal(removed.verdict, 'act');
  await settle();
  assert.ok(![...t.store.agents.values()].some(a => a.name === 'Ivy'));
  assert.equal(t.manager.superView().log.find(a => a.tool === 'create_agent')?.autonomy, undefined, 'created in your own turn: not marked FULL');
});

test('Pause: it starts nothing on its own (take_action refused, turns held) until resumed; your own turns still go', async () => {
  const t = await team();
  t.runner.complete();
  await settle();
  // An update turn: one it gets on its own, not from you.
  (t.manager as unknown as { wakeSuper(prompt: string, line: string): void }).wakeSuper('Update: Ada finished.', 'Update: Ada finished.');
  await settle();
  const own = t.runners.get(t.sup.id)!.at(-1)!;
  t.manager.updateSettings({ superPaused: true });
  await assert.rejects(t.manager.commsTool(own.ctx.commsToken!, 'take_action', { kind: 'restart', summary: 'Restart', why: 'x', agent: 'Ada', task: 'restart' }), e => status(e) === 409 && /paused you/.test((e as Error).message));
  await assert.rejects(t.manager.commsTool(own.ctx.commsToken!, 'create_agent', { name: 'Ivy', engine: 'claude', role: 'tester', why: 'x' }), e => status(e) === 409 && /paused you/.test((e as Error).message));
  own.complete();
  await settle();
  assert.equal((t.manager as unknown as { watcher: { held(): string | null } }).watcher.held(), 'you paused it');
  t.manager.send(t.sup.id, 'Restart PodCode now.');
  await settle();
  const runner = t.runners.get(t.sup.id)!.at(-1)!;
  const r = await t.manager.commsTool(runner.ctx.commsToken!, 'take_action', { kind: 'restart', summary: 'Restart', why: 'You asked.', agent: 'Ada', task: 'restart' }) as { verdict: string };
  assert.equal(r.verdict, 'act', 'work you asked for still goes');
  t.manager.updateSettings({ superPaused: false });
  assert.equal((t.manager as unknown as { watcher: { held(): string | null } }).watcher.held(), null);
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
  assert.ok(sent.some(s => /pressed Undo on "Push main 28833e9".*Push a revert commit of 28833e9/s.test(s.text) && s.task?.source === 'user'), 'a user task with the reverse step');
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
  assert.deepEqual(saved.superAskFirst, { ...ALL_ASK_FIRST, forcePush: false }, 'one switch changed, the others kept');
  const next = t.runner.ctx.preparePrompt!('Next update.');
  assert.match(next, /Since this session started, the following changed[\s\S]*Autonomy \(Settings, SuperAgent\): Standard/);
  // Other agents get no Autonomy section.
  const adaRunner = t.runners.get(t.ada.id)?.at(-1);
  if (adaRunner) assert.doesNotMatch(adaRunner.ctx.instructions!(), /Autonomy \(Settings, SuperAgent\)/);
});
