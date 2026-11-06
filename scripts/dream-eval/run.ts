// Offline dreaming eval: does an agent apply lessons from session 1 in session 2, with dreaming on
// versus off? See README.md. Run on demand; never part of npm test.
//
//   node scripts/dream-eval/run.ts [--scenarios a,b|hard|explicit] [--samples N] [--max-cost USD] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startCommsEndpoint } from './comms.ts';
import type { Arm, ArmResult } from './harness.ts';
import type { Scenario } from './scenario.ts';
import { SCENARIOS } from './scenarios/index.ts';

const OUT_ROOT = '/tmp/dream-eval';
const ALL_ARMS: Arm[] = ['off', 'none', 'dream-only', 'on'];

const USAGE = `Usage: node scripts/dream-eval/run.ts [options]

  --scenarios a,b     Scenario ids, or a group: hard, explicit, all (default: all)
  --arms a,b          Arms to run: off, none, dream-only, on (default: all four)
  --samples N         Runs of each scenario and arm (default: 1)
  --max-cost USD      Stop at the first turn past this spend (default: 5)
  --seed N            Seed for the run order (default: random; printed)
  --engine claude     claude, codex or orcacode (default: claude)
  --model <id>        Model for the agent (default: the CLI default)
  --turn-timeout <s>  Give up on a turn after this many seconds (default: 900)
  --dry               Scripted fake engine and dream model: free, checks the plumbing and the arms
  --claude-auto-memory  Leave Claude Code's own auto memory on (off by default, see README)
  --list              List the scenarios and exit

Without --dry this drives the real engine and spends tokens.

Scenarios: ${SCENARIOS.map(s => `${s.id} (${s.kind})`).join(', ')}`;

function usage(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    scenarios: { type: 'string', default: 'all' },
    arms: { type: 'string' },
    samples: { type: 'string', default: '1' },
    'max-cost': { type: 'string', default: '5' },
    seed: { type: 'string' },
    engine: { type: 'string', default: 'claude' },
    model: { type: 'string' },
    'turn-timeout': { type: 'string', default: '900' },
    dry: { type: 'boolean', default: false },
    'claude-auto-memory': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.list) {
  for (const s of SCENARIOS) console.log(`${s.id.padEnd(19)} ${s.kind.padEnd(9)} ${s.lessons.map(l => l.text).join(' | ')}`);
  process.exit(0);
}

const engine = values.engine;
if (engine !== 'claude' && engine !== 'codex' && engine !== 'orcacode') usage(`Unknown engine "${engine}".`);
const number = (name: string, raw: string, min: number) => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) usage(`--${name} takes a number of at least ${min}.`);
  return n;
};
const turnTimeout = number('turn-timeout', values['turn-timeout'], 1);
const samples = Math.floor(number('samples', values.samples, 1));
const maxCost = number('max-cost', values['max-cost'], 0);
const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Math.floor(number('seed', values.seed, 0));

const wanted = values.scenarios.split(',').map(s => s.trim()).filter(Boolean);
const scenarios = SCENARIOS.filter(s => wanted.includes('all') || wanted.includes(s.id) || wanted.includes(s.kind));
const unknown = wanted.filter(w => !['all', 'hard', 'explicit'].includes(w) && !SCENARIOS.some(s => s.id === w));
if (unknown.length) usage(`Unknown scenario: ${unknown.join(', ')}.`);
const arms = values.arms ? values.arms.split(',').map(a => a.trim()) as Arm[] : ALL_ARMS;
const badArms = arms.filter(a => !ALL_ARMS.includes(a));
if (badArms.length) usage(`Unknown arm: ${badArms.join(', ')}.`);

// A scenario that cannot work is a bug in the scenario, not a result.
for (const s of scenarios) {
  if (s.session1.length < 3) usage(`${s.id}: session 1 needs at least 3 messages so the real dream gate applies.`);
  for (const l of s.lessons) if (!l.knows.test(l.text)) usage(`${s.id}: lesson ${l.id}'s text does not match its own pattern.`);
}

