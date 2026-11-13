import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import type { SuperRoutine, SuperState } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import { HttpError } from '../server/errors.ts';
import { routineDue, SuperStore, type SuperWatcher } from '../server/superAgent.ts';
import { harness, settle, tempDir } from './helpers.ts';
import { OPEN_AUTH } from '../server/userAuth.ts';

function status(error: unknown): number {
  assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
  return error.status;
}

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);
const routine = (over: Partial<SuperRoutine>): SuperRoutine => ({ id: 'r1', name: 'CI', projectId: null, instruction: 'Check CI.', schedule: { kind: 'daily', at: '09:00' }, enabled: true, by: 'user', createdAt: at(9, 8).getTime(), ...over });

test('when a routine is due: daily once its time has passed and it has not run since; every N hours; a missed slot runs once', () => {
  const daily = routine({});
  assert.equal(routineDue(daily, at(9, 8, 59)), null);
  assert.equal(routineDue(daily, at(9, 9, 30)), at(9, 9).getTime());
  assert.equal(routineDue({ ...daily, lastRunAt: at(9, 9, 30).getTime() }, at(9, 23)), null, 'once a day');
  assert.equal(routineDue({ ...daily, lastRunAt: at(9, 9, 30).getTime() }, at(10, 9, 5)), at(10, 9).getTime());
  assert.equal(routineDue({ ...daily, createdAt: at(9, 10).getTime() }, at(9, 11)), null, 'made after today\'s time: from tomorrow');
  const every = routine({ schedule: { kind: 'every', hours: 6 } });
  assert.equal(routineDue(every, at(9, 13, 59)), null);
  assert.equal(routineDue(every, at(9, 14)), at(9, 14).getTime());
  assert.equal(routineDue(every, at(12, 3)), at(9, 14).getTime(), 'days late, it runs once');
  assert.equal(routineDue({ ...every, enabled: false }, at(12, 3)), null, 'paused');
  assert.equal(routineDue({ ...every, proposed: true }, at(12, 3)), null, 'a proposal never runs');
});

test('the routine store: the user\'s are on, a proposal waits; names, schedules and text are checked', () => {
  const store = new SuperStore(tempDir('routines'));
  const mine = store.addRoutine({ name: 'Morning CI', instruction: 'Check  CI.', projectId: null, schedule: { kind: 'daily', at: '09:00' } }, 'user');
  assert.equal(mine.enabled, true);
  assert.equal(mine.instruction, 'Check CI.');
  const its = store.addRoutine({ name: 'Weekly tidy', instruction: 'Look for stale branches.', projectId: 'web', schedule: { kind: 'every', hours: 168 }, why: 'Branches pile up.' }, 'super');
  assert.deepEqual([its.enabled, its.proposed, its.why], [false, true, 'Branches pile up.']);
  assert.throws(() => store.addRoutine({ name: 'morning ci', instruction: 'x', projectId: null, schedule: { kind: 'every', hours: 1 } }, 'user'), e => status(e) === 409);
  for (const schedule of [{ kind: 'daily', at: '25:00' }, { kind: 'every', hours: 0 }, { kind: 'every', hours: 1.5 }, { kind: 'weekly' }, null]) {
    assert.throws(() => store.addRoutine({ name: `X${JSON.stringify(schedule)}`, instruction: 'x', projectId: null, schedule }, 'user'), e => status(e) === 400, JSON.stringify(schedule));
  }
  assert.throws(() => store.addRoutine({ name: 42, instruction: 'x', projectId: null, schedule: { kind: 'every', hours: 1 } }, 'user'), e => status(e) === 400);
  assert.throws(() => store.updateRoutine(its.id, { enabled: true }), e => status(e) === 409, 'confirm a proposal first');
  assert.equal(store.updateRoutine(its.id, { confirm: true }).enabled, true);
  assert.equal(store.updateRoutine(mine.id, { enabled: false }).enabled, false);
  store.removeRoutine(mine.id);
  assert.deepEqual(store.routines().map(r => r.name), ['Weekly tidy']);
});

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Run the team.');
  await settle();
  const runner = h.runner(sup.id);
  const call = (tool: string, args: Record<string, unknown>) => h.manager.commsTool(runner.ctx.commsToken!, tool, args);
  const watcher = (h.manager as unknown as { watcher: SuperWatcher }).watcher;
  const tick = () => (h.manager as unknown as { superTick(): void }).superTick();
  /** Pretend a routine was made `hours` ago. */
  const age = (id: string, hours: number) => {
    const file = path.join(h.store.dataDir, 'super.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { routines: SuperRoutine[] };
    data.routines = data.routines.map(r => (r.id === id ? { ...r, createdAt: Date.now() - hours * 3_600_000 } : r));
    fs.writeFileSync(file, JSON.stringify(data));
  };
  return { ...h, sup, runner, call, watcher, tick, age };
}

