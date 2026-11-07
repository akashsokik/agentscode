// Runs one scenario in one arm against a real AgentManager on a temp data dir and temp project.
// Imported by run.ts only after it has pointed PORT and AGENTSCODE_HOME away from the user's app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Approval, ApprovalDecision, EngineInfo, EngineKind, Entry, ServerEvent } from '../../shared/types.ts';
import { detectEngine } from '../../server/config.ts';
import { AgentManager, type ManagerOptions } from '../../server/manager.ts';
import { Store } from '../../server/store.ts';
import type { CommsEndpoint } from './comms.ts';
import { attribute, fakeDreamOptions, forgetWhere, readDreams, setDreaming, settleDreams, type DreamRecord, type Writer } from './dream.ts';
import { FakeAgent, type Progress } from './fake.ts';
import type { ProjectFiles, Scenario } from './scenario.ts';
import { sessionView, writeSeed } from './view.ts';

/**
 * - off: today's product. Dreaming off; the agent may still save lessons itself with remember.
 * - none: dreaming off and memory.md emptied before session 2. Passing here means memory was not needed.
 * - dream-only: dreaming on, and the agent's own entries removed before the dream (and again before
 *   session 2), so whatever is in memory at session 2 is the dream's own work.
 * - on: dreaming on, nothing removed: the product with dreaming.
 */
export type Arm = 'off' | 'none' | 'dream-only' | 'on';
export const ARMS: Arm[] = ['off', 'none', 'dream-only', 'on'];
const DREAMING: Record<Arm, boolean> = { off: false, none: false, 'dream-only': true, on: true };

export interface RunOptions {
  engine: EngineKind;
  dry: boolean;
  model?: string;
  turnTimeoutMs: number;
  /** /tmp/dream-eval/<ts>; each arm keeps links to its folders in <outDir>/<scenario>-<arm>-s<n>/. */
  outDir: string;
  comms: CommsEndpoint;
  /** Stop at the first turn boundary where spent() plus this arm's cost so far passes cap. */
  budget: { cap: number; spent: () => number };
  /** The manager of the arm in progress (null between arms), so a signal handler can shut it down. */
  onManager(manager: AgentManager | null): void;
  log(line: string): void;
}

export interface ArmResult {
  scenario: string;
  kind: Scenario['kind'];
  arm: Arm;
  sample: number;
  /** scored: pass or fail. inconclusive: nothing to judge. error: the run broke. stopped: the cost cap. */
  status: 'scored' | 'inconclusive' | 'error' | 'stopped';
  pass: boolean | null;
  detail: string;
  /** Where it broke, for error and stopped. */
  error?: { stage: string; message: string };
  /** For each lesson, which writers had it in memory when session 2 started (rewritten: the agent's entry, updated by the dream). */
  lessons: { id: string; agent: boolean; dream: boolean; rewritten: boolean }[];
  /** memory.md when session 2 started, each entry attributed to its writer (see attribute()). */
  memory: { text: string; why?: string; by: Writer; rewritten: boolean }[];
  /** Entries the arm removed: the agent's own before the dream (dream-only), or everything (none). */
  removed: { beforeDream: number; beforeSession2: number };
  /** The session-end dream (dreaming arms): ran, or skipped by the gate. */
  gate: 'ran' | 'skipped' | 'off';
  dream: DreamRecord | null;
  /** Dreams beyond the session-end one (there should be none). */
  extraDreams: number;
  cost: { sessionsUsd: number; dreamUsd: number; tokens: number; turns: number };
  approvalsAnswered: number;
  workDir: string;
  project: string;
  dataDir: string;
  durationMs: number;
}

const FAKE_ENGINE: EngineInfo = { available: true, path: '/usr/bin/false', version: '0.0.0-dry' };
const NO_ANSWER = 'This is an automated evaluation and nobody can answer questions. Choose the most reasonable option yourself and continue.';
const DAY = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Stopped extends Error {}

function isTurnEnd(entry: Entry): boolean {
  return entry.kind === 'done' || entry.kind === 'error' || (entry.kind === 'system' && entry.text === 'Stopped.');
}

function packageName(scenario: Scenario): string {
  try {
    const name = String((JSON.parse(scenario.seed['package.json'] ?? '{}') as { name?: unknown }).name ?? '');
    return name.replace(/[^\w.-]/g, '-') || 'app';
  } catch {
    return 'app';
  }
}

