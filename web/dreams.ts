/**
 * Dreaming, as the app shows it: what a dream did, whether it can be undone, the soul diff, and
 * the numbers that say whether dreaming helps. Pure, so it is tested directly.
 */

/** Below this many dreams the numbers say little; the stats panel says so instead. */
export const MIN_DREAMS = 3;
/** Below this many corrections a repeat-correction rate is noise. */
export const MIN_CORRECTIONS = 5;
/** Below this many sessions on either side, "better" or "worse" than dreaming off would be one session's luck. */
export const MIN_SESSIONS = 3;

// ---- one dream ------------------------------------------------------------------

export interface OpLike {
  op: string;
  ids?: string[];
  text?: string;
  result: 'applied' | 'rejected';
}

/** What a dream changed in memory: entries added, removed, and updated or merged. */
export function dreamCounts(ops: readonly OpLike[]): { added: number; removed: number; updated: number } {
  const counts = { added: 0, removed: 0, updated: 0 };
  for (const op of ops) {
    if (op.result !== 'applied') continue;
    if (op.op === 'add') counts.added += 1;
    else if (op.op === 'remove') counts.removed += 1;
    else counts.updated += 1;
  }
  return counts;
}

/** "+2 -1 ~1", leaving out what did not happen; "no changes" when nothing did. */
export function countsText({ added, removed, updated }: { added: number; removed: number; updated: number }): string {
  const parts = [added ? `+${added}` : '', removed ? `-${removed}` : '', updated ? `~${updated}` : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : 'no changes';
}

const OP_VERBS: Record<string, string> = { add: 'Add', update: 'Update', merge: 'Merge', remove: 'Remove' };

/** One op as a line: "Add: ...", "Merge 3f2a9c1d, b71e04aa: ...", "Remove 3f2a9c1d". */
export function opText(op: OpLike): string {
  const verb = OP_VERBS[op.op] ?? op.op;
  const ids = op.op === 'add' || !op.ids?.length ? '' : ` ${op.ids.join(', ')}`;
  return op.text ? `${verb}${ids}: ${op.text}` : `${verb}${ids}`;
}

export const REASON_LABELS: Record<string, string> = {
  'session-end': 'After a session',
  idle: 'After going idle',
  manual: 'Dream now',
};

export const STATUS_LABELS: Record<string, string> = {
  applied: 'Applied',
  'rolled-back': 'Rolled back',
  nothing: 'Nothing to change',
  failed: 'Failed',
};

/** What a dream learned about the user, for user.md (ProfileOp). */
export interface ProfileOpLike {
  text: string;
  result: 'applied' | 'proposed' | 'rejected';
  reason?: string;
}

type DreamLike = { id: string; status: string; undoneAt?: number; ops: readonly OpLike[]; profile?: readonly ProfileOpLike[] };

/** A dream whose memory changes stand: applied, with an applied op, and not undone (as the server's changedMemory). */
export function changedMemory(dream: DreamLike): boolean {
  return dream.status === 'applied' && !dream.undoneAt && dream.ops.some(op => op.result === 'applied');
}

/** A dream that added to user.md or proposed something for it, and was not undone (as the server's changedProfile). */
export function changedProfile(dream: DreamLike): boolean {
  return !dream.undoneAt && Boolean(dream.profile?.some(op => op.result === 'applied' || op.result === 'proposed'));
}

/** "learned 1 about you, 1 to review", or '' when the dream learned nothing about the user. */
export function profileCountsText(profile: readonly ProfileOpLike[] = []): string {
  const learned = profile.filter(op => op.result === 'applied').length;
  const proposed = profile.filter(op => op.result === 'proposed').length;
  return [learned ? `learned ${learned} about you` : '', proposed ? `${proposed} to review` : ''].filter(Boolean).join(', ');
}

/**
 * A dream can be undone when it changed memory and no later dream did (later dreams that changed
 * nothing, failed, were rolled back or were undone do not stand in the way), or when it only changed
 * the user profile, whose entries it removes by id. Returns why not otherwise. `dreams` is newest
 * first. The server also refuses if memory changed since.
 */
export function undoState(dreams: readonly DreamLike[], dreamId: string): { can: true } | { can: false; why: string } {
  const index = dreams.findIndex(d => d.id === dreamId);
  const dream = dreams[index];
  if (!dream) return { can: false, why: 'This dream is gone.' };
  if (dream.undoneAt) return { can: false, why: 'Already undone.' };
  const memory = changedMemory(dream);
  if (!memory && !changedProfile(dream)) return { can: false, why: 'It changed nothing.' };
  if (memory && dreams.slice(0, index).some(changedMemory)) return { can: false, why: 'A later dream changed memory since.' };
  return { can: true };
}

// ---- the soul proposal ------------------------------------------------------------

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** A line diff of the current soul against a proposed one, by longest common subsequence. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.length ? before.replace(/\n$/, '').split('\n') : [];
  const b = after.length ? after.replace(/\n$/, '').split('\n') : [];
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] });
  while (j < b.length) out.push({ kind: 'add', text: b[j++] });
  return out;
}