test('a due routine becomes an update for the SuperAgent, through every wake check, once per slot', async () => {
  const t = await team();
  t.runner.complete();
  const view = t.manager.addRoutine({ name: 'CI check', instruction: 'Check CI on main and tell me if it is red.', projectId: null, schedule: { kind: 'every', hours: 1 } });
  const id = view.routines[0].id;
  t.age(id, 2);
  // Wake-ups off: the routine is noted but nothing goes.
  t.manager.updateSettings({ superWake: false });
  t.tick();
  assert.equal(t.watcher.waiting(), 1);
  assert.equal(t.watcher.flush(), false);
  t.manager.updateSettings({ superWake: true });
  assert.equal(t.watcher.flush(), true);
  await settle();
  assert.match(t.runner.sent.at(-1)!.text, /Routine "CI check", as the user set it up: Check CI on main and tell me if it is red\./);
  assert.equal(t.runner.sent.at(-1)!.task?.source, 'system');
  // Marked as run: the next minute is not a second run.
  t.runner.complete();
  t.tick();
  assert.equal(t.watcher.waiting(), 0);
  assert.ok(t.manager.superView().routines[0].lastRunAt);
});

test('the SuperAgent can list routines and only propose one; a proposal never runs until you confirm it, and undo withdraws it', async () => {
  const t = await team();
  const { proposed } = await t.call('propose_routine', { name: 'Stale branches', schedule: { kind: 'every', hours: 1 }, instruction: 'List merged branches.', why: 'They pile up.' }) as { proposed: SuperRoutine };
  assert.equal(proposed.proposed, true);
  assert.equal(proposed.enabled, false);
  assert.match(t.manager.superView().log[0].summary, /Proposed the routine "Stale branches" \(every 1 hour\)/);
  t.runner.complete();
  t.age(proposed.id, 5);
  t.tick();
  assert.equal(t.watcher.waiting(), 0, 'a proposal never runs');
  const { routines } = await (async () => { t.manager.send(t.sup.id, 'Go.'); await settle(); return await t.call('list_routines', {}) as { routines: SuperRoutine[] }; })();
  assert.equal(routines.length, 1);
  // Undo withdraws it while it is still a proposal.
  await t.manager.undoSuper(t.manager.superView().log[0].id);
  assert.equal(t.manager.superView().routines.length, 0);
  // Confirmed, it is yours: undo refuses.
  const again = await t.call('propose_routine', { name: 'Stale branches', schedule: { kind: 'daily', at: '08:00' }, instruction: 'List merged branches.', why: 'x' }) as { proposed: SuperRoutine };
  t.manager.updateRoutine(again.proposed.id, { confirm: true });
  await assert.rejects(t.manager.undoSuper(t.manager.superView().log[0].id), e => status(e) === 409);
  assert.equal(t.manager.superView().routines[0].enabled, true);
});

test('the app manages routines over HTTP', async () => {
  const t = await team();
  const server = createApp(t.manager, undefined, undefined, OPEN_AUTH).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/super/routines`;
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const added = await (await send(base, 'POST', { name: 'Morning', instruction: 'Brief me.', projectId: null, schedule: { kind: 'daily', at: '08:30' } })).json() as SuperState;
    const id = added.routines[0].id;
    assert.equal(added.routines[0].by, 'user');
    assert.equal((await send(base, 'POST', { name: 'Bad', instruction: 'x', schedule: { kind: 'daily', at: 'noon' } })).status, 400);
    const paused = await (await send(`${base}/${id}`, 'PATCH', { enabled: false })).json() as SuperState;
    assert.equal(paused.routines[0].enabled, false);
    assert.deepEqual((await (await send(`${base}/${id}`, 'DELETE')).json() as SuperState).routines, []);
    assert.equal((await send(`${base}/${id}`, 'DELETE')).status, 404);
  } finally {
    server.close();
  }
});