/**
 * Folders whose paths give nothing away, kept apart. The agent sees its project path, and the dream runs
 * in the agent's home under the data dir, so neither may name the scenario or the eval; and the data dir
 * (transcripts, memory.md) is not next to the project, where `ls ..` would show it. The project is
 * <tmp>/ws-XXXXXX/<package name>, the data dir <tmp>/st-XXXXXX. <workDir> links to both.
 */
function neutralFolders(scenario: Scenario, workDir: string): { project: string; data: string } {
  const project = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')), packageName(scenario));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.mkdirSync(project);
  fs.symlinkSync(project, path.join(workDir, 'project'));
  fs.symlinkSync(data, path.join(workDir, 'data'));
  return { project, data };
}

/** Put the project back to the seed, so session 2 cannot pick a lesson up from session 1's files. */
function resetProject(project: string, seed: Record<string, string>): void {
  if (!path.basename(path.dirname(project)).startsWith('ws-')) throw new Error(`Refusing to reset ${project}: it is not an eval project.`);
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(project);
  writeSeed(project, seed);
}

function projectFiles(project: string): ProjectFiles {
  return {
    read: rel => {
      try {
        return fs.readFileSync(path.join(project, rel), 'utf8');
      } catch {
        return null;
      }
    },
    write: (rel, text) => fs.writeFileSync(path.join(project, rel), text),
  };
}

