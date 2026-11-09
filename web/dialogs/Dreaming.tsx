import { useEffect, useState, type ReactNode } from 'react';
import type { Agent, DreamOp, DreamRecord, DreamStats, ProfileOp, SoulProposal } from '../../shared/types.ts';
import { api } from '../api.ts';
import {
  averageText, baselineMissing, comparable, compare, costText, countsText, dreamCounts, lineDiff, opText, percentText,
  profileCountsText, readiness, REASON_LABELS, rejectedText, STATUS_LABELS, trend, undoState,
} from '../dreams.ts';
import { duration } from '../format.ts';
import { memoryDate } from '../memory.ts';
import { attempt, loadDreams, loadDreamStats, useApp } from '../store.ts';
import { PRIMARY } from '../ui/common.tsx';
import { Sparkline } from '../ui/Sparkline.tsx';
import { Check, RotateCcw, X } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row, Toggle } from '../mono/settings.tsx';

/** How many dreams the log shows before "Show more". */
const LOG_SHOWN = 5;

function when(at: number): string {
  return `${memoryDate(at)} ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Dreaming in the agent settings: the switch, Dream now, the numbers that say whether it helps,
 * and the log of every dream with what it changed and why.
 */
export function DreamingSection({ agent }: { agent: Agent }) {
  const state = useApp(s => s.dreams[agent.id]);
  const team = useApp(s => s.dreamStats);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadDreams(agent.id);
    void loadDreamStats();
  }, [agent.id]);

  const working = agent.status === 'working' || agent.status === 'waiting';
  const toggle = async (on: boolean) => {
    setBusy(true);
    await attempt(() => api.updateAgent(agent.id, { dreaming: on }));
    setBusy(false);
  };
  const dreamNow = async () => {
    setBusy(true);
    await attempt(() => api.dreamNow(agent.id));
    setBusy(false);
  };

  return (
    <>
      <Group title="Dreaming" description={`After a session, ${agent.name} reads back over it and tidies its memory: what you corrected, what failed, what you prefer. Memory changes apply at once and can be undone; soul changes wait for you.`}>
        <Row label="Dream after sessions" description={agent.dreaming ? 'On. It dreams when a session ends or it goes idle, at most once an hour.' : 'Dreams are off. Past dreams stay below.'}>
          <Toggle label="Dream after sessions" on={agent.dreaming} disabled={busy} onChange={on => void toggle(on)} />
        </Row>
        <Row
          label="Dream now"
          description={!agent.dreaming ? 'Dreams are off. Turn dreaming on to run one.' : working ? `Wait for ${agent.name} to finish its turn.` : 'Read back over everything since the last dream, now.'}
        >
          <SecondaryButton disabled={busy || !agent.dreaming || working} onClick={() => void dreamNow()}>Dream now</SecondaryButton>
        </Row>
      </Group>
      <DreamStatsPanel stats={state?.stats} off={team?.dreamingOff} name={agent.name} loading={!state} />
      <DreamsLog agent={agent} dreams={state?.dreams} />
    </>
  );
}

// ---- the numbers ------------------------------------------------------------------

const TREND_WORDS = { falling: 'falling', rising: 'rising', flat: 'flat' } as const;

/**
 * Whether dreaming helps, after the dataviz figure contract: the primary metric first in plain
 * words, then per-session trends beside the same numbers for agents with dreaming off, then the
 * quality of the dreams themselves. Too little data says so instead of showing numbers.
 */
export function DreamStatsPanel({ stats, off, name, loading }: { stats: DreamStats | undefined; off: DreamStats | undefined; name: string; loading?: boolean }) {
  const ready = readiness(stats);
  const missing = baselineMissing(off);
  // "Better" or "worse" only with enough sessions on both sides; the averages still show.
  const fair = comparable(stats, off);
  return (
    <Group title="Is dreaming helping?">
      <div data-dream-stats className="px-4 py-3.5">
        {loading ? <p className="text-[12px] text-content/45">Loading…</p> : !ready.dreams || !stats ? (
          <div data-dream-stats-empty>
            <p className="text-[13px] text-content/75">Not enough to go on yet.</p>
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">{ready.why} Until then, any rate here would mostly be chance.</p>
          </div>
        ) : (
          <>
            {/* The primary outcome, labelled in plain words. */}
            <div>
              <p className="text-[12px] font-medium text-content/50">Repeated corrections</p>
              {ready.corrections ? (
                <>
                  <p className="mt-1 text-[13px] leading-relaxed text-content/80">
                    <span className="mr-1.5 text-xl font-semibold tabular-nums text-content">{percentText(stats.repeatCorrectionRate)}</span>
                    of your corrections were about something it had already learned (lower is better)
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-content/45">
                    {stats.repeatCorrections} of {stats.corrections} corrections. Only a dream can tell a repeat, so agents with dreaming off have no number here; compare their corrections per session below.
                  </p>
                </>
              ) : (
                <p className="mt-1 text-[12px] leading-relaxed text-content/45">{ready.why}</p>
              )}
            </div>

            {/* Per session, this agent against agents with dreaming off. */}
            <table className="mt-4 w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-content/45">
                  <th className="pb-1.5 font-normal">Per session</th>
                  <th className="pb-1.5 font-normal">{name}</th>
                  <th className="pb-1.5 text-right font-normal">Dreaming off</th>
                </tr>
              </thead>
              <tbody>
                <SessionRow label="Corrections" unit="corrections" values={stats.correctionsPerSession} average={stats.avgCorrectionsPerSession} baseline={missing ? undefined : off?.avgCorrectionsPerSession ?? null} judge={fair.can} />
                <SessionRow label="Failed or stopped turns" unit="failed turns" values={stats.failedPerSession} average={stats.avgFailedPerSession} baseline={missing ? undefined : off?.avgFailedPerSession ?? null} judge={fair.can} />
              </tbody>
            </table>
            <p className="mt-1.5 text-[11px] leading-relaxed text-content/40">
              {missing ?? `Lower is better. ${stats.sessions} ${stats.sessions === 1 ? 'session' : 'sessions'} here since its first dream, ${off?.sessions ?? 0} across agents with dreaming off.${fair.can ? '' : ` ${fair.why}`}`}
            </p>

            {/* How good the dreams themselves are. */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              <Tile label="Dream entries you reverted (lower is better)" value={percentText(stats.revertRate)} note={stats.dreamEntries ? `${stats.dreamEntriesReverted} of ${stats.dreamEntries}` : 'none yet'} />
              <Tile label="Soul changes accepted" value={percentText(stats.soulAcceptanceRate)} note={stats.soulAccepted + stats.soulRejected ? `${stats.soulAccepted} of ${stats.soulAccepted + stats.soulRejected}` : 'none proposed'} />
              <Tile label="Dreaming cost" value={costText(stats.costUsd)} note={`${stats.dreams} ${stats.dreams === 1 ? 'dream' : 'dreams'}, ${stats.tokens.toLocaleString()} tokens`} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-content/40">
              {stats.opsApplied} {stats.opsApplied === 1 ? 'change' : 'changes'} applied, {stats.opsRejected} refused{stats.opsRejected ? ` (${rejectedText(stats.rejectedByReason)})` : ''}, {stats.rollbacks} {stats.rollbacks === 1 ? 'dream' : 'dreams'} rolled back{stats.opsRolledBack ? ` (${stats.opsRolledBack} ${stats.opsRolledBack === 1 ? 'change' : 'changes'} put back)` : ''}.
            </p>
          </>
        )}
      </div>
    </Group>
  );
}

function VersusWord({ versus }: { versus: 'better' | 'worse' | 'same' | null }) {
  if (!versus) return null;
  // The word carries the meaning; the color only repeats it.
  if (versus === 'same') return <span className="text-content/60">about the same</span>;
  return <span className={versus === 'better' ? 'text-diff-add-fg' : 'text-diff-del-fg'}>{versus === 'better' ? 'better' : 'worse'}</span>;
}

function SessionRow({ label, unit, values, average, baseline, judge }: { label: string; unit: string; values: number[]; average: number | null; baseline: number | null | undefined; judge: boolean }) {
  const direction = trend(values);
  // Fewer corrections and failed turns are better; with too few sessions on either side, no verdict.
  const versus = baseline === undefined || !judge ? null : compare(average, baseline, true, 0.1);
  return (
    <tr className="border-t border-content/5">
      <td className="py-2 pr-3 text-content/70">{label}</td>
      <td className="py-2 pr-3">
        <span className="flex items-center gap-2">
          <Sparkline values={values} label={`${label} per session`} unit={unit} />
          <span className="tabular-nums text-content">{averageText(average)}</span>
          {direction ? <span className="text-content/45">{TREND_WORDS[direction]}</span> : null}
          {versus ? <span className="text-content/45">· <VersusWord versus={versus} /></span> : null}
        </span>
      </td>
      <td className="py-2 text-right tabular-nums text-content/75">{baseline === undefined ? 'n/a' : averageText(baseline)}</td>
    </tr>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-content/10 bg-content/3 px-3 py-2.5">
      <div className="text-[15px] font-semibold tabular-nums text-content">{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-content/55">{label}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-content/35">{note}</div>
    </div>
  );
}

// ---- the log ----------------------------------------------------------------------

function DreamsLog({ agent, dreams }: { agent: Agent; dreams: DreamRecord[] | undefined }) {
  const [all, setAll] = useState(false);
  const shown = all ? dreams ?? [] : (dreams ?? []).slice(0, LOG_SHOWN);
  return (
    <Group title="Dreams" description={`Every dream ${agent.name} had, newest first: why it ran, what it noticed, and each change it made or was refused.`}>
      {dreams === undefined ? <p className="px-4 py-3.5 text-[12px] text-content/45">Loading…</p>
        : !dreams.length ? (
          <div className="px-4 py-3.5">
            <p className="text-[13px] text-content/75">No dreams yet.</p>
            <p className="mt-1 text-[12px] leading-relaxed text-content/45">{agent.dreaming ? `${agent.name} dreams after a session ends, once it has done a few turns. Dream now runs one right away.` : 'Dreams are off for this agent.'}</p>
          </div>
        ) : (
          <>
            {shown.map(dream => <DreamEntry key={dream.id} agentId={agent.id} dream={dream} dreams={dreams} />)}
            {dreams.length > shown.length ? (
              <div className="px-4 py-2.5">
                <button type="button" onClick={() => setAll(true)} className="text-[12px] text-content/55 hover:text-content">Show {dreams.length - shown.length} older</button>
              </div>
            ) : null}
          </>
        )}
    </Group>
  );
}

function DreamEntry({ agentId, dream, dreams }: { agentId: string; dream: DreamRecord; dreams: DreamRecord[] }) {
  const [busy, setBusy] = useState(false);
  const undo = undoState(dreams, dream.id);
  const about = profileCountsText(dream.profile);
  const memoryCounts = countsText(dreamCounts(dream.ops));
  // A dream that only learned about the user says that, not "no changes".
  const counts = about ? (memoryCounts === 'no changes' ? about : `${memoryCounts}, ${about}`) : memoryCounts;
  const m = dream.metrics;
  const facts = [
    `${m.digestItems} ${m.digestItems === 1 ? 'thing' : 'things'} read`,
    `${m.corrections} ${m.corrections === 1 ? 'correction' : 'corrections'}${m.corrections ? ` (${m.repeatCorrections} repeated)` : ''}`,
    `${m.failedTurns} failed of ${m.turns} ${m.turns === 1 ? 'turn' : 'turns'}`,
    m.tokens ? `${m.tokens.toLocaleString()} tokens` : '',
    m.costUsd ? costText(m.costUsd) : '',
    duration(m.durationMs),
  ].filter(Boolean);
  const runUndo = async () => {
    setBusy(true);
    await attempt(() => api.undoDream(agentId, dream.id));
    setBusy(false);
  };
  return (
    <div data-dream={dream.id} data-dream-status={dream.status} className="border-b border-content/5 px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-content/50">
            <span className="text-content/80">{when(dream.at)}</span>
            <span>·</span>
            <span>{REASON_LABELS[dream.reason] ?? dream.reason}</span>
            <span>·</span>
            <StatusWord status={dream.status} undone={Boolean(dream.undoneAt)} />
            {dream.status === 'applied' && !dream.undoneAt ? <><span>·</span><span className="font-mono text-content/70">{counts}</span></> : null}
          </p>
          {dream.error ? <p className="mt-1 text-[12px] text-danger">{dream.error}</p> : null}
          {dream.status === 'rolled-back' ? <p className="mt-1 text-[12px] leading-relaxed text-content/55">Its changes would have removed too much or overfilled memory, so memory was put back as it was.</p> : null}
        </div>
        {undo.can ? <SecondaryButton disabled={busy} onClick={() => void runUndo()}>Undo</SecondaryButton> : null}
      </div>
      {dream.diary ? <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-content/70">{dream.diary}</p> : null}
      {dream.ops.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {dream.ops.map((op, i) => <OpRow key={i} op={op} undone={dream.status === 'rolled-back' ? 'rolled back' : dream.undoneAt ? 'undone' : undefined} />)}
        </ul>
      ) : null}
      {dream.profile?.length ? (
        <ul data-dream-profile className="mt-2 flex flex-col gap-1">
          {dream.profile.map((op, i) => <ProfileOpRow key={i} op={op} undone={Boolean(dream.undoneAt)} />)}
        </ul>
      ) : null}
      {dream.soul ? (
        <p className="mt-2 text-[12px] text-content/55">
          Soul: {SOUL_WORDS[dream.soul.status] ?? dream.soul.status}{dream.soul.why ? <span className="text-content/40">: {dream.soul.why}</span> : null}
        </p>
      ) : null}
      <p className="mt-2 text-[11px] text-content/35">{facts.join(' · ')}</p>
    </div>
  );
}

const SOUL_WORDS: Record<string, string> = {
  pending: 'change proposed, waiting for you',
  accepted: 'change accepted',
  rejected: 'change rejected',
  invalid: 'proposal discarded as too large or unsafe',
};

function StatusWord({ status, undone }: { status: DreamRecord['status']; undone: boolean }) {
  if (undone) return <span className="text-content/70">Undone</span>;
  const tone = status === 'failed' ? 'text-danger' : status === 'rolled-back' ? 'text-warning' : 'text-content/70';
  return <span className={tone}>{STATUS_LABELS[status] ?? status}</span>;
}

/** One op: applied and kept, applied then put back (`undone` says how), or refused with its reason. */
function OpRow({ op, undone }: { op: DreamOp; undone?: string }) {
  const applied = op.result === 'applied';
  const kept = applied && !undone;
  const Icon = kept ? Check : applied ? RotateCcw : X;
  return (
    <li data-dream-op={kept ? 'applied' : applied ? 'undone' : 'rejected'} className="flex min-w-0 items-start gap-1.5 text-[12px]">
      <Icon className={`mt-[3px] size-3 shrink-0 ${kept ? 'text-content/55' : 'text-content/35'}`} strokeWidth={2} />
      <span className="min-w-0">
        <span className={kept ? 'text-content/80' : 'text-content/45 line-through decoration-content/25'}>{opText(op)}</span>
        {!applied && op.reason ? <span className="text-content/50"> Not applied: {op.reason}</span> : null}
        {applied && undone ? <span className="text-content/45"> Applied, then {undone}.</span> : null}
        {kept && op.why ? <span className="text-content/40"> ({op.why})</span> : null}
      </span>
    </li>
  );
}

/** One thing the dream learned about the user: in user.md, waiting in About you, or refused. */
function ProfileOpRow({ op, undone }: { op: ProfileOp; undone: boolean }) {
  const kept = op.result !== 'rejected' && !undone;
  const Icon = op.result === 'rejected' ? X : undone ? RotateCcw : Check;
  const label = op.result === 'proposed' ? 'About you, waiting for your approval' : 'About you';
  return (
    <li data-dream-profile-op={op.result} className="flex min-w-0 items-start gap-1.5 text-[12px]">
      <Icon className={`mt-[3px] size-3 shrink-0 ${kept ? 'text-content/55' : 'text-content/35'}`} strokeWidth={2} />
      <span className="min-w-0">
        <span className={kept ? 'text-content/80' : 'text-content/45 line-through decoration-content/25'}>{label}: {op.text}</span>
        {op.result === 'rejected' && op.reason ? <span className="text-content/50"> Not applied: {op.reason}</span> : null}
        {op.result !== 'rejected' && undone ? <span className="text-content/45"> Removed when the dream was undone.</span> : null}
      </span>
    </li>
  );
}

// ---- the soul proposal ------------------------------------------------------------

/**
 * A proposed soul.md as a line diff against soul.md as it is on disk (the server reads the file; the
 * agent's copy lags hand edits), with why, evidence, and Accept or Reject. Once soul.md changed since
 * the proposal, Accept is off: the server would refuse it rather than discard those edits.
 */
export function SoulProposalCard({ agent, proposal }: { agent: Agent; proposal: SoulProposal }) {
  const [busy, setBusy] = useState(false);
  // Read soul.md fresh when the card opens, and whenever the agent's instructions move.
  useEffect(() => {
    void loadDreams(agent.id, true);
  }, [agent.id, agent.instructions]);
  const lines = lineDiff(proposal.current ?? agent.instructions, proposal.text);
  const decide = async (action: 'accept' | 'reject') => {
    setBusy(true);
    const ok = await attempt(() => api.soulProposal(agent.id, action));
    // Refused (soul.md changed since): show the fresh diff and why.
    if (!ok) await loadDreams(agent.id, true);
    setBusy(false);
  };
  return (
    <div data-soul-proposal className="px-4 py-3.5">
      <p className="text-[13px] text-content">{agent.name} proposes a change to its soul</p>
      <p className="mt-1 text-[12px] leading-relaxed text-content/55">{proposal.why}</p>
      {proposal.evidence?.length ? <p className="mt-1 text-[11px] text-content/40">Evidence: {proposal.evidence.join(', ')}</p> : null}
      {proposal.stale ? (
        <p data-soul-stale className="mt-1.5 text-[12px] leading-relaxed text-warning">
          soul.md changed since this was proposed. Accepting it would discard those edits, so reject it, or make the change in soul.md yourself.
        </p>
      ) : null}
      <div role="table" aria-label="Soul changes" className="mt-2.5 max-h-72 overflow-auto rounded-md border border-content/10 py-1 font-mono text-[11.5px] leading-5">
        {lines.map((line, i) => (
          <div key={i} role="row" className={`flex px-2 ${line.kind === 'add' ? 'bg-diff-add-bg' : line.kind === 'del' ? 'bg-diff-del-bg' : ''}`}>
            <span aria-label={line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged'} className={`w-4 shrink-0 select-none ${line.kind === 'add' ? 'text-diff-add-fg' : line.kind === 'del' ? 'text-diff-del-fg' : 'text-content/25'}`}>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
            </span>
            <span className={`min-w-0 whitespace-pre-wrap break-words ${line.kind === 'same' ? 'text-content/55' : 'text-content'}`}>{line.text || ' '}</span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-content/35">Proposed {when(proposal.at)}</span>
        <SecondaryButton disabled={busy} onClick={() => void decide('reject')}>Reject</SecondaryButton>
        <button type="button" className={PRIMARY} disabled={busy || proposal.stale} onClick={() => void decide('accept')}>Accept</button>
      </div>
    </div>
  );
}

/** The soul proposal as its own settings group, when there is one. */
export function SoulProposalGroup({ agent }: { agent: Agent }) {
  const proposal = useApp(s => s.dreams[agent.id]?.proposal);
  if (!proposal) return null;
  return <Group title="Proposed soul change"><SoulProposalCard agent={agent} proposal={proposal} /></Group>;
}

/** The notice in the agent pane while a soul change waits for the user. */
export function SoulProposalNotice({ agent, onReview }: { agent: Agent; onReview: () => void }): ReactNode {
  const proposal = useApp(s => s.dreams[agent.id]?.proposal);
  useEffect(() => {
    void loadDreams(agent.id);
  }, [agent.id]);
  if (!proposal) return null;
  return (
    <div data-soul-notice className="mx-auto flex w-full max-w-3xl items-center gap-3 px-3 pb-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-content/10 bg-content/3 px-3 py-2 font-sans text-[12px]">
        <span className="min-w-0 flex-1 truncate text-content/75">
          {agent.name} proposes a change to its soul<span className="text-content/45">: {proposal.why}</span>
        </span>
        <button type="button" onClick={onReview} className="shrink-0 rounded px-1.5 py-0.5 text-content hover:bg-content/8">Review</button>
      </div>
    </div>
  );
}