// ---- the numbers ------------------------------------------------------------------

/** n / d, or null when there is nothing to divide by. */
export function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/** A ratio as a percentage. Null (nothing to divide by yet), NaN or Infinity is "n/a", never 0%. */
export function percentText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a';
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

/** A per-session average, to one decimal: "1.4". */
export function averageText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? (Math.round(value * 10) / 10).toString() : 'n/a';
}

export function costText(usd: number | null | undefined): string {
  if (!usd) return '$0';
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/**
 * Which way a per-session series is heading: the mean of its last third against its first third.
 * Null below three sessions. Within 10% of each other (or 0.1 apart) is flat.
 */
export function trend(values: readonly number[]): 'falling' | 'rising' | 'flat' | null {
  if (values.length < 3) return null;
  const third = Math.max(1, Math.floor(values.length / 3));
  const first = mean(values.slice(0, third))!;
  const last = mean(values.slice(-third))!;
  const tolerance = Math.max(0.1, Math.abs(first) * 0.1);
  if (Math.abs(last - first) <= tolerance) return 'flat';
  return last < first ? 'falling' : 'rising';
}

/**
 * How an agent's number compares with the baseline (agents with dreaming off). Rates within two
 * points of each other are the same; null when either side has no number. Check `comparable` first.
 */
export function compare(value: number | null, baseline: number | null, lowerIsBetter: boolean, tolerance = 0.02): 'better' | 'worse' | 'same' | null {
  if (value === null || baseline === null) return null;
  if (Math.abs(value - baseline) <= tolerance) return 'same';
  return (value < baseline) === lowerIsBetter ? 'better' : 'worse';
}

/** Points of a sparkline in a width by height box, oldest on the left, with `pad` kept clear for the end dot. */
export function sparkPoints(values: readonly number[], width: number, height: number, pad = 2): { x: number; y: number }[] {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values.map((v, i) => ({
    x: values.length > 1 ? pad + i * step : width / 2,
    // A flat series sits in the middle rather than on an edge.
    y: span ? pad + (1 - (v - min) / span) * (height - pad * 2) : height / 2,
  }));
}

export function sparkPath(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

/** The parts of the server's DreamStats these helpers read. */
export interface StatsLike {
  dreams: number;
  /** Corrections the dreams judged; repeatCorrectionRate is out of these. */
  corrections: number;
  sessions: number;
  rejectedByReason: Record<string, number>;
}

/**
 * Whether the numbers mean anything yet, and if not, the plain reason to show instead. Too few
 * dreams says nothing about dreaming; too few corrections says nothing about repeats.
 */
export function readiness(stats: StatsLike | undefined): { dreams: boolean; corrections: boolean; why?: string } {
  if (!stats || stats.dreams < MIN_DREAMS) {
    const n = stats?.dreams ?? 0;
    return { dreams: false, corrections: false, why: `${n === 0 ? 'No dreams yet' : `Only ${n} ${n === 1 ? 'dream' : 'dreams'} so far`}. The numbers start to mean something after ${MIN_DREAMS}.` };
  }
  if (stats.corrections < MIN_CORRECTIONS) {
    const n = stats.corrections;
    return { dreams: true, corrections: false, why: `Only ${n} ${n === 1 ? 'correction' : 'corrections'} so far, too few to tell whether it repeats mistakes.` };
  }
  return { dreams: true, corrections: true };
}

/**
 * Whether an agent's per-session numbers can be called better or worse than dreaming off: both sides
 * need at least MIN_SESSIONS sessions. Otherwise the plain reason why not.
 */
export function comparable(mine: Pick<StatsLike, 'sessions'> | undefined, off: Pick<StatsLike, 'sessions'> | undefined): { can: true } | { can: false; why: string } {
  const a = mine?.sessions ?? 0;
  const b = off?.sessions ?? 0;
  if (a >= MIN_SESSIONS && b >= MIN_SESSIONS) return { can: true };
  return { can: false, why: `Better or worse needs ${MIN_SESSIONS} sessions on each side (${a} with dreaming, ${b} with it off).` };
}

/** Why there is no baseline to compare against, when the agents with dreaming off have no sessions. */
export function baselineMissing(off: Pick<StatsLike, 'sessions'> | undefined): string | undefined {
  if (!off || off.sessions === 0) {
    return 'No agent with dreaming off has a session yet, so there is nothing to compare against. Turn dreaming off for one agent to get a baseline.';
  }
  return undefined;
}

/** Refused changes by reason, most common first: "3 no user evidence, 1 unknown entry". */
export function rejectedText(byReason: Record<string, number>): string {
  return Object.entries(byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, n]) => `${n} ${reason}`)
    .join(', ');
}