export async function runArm(scenario: Scenario, arm: Arm, sample: number, opts: RunOptions): Promise<ArmResult> {
  const started = Date.now();
  const workDir = path.join(opts.outDir, `${scenario.id}-${arm}-s${sample}`);
  fs.mkdirSync(workDir, { recursive: true });
  const { project, data } = neutralFolders(scenario, workDir);
  writeSeed(project, scenario.seed);

  const result: ArmResult = {
    scenario: scenario.id, kind: scenario.kind, arm, sample, status: 'scored', pass: null, detail: '',
    lessons: scenario.lessons.map(l => ({ id: l.id, agent: false, dream: false, rewritten: false })), memory: [],
    removed: { beforeDream: 0, beforeSession2: 0 }, gate: DREAMING[arm] ? 'skipped' : 'off', dream: null, extraDreams: 0,
    cost: { sessionsUsd: 0, dreamUsd: 0, tokens: 0, turns: 0 }, approvalsAnswered: 0,
    workDir, project, dataDir: data, durationMs: 0,
  };

  const store = new Store(data);
  store.load();
  const progress: Progress = { session: 1, step: 0 };
  let manager: AgentManager | null = null;
  const answer = (approval: Approval) => {
    const decision: ApprovalDecision = approval.type === 'question' ? { allow: false, message: NO_ANSWER } : { allow: true };
    try {
      manager?.resolveApproval(approval.id, decision);
      result.approvalsAnswered++;
    } catch {
      // already answered or cancelled
    }
  };
  const hub = {
    broadcast(event: ServerEvent) {
      if (event.type === 'approval') setImmediate(() => answer(event.approval));
    },
  };
  const engines: Record<EngineKind, EngineInfo> = opts.dry
    ? { claude: FAKE_ENGINE, codex: FAKE_ENGINE, orcacode: FAKE_ENGINE }
    : { claude: await detectEngine('claude'), codex: await detectEngine('codex'), orcacode: await detectEngine('orcacode') };
  const options: ManagerOptions = {
    worktreesRoot: path.join(data, 'worktrees'),
    // No idle-close dreams: the only dream is the session-end one.
    idleProcessMs: DAY,
    ...(opts.dry ? { createRunner: ctx => new FakeAgent(ctx, scenario, progress), ...fakeDreamOptions(scenario) } : {}),
  };
  manager = new AgentManager(store, hub, engines, options);
  manager.init();
  const m = manager;
  opts.comms.use(m);
  opts.onManager(m);

  let agentId = '';
  let home = '';
  let stage = 'setup';

  const costs = () => {
    const ends = agentId ? m.entries(agentId).filter(e => e.kind === 'done' || e.kind === 'error') : [];
    const dreamUsd = home ? readDreams(home).reduce((sum, d) => sum + (d.metrics?.costUsd ?? 0), 0) : 0;
    return {
      sessionsUsd: ends.reduce((sum, e) => sum + (e.meta?.costUsd ?? 0), 0),
      dreamUsd,
      tokens: ends.reduce((sum, e) => sum + (e.meta?.tokens ?? 0), 0),
      turns: ends.length,
    };
  };
  const checkBudget = () => {
    const c = costs();
    const total = opts.budget.spent() + c.sessionsUsd + c.dreamUsd;
    if (total > opts.budget.cap) throw new Stopped(`spent $${total.toFixed(2)}, over the $${opts.budget.cap} cap`);
  };

  /** Send one user message and wait for its turn to end. */
  const turn = async (text: string) => {
    const ends = () => m.entries(agentId).filter(isTurnEnd);
    const before = ends().length;
    m.send(agentId, text);
    const until = Date.now() + opts.turnTimeoutMs;
    for (;;) {
      await sleep(opts.dry ? 5 : 500);
      const agent = store.agents.get(agentId);
      const done = ends();
      if (agent && agent.status !== 'working' && agent.status !== 'waiting' && agent.queued === 0 && done.length > before) {
        const last = done.at(-1)!;
        if (last.kind === 'error') throw new Error(`the engine failed the turn: ${last.text}`);
        if (last.kind === 'system') throw new Error('the turn was stopped');
        break;
      }
      if (Date.now() > until) {
        await m.stop(agentId).catch(() => {});
        throw new Error(`the turn did not finish within ${Math.round(opts.turnTimeoutMs / 1000)}s`);
      }
    }
    checkBudget();
  };

  try {
    const { id: projectId } = m.addProject({ path: project });
    const agent = await m.create({ name: 'Kai', engine: opts.engine, projectId, autonomy: 'full', model: opts.model });
    agentId = agent.id;
    home = agent.home;
    await setDreaming(m, agentId, DREAMING[arm]);

    const files = projectFiles(project);
    for (const [i, message] of scenario.session1.entries()) {
      stage = `session 1, turn ${i + 1}/${scenario.session1.length}`;
      progress.step = i;
      opts.log(`  ${stage}`);
      await turn(message);
      scenario.userEdits?.[i]?.(files);
    }

    // The dream reads memory.md as it is now: in dream-only, without the agent's own entries (before the
    // first dream, every entry is the agent's). Removing them only after the dream would measure nothing:
    // the dream would see the lesson already saved, change nothing, and the removal would then delete it.
    if (arm === 'dream-only') result.removed.beforeDream = forgetWhere(m, agentId, () => true);
    const beforeDream = new Set(m.memory(agentId).map(e => e.id));
    stage = 'session end and dream';
    if (DREAMING[arm]) opts.log('  session end: dream (if the gate allows)');
    // The real trigger: newSession() starts the session-end dream when the gate (3+ turns) allows it.
    await m.newSession(agentId);
    await settleDreams(home, 6 * 60_000);
    const dreams = readDreams(home);
    result.dream = dreams.at(-1) ?? null;
    if (DREAMING[arm]) result.gate = result.dream ? 'ran' : 'skipped';
    result.extraDreams = Math.max(0, dreams.length - 1);
    checkBudget();

    if (arm === 'dream-only') {
      const agents = new Set(attribute(m.memory(agentId), beforeDream).filter(a => a.by === 'agent').map(a => a.entry.id));
      result.removed.beforeSession2 = forgetWhere(m, agentId, e => agents.has(e.id));
    }
    if (arm === 'none') result.removed.beforeSession2 = forgetWhere(m, agentId, () => true);
    resetProject(project, scenario.seed);

    const memory = attribute(m.memory(agentId), beforeDream);
    result.memory = memory.map(a => ({ text: a.entry.text, why: a.entry.why, by: a.by, rewritten: a.rewritten }));
    result.lessons = scenario.lessons.map(lesson => {
      const holders = memory.filter(a => lesson.knows.test(`${a.entry.text} ${a.entry.why ?? ''}`));
      return {
        id: lesson.id,
        agent: holders.some(a => a.by === 'agent'),
        dream: holders.some(a => a.by === 'dream'),
        rewritten: holders.some(a => a.rewritten),
      };
    });

    stage = 'session 2';
    progress.session = 2;
    progress.step = 0;
    opts.log(`  ${stage}`);
    await turn(scenario.session2);

    stage = 'scoring';
    const score = scenario.score(sessionView(project, scenario.seed, m.entries(agentId)));
    result.pass = score.pass;
    result.detail = score.detail;
    result.status = score.pass === null ? 'inconclusive' : 'scored';
  } catch (err) {
    const stopped = err instanceof Stopped;
    result.status = stopped ? 'stopped' : 'error';
    result.pass = null;
    result.error = { stage, message: (err as Error).message };
    result.detail = `${stopped ? 'stopped' : 'error'} at ${stage}: ${result.error.message}`;
  } finally {
    opts.comms.use(null);
    result.cost = costs();
    await m.shutdown();
    opts.onManager(null);
    result.durationMs = Date.now() - started;
  }
  return result;
}