const dry = values.dry;
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(OUT_ROOT, ts);
fs.mkdirSync(outDir, { recursive: true });
const jsonFile = path.join(OUT_ROOT, `${ts}.json`);
const jsonlFile = path.join(OUT_ROOT, `${ts}.jsonl`);

// Before any server module loads: config.ts reads both when it is imported. The agents' comms tools
// (remember, forget, ...) call back on PORT, so it must be this run's endpoint and never the app's.
const comms = await startCommsEndpoint();
process.env.PORT = String(comms.port);
process.env.AGENTSCODE_HOME = path.join(outDir, 'home');
// Claude Code keeps its own per-project memory, which would carry lessons in every arm and write into
// ~/.claude/projects. Off by default, so the eval measures AgentsCode memory (remember + dreams) alone.
const claudeAutoMemory = values['claude-auto-memory'];
if (!claudeAutoMemory) process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
const { runArm } = await import('./harness.ts');
type Manager = import('../../server/manager.ts').AgentManager;

// ---- the plan: blocks of (scenario, sample), shuffled, each running its arms in shuffled order ----

/** mulberry32: a small seeded PRNG, so a run order can be repeated with --seed. */
function prng(start: number): () => number {
  let a = start >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(seed);
function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const blocks = shuffle(scenarios.flatMap(scenario => Array.from({ length: samples }, (_, i) => ({ scenario, sample: i + 1 }))));
const plan = blocks.flatMap(block => shuffle(arms).map(arm => ({ ...block, arm })));

const mode = dry ? 'dry run, fake engine'
  : `${engine}${values.model ? ` ${values.model}` : ''}, real engine${engine === 'claude' ? `, Claude Code auto memory ${claudeAutoMemory ? 'on' : 'off'}` : ''}`;
console.log(`Dreaming eval: ${scenarios.length} scenario(s) x ${arms.length} arm(s) x ${samples} sample(s) = ${plan.length} runs (${mode})`);
console.log(`Seed ${seed}; cost cap $${maxCost}${dry ? ' (dry runs cost nothing)' : ''}`);
console.log(`Work dirs: ${outDir}/  Results: ${jsonFile} (rewritten after each arm), ${jsonlFile}`);
if (!dry) console.log('This drives the real engine and spends tokens.');

// ---- run, saving after every arm ------------------------------------------------------------------

const results: ArmResult[] = [];
let current: Manager | null = null;
let interrupted: string | null = null;
const started = Date.now();
const spent = () => results.reduce((sum, r) => sum + r.cost.sessionsUsd + r.cost.dreamUsd, 0);

function save(complete: boolean): void {
  const body = {
    ts, engine, model: values.model ?? null, dry, claudeAutoMemory, seed, samples, maxCost, arms,
    scenarios: scenarios.map(s => s.id), complete, interrupted, durationMs: Date.now() - started,
    summary: summarize(), results,
  };
  fs.writeFileSync(jsonFile, `${JSON.stringify(body, null, 2)}\n`);
}

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  if (interrupted) return;
  interrupted = signal;
  console.log(`\n${signal}: shutting the running agent down and saving what finished.`);
  try {
    await current?.shutdown();
  } catch { /* already closing */ }
  save(false);
  await comms.close();
  console.log(`Saved ${results.length} run(s) to ${jsonFile}`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGTERM', signal => void onSignal(signal));
process.on('SIGINT', signal => void onSignal(signal));

let stoppedAt: string | null = null;
for (const [i, unit] of plan.entries()) {
  if (stoppedAt) break;
  console.log(`[${i + 1}/${plan.length}] ${unit.scenario.id} [${unit.arm}] sample ${unit.sample}`);
  const result = await runArm(unit.scenario, unit.arm, unit.sample, {
    engine, dry, model: values.model, turnTimeoutMs: turnTimeout * 1000, outDir, comms,
    budget: { cap: maxCost, spent },
    onManager: manager => { current = manager; },
    log: line => console.log(line),
  });
  const verdict = result.status === 'scored' ? (result.pass ? 'PASS' : 'FAIL') : result.status.toUpperCase();
  console.log(`  -> ${verdict}: ${result.detail}`);
  results.push(result);
  fs.appendFileSync(jsonlFile, `${JSON.stringify(result)}\n`);
  save(false);
  if (result.status === 'stopped') stoppedAt = result.detail;
}
await comms.close();

// ---- report ---------------------------------------------------------------------------------------

interface ArmSummary {
  runs: number;
  scored: number;
  passed: number;
  inconclusive: number;
  errors: number;
  stopped: number;
  rate: number | null;
  /** Lessons in memory at session 2, by writer, over all lessons in the arm's runs; rewritten: the agent's entry, updated by a dream. */
  lessons: { total: number; byAgent: number; byDream: number; byEither: number; rewritten: number };
  sessionsUsd: number;
  dreamUsd: number;
}

function summarizeArm(rows: ArmResult[]): ArmSummary {
  const scored = rows.filter(r => r.status === 'scored');
  const passed = scored.filter(r => r.pass).length;
  const lessons = rows.filter(r => r.status === 'scored' || r.status === 'inconclusive').flatMap(r => r.lessons);
  return {
    runs: rows.length,
    scored: scored.length,
    passed,
    inconclusive: rows.filter(r => r.status === 'inconclusive').length,
    errors: rows.filter(r => r.status === 'error').length,
    stopped: rows.filter(r => r.status === 'stopped').length,
    rate: scored.length ? passed / scored.length : null,
    lessons: {
      total: lessons.length,
      byAgent: lessons.filter(l => l.agent).length,
      byDream: lessons.filter(l => l.dream).length,
      byEither: lessons.filter(l => l.agent || l.dream).length,
      rewritten: lessons.filter(l => l.rewritten).length,
    },
    sessionsUsd: rows.reduce((sum, r) => sum + r.cost.sessionsUsd, 0),
    dreamUsd: rows.reduce((sum, r) => sum + r.cost.dreamUsd, 0),
  };
}

function summarize() {
  const by = (filter: (r: ArmResult) => boolean) =>
    Object.fromEntries(arms.map(arm => [arm, summarizeArm(results.filter(r => r.arm === arm && filter(r)))])) as Record<Arm, ArmSummary>;
  const dreams = results.flatMap(r => r.dream ? [r.dream] : []);
  const reasons: Record<string, number> = {};
  for (const d of dreams) for (const op of d.ops) if (op.result !== 'applied') reasons[op.reason ?? 'no reason'] = (reasons[op.reason ?? 'no reason'] ?? 0) + 1;
  const diff = (s: Record<Arm, ArmSummary>, a: Arm, b: Arm) => s[a]?.rate != null && s[b]?.rate != null ? s[a].rate! - s[b].rate! : null;
  const all = by(() => true);
  const hard = by(r => r.kind === 'hard');
  const explicit = by(r => r.kind === 'explicit');
  return {
    arms: all,
    hard,
    explicit,
    /** on minus off: what dreaming adds to today's product (rate points). */
    dreamingAdds: { all: diff(all, 'on', 'off'), hard: diff(hard, 'on', 'off'), explicit: diff(explicit, 'on', 'off') },
    /** Scenarios whose "none" arm passed: solvable without memory, so they cannot show a memory effect. */
    tooEasy: [...new Set(results.filter(r => r.arm === 'none' && r.status === 'scored' && r.pass).map(r => r.scenario))],
    dreams: {
      ran: results.filter(r => r.gate === 'ran').length,
      skippedByGate: results.filter(r => r.gate === 'skipped' && r.status !== 'error' && r.status !== 'stopped').length,
      statuses: dreams.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {}),
      opsApplied: dreams.reduce((sum, d) => sum + d.ops.filter(op => op.result === 'applied').length, 0),
      opsRejected: dreams.reduce((sum, d) => sum + d.ops.filter(op => op.result !== 'applied').length, 0),
      rejectedReasons: reasons,
      costUsd: dreams.reduce((sum, d) => sum + (d.metrics?.costUsd ?? 0), 0),
      tokens: dreams.reduce((sum, d) => sum + (d.metrics?.tokens ?? 0), 0),
      durationMs: dreams.reduce((sum, d) => sum + (d.metrics?.durationMs ?? 0), 0),
      extraDreams: results.reduce((sum, r) => sum + r.extraDreams, 0),
    },
    cost: { totalUsd: spent(), sessionsUsd: results.reduce((s, r) => s + r.cost.sessionsUsd, 0), dreamUsd: results.reduce((s, r) => s + r.cost.dreamUsd, 0) },
    stoppedAt,
  };
}

const summary = summarize();
save(true);

const usd = (n: number) => `$${n.toFixed(4)}`;
const pct = (r: number | null) => r === null ? 'n/a' : `${Math.round(r * 100)}%`;
const pts = (d: number | null) => d === null ? 'n/a' : `${d >= 0 ? '+' : ''}${Math.round(d * 100)} pts`;
const cell = (rows: ArmResult[]) => {
  if (!rows.length) return '-';
  if (rows.length === 1) {
    const r = rows[0];
    return r.status === 'scored' ? (r.pass ? 'PASS' : 'FAIL') : r.status === 'inconclusive' ? 'N/A' : r.status === 'error' ? 'ERROR' : 'STOP';
  }
  const scored = rows.filter(r => r.status === 'scored');
  const other = rows.length - scored.length;
  return `${scored.filter(r => r.pass).length}/${scored.length}${other ? ` (+${other})` : ''}`;
};
/** Who held the lessons at session 2: A (agent's remember; A* if a dream then rewrote it), D (dream), - (nobody); per lesson. */
const holders = (rows: ArmResult[]) => {
  if (!rows.length) return '-';
  return rows.map(r => r.status === 'error' || r.status === 'stopped' ? '?' : r.lessons.map(l => (l.agent ? (l.rewritten ? 'A*' : 'A') : '') + (l.dream ? 'D' : '') || '-').join('')).join(',');
};

const header = ['scenario', 'kind', ...arms, `memory (${arms.join('/')})`, 'dreams (dream-only/on)'];
const table = scenarios.map(s => {
  const rows = (arm: Arm) => results.filter(r => r.scenario === s.id && r.arm === arm);
  const dreamCell = (arm: Arm) => rows(arm).map(r => r.dream ? `${r.dream.status} ${r.dream.ops.filter(o => o.result === 'applied').length}/${r.dream.ops.length}` : r.gate === 'skipped' ? 'gate skipped' : '-').join(',') || '-';
  return [s.id, s.kind, ...arms.map(arm => cell(rows(arm))), arms.map(arm => holders(rows(arm))).join(' / '), `${arms.includes('dream-only') ? dreamCell('dream-only') : '-'} / ${arms.includes('on') ? dreamCell('on') : '-'}`];
});
const widths = header.map((h, i) => Math.max(h.length, ...table.map(r => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();

console.log('');
console.log(line(header));
console.log(line(widths.map(w => '-'.repeat(w))));
for (const row of table) console.log(line(row));
console.log('');
const rateLine = (label: string, s: Record<Arm, ArmSummary>) =>
  `${label.padEnd(21)}${arms.map(arm => `${arm}: ${s[arm].passed}/${s[arm].scored} (${pct(s[arm].rate)})`).join('   ')}`;
console.log(rateLine('Lesson-follow rate', summary.arms));
console.log(rateLine('  hard scenarios', summary.hard));
console.log(rateLine('  explicit', summary.explicit));
console.log(`Dreaming adds (on - off): all ${pts(summary.dreamingAdds.all)}, hard ${pts(summary.dreamingAdds.hard)}, explicit ${pts(summary.dreamingAdds.explicit)}`);
console.log(`Lessons in memory at session 2 (agent / dream): ${arms.map(arm => `${arm} ${summary.arms[arm].lessons.byAgent}/${summary.arms[arm].lessons.byDream} of ${summary.arms[arm].lessons.total}${summary.arms[arm].lessons.rewritten ? ` (${summary.arms[arm].lessons.rewritten} of the agent's rewritten by a dream)` : ''}`).join(', ')}`);
if (arms.includes('none')) console.log(`Too easy (passed with memory emptied): ${summary.tooEasy.join(', ') || 'none'}`);
const d = summary.dreams;
console.log(`Dreams: ${d.ran} ran, ${d.skippedByGate} skipped by the gate; ${Object.entries(d.statuses).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}; ops applied ${d.opsApplied}, rejected ${d.opsRejected}${d.opsRejected ? ` (${Object.entries(d.rejectedReasons).map(([k, v]) => `${v}x ${k}`).join('; ')})` : ''}`);
console.log(`Dream cost: ${usd(d.costUsd)}, ${d.tokens} tokens, ${(d.durationMs / 1000).toFixed(1)}s`);
console.log(`Session cost: ${arms.map(arm => `${arm} ${usd(summary.arms[arm].sessionsUsd)}`).join(', ')}; total ${usd(summary.cost.totalUsd)} in ${((Date.now() - started) / 60000).toFixed(1)} min`);
if (d.extraDreams) console.log(`Warning: ${d.extraDreams} unexpected extra dream(s)`);
if (stoppedAt) console.log(`Stopped at the cost cap: ${stoppedAt}. Runs not started: ${plan.length - results.length}.`);

const problems = results.filter(r => r.status === 'error' || r.status === 'stopped' || r.status === 'inconclusive' || (r.status === 'scored' && !r.pass && r.arm !== 'none' && r.arm !== 'off'));
if (problems.length) {
  console.log('\nMisses with dreaming, inconclusive runs and errors:');
  for (const r of problems) {
    const dream = r.dream ? ` [dream ${r.dream.status}: ${(r.dream.error || r.dream.diary.split('\n')[0] || '').trim()}${r.dream.ops.filter(o => o.result !== 'applied').map(o => `; rejected: ${o.reason}`).join('')}]` : r.gate === 'skipped' ? ' [the gate skipped the dream]' : '';
    console.log(`  ${r.scenario}/${r.arm}/s${r.sample}: ${r.detail}${dream}`);
  }
}
console.log(`\nResult: ${jsonFile}`);

// ---- dry runs: a check of the plumbing and of what each arm does --------------------------------
// The fake agent saves a lesson itself only in explicit scenarios (fakeRemembers), and the fake dream
// learns every lesson it can cite. So: off passes exactly when the agent remembers; none never passes;
// dream-only and on always pass; and memory at session 2 holds each lesson from the expected writer.
if (dry) {
  const failures: string[] = [];
  for (const r of results) {
    const s = scenarios.find(x => x.id === r.scenario) as Scenario;
    const where = `${r.scenario}/${r.arm}`;
    const expectPass = r.arm === 'none' ? false : r.arm === 'off' ? s.fakeRemembers : true;
    if (r.status !== 'scored') { failures.push(`${where}: ${r.status} (${r.detail})`); continue; }
    if (r.pass !== expectPass) failures.push(`${where}: expected ${expectPass ? 'PASS' : 'FAIL'}, got ${r.pass ? 'PASS' : 'FAIL'} (${r.detail})`);
    const dreaming = r.arm === 'on' || r.arm === 'dream-only';
    if (dreaming && r.gate !== 'ran') failures.push(`${where}: the session-end dream did not run (gate ${r.gate})`);
    if (!dreaming && r.dream) failures.push(`${where}: a dream ran with dreaming off`);
    if (r.extraDreams) failures.push(`${where}: ${r.extraDreams} extra dream(s)`);
    for (const l of r.lessons) {
      const want = r.arm === 'none' ? { agent: false, dream: false }
        : r.arm === 'off' ? { agent: s.fakeRemembers, dream: false }
        : r.arm === 'dream-only' ? { agent: false, dream: true }
        : { agent: s.fakeRemembers, dream: !s.fakeRemembers };
      if (l.agent !== want.agent || l.dream !== want.dream) failures.push(`${where}: lesson ${l.id} held by agent=${l.agent} dream=${l.dream}, expected agent=${want.agent} dream=${want.dream}`);
    }
  }
  if (results.length !== plan.length) failures.push(`${plan.length - results.length} run(s) did not happen`);
  if (failures.length) {
    console.log(`Plumbing check: FAILED\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Plumbing check: OK');
  process.exit(0);
}
process.exit(results.some(r => r.status === 'error') ? 1 : 0);
