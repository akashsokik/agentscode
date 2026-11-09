import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { outcomeTone, outcomeWords } from '../peerText.ts';
import type { Agent, PeerMessage, WalkthroughSummary } from '../../shared/types.ts';
import { api } from '../api.ts';
import { rolePreset } from '../../shared/roles.ts';
import { cost, duration, modelLabel, relativeTime, tokenCount } from '../format.ts';
import type { GitStatus } from '../../shared/types.ts';
import { open, openToSide } from '../layout.ts';
import { memoryDate } from '../memory.ts';
import { projectLabel } from '../projects.ts';
import { loadMemory, useApp } from '../store.ts';
import { AgentStatus } from '../ui/AgentStatus.tsx';
import { StatusLabel } from '../ui/common.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { useNow } from '../ui/useNow.ts';
import { ArrowLeft, ArrowUp, Folder, GitBranch, Route } from '../mono/icons.tsx';
import { whereabouts, type Whereabouts } from '../whereabouts.ts';

const HANDOFFS = 4;
const PEERS = 4;
const MEMORIES = 3;


/**
 * The focused agent at a glance: what it is doing and for how long, how full its context is, the
 * work it handed off or took on, who it works with, and what it has learned. Totals go to one line
 * at the bottom, since they say little about what the agent is up to.
 */
export function AgentOverview({ agent, git }: { agent: Agent; git: GitStatus | null | undefined }) {
  const models = useApp(s => s.snapshot?.models[agent.engine]);
  const projects = useApp(s => s.snapshot?.projects);
  const pending = useApp(s => Boolean(s.snapshot?.approvals.some(a => a.agentId === agent.id)));
  const messages = useApp(s => s.snapshot?.messages);
  const memory = useApp(s => s.memory[agent.id]);
  const now = useNow(agent.status === 'working' ? 1000 : 30_000);
  useEffect(() => { void loadMemory(agent.id); }, [agent.id]);

  const mine = useMemo(() => (messages ?? []).filter(m => m.fromAgentId === agent.id || m.toAgentId === agent.id), [messages, agent.id]);
  const handoffs = useMemo(() => {
    const reports = new Map<string, PeerMessage>();
    for (const m of mine) if (m.report && m.replyTo) reports.set(m.replyTo, m);
    return mine.filter(m => m.delegation).slice(-HANDOFFS).reverse().map(m => ({ message: m, report: reports.get(m.id)?.report }));
  }, [mine]);
  const peers = useMemo(() => {
    const byPeer = new Map<string, { id: string; name: string; count: number; last: number; conversationId: string }>();
    for (const m of mine) {
      const outgoing = m.fromAgentId === agent.id;
      const id = outgoing ? m.toAgentId : m.fromAgentId;
      const entry = byPeer.get(id) ?? { id, name: outgoing ? m.toName : m.fromName, count: 0, last: 0, conversationId: m.conversationId };
      entry.count += 1;
      if (m.ts >= entry.last) { entry.last = m.ts; entry.conversationId = m.conversationId; }
      byPeer.set(id, entry);
    }
    return [...byPeer.values()].sort((a, b) => b.last - a.last).slice(0, PEERS);
  }, [mine, agent.id]);
  const agents = useApp(s => s.snapshot?.agents);

  const subtitle = [rolePreset(agent.role).name, modelLabel(agent, models)].filter(Boolean).join(' · ');
  const where = whereabouts(agent, projects);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-4 font-sans">
      <div className="flex items-center gap-3.5 px-4 pt-5">
        <EngineIcon engine={agent.engine} className="size-10" />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-6 text-content">{agent.name}</p>
          <p className="truncate text-[12px] text-content/45" title={subtitle}>{subtitle}</p>
        </div>
      </div>
      <WorkingIn agent={agent} where={where} home={projectLabel(agent.projectId, projects, 'Removed')} now={now} />

      <Section title="Now">
        <NowCard agent={agent} pending={pending} now={now} />
      </Section>

      {agent.context ? (
        <Section title="Context">
          <ContextBar used={agent.context.used} window={agent.context.window} />
        </Section>
      ) : null}

      <Section title="Handoffs">
        {handoffs.length ? (
          <div className="-mx-2 flex flex-col gap-px">
            {handoffs.map(({ message, report }) => {
              const outgoing = message.fromAgentId === agent.id;
              const Arrow = outgoing ? ArrowUp : ArrowLeft;
              return (
                <button
                  key={message.id}
                  type="button"
                  onClick={() => openToSide({ kind: 'comms', conversationId: message.conversationId })}
                  className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-content/5"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                    <Arrow className={`size-3 shrink-0 text-content/40 ${outgoing ? 'rotate-45' : ''}`} strokeWidth={2} />
                    <span className="shrink-0 text-content/50">{outgoing ? `To ${message.toName}` : `From ${message.fromName}`}</span>
                    <span className="ml-auto shrink-0">
                      {report
                        ? <StatusLabel tone={outcomeTone(report.outcome, message.delegation?.kind)} className="text-[11px]">{outcomeWords(report.outcome, message.delegation?.kind)}</StatusLabel>
                        : <StatusLabel tone="muted" quiet className="text-[11px]">Open</StatusLabel>}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[12.5px] leading-snug text-content/80">{message.delegation!.task}</span>
                </button>
              );
            })}
          </div>
        ) : <Muted>No work handed off or taken on yet. Delegations and their results show up here.</Muted>}
      </Section>

      <Section title="Works with">
        {peers.length ? (
          <div className="-mx-2 flex flex-col gap-px">
            {peers.map(peer => {
              const teammate = agents?.find(a => a.id === peer.id);
              return (
                <button
                  key={peer.id}
                  type="button"
                  onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'comms', conversationId: peer.conversationId })}
                  className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-content/5"
                >
                  {teammate ? <EngineIcon engine={teammate.engine} className="size-3.5" /> : <span className="size-3.5 shrink-0" />}
                  <span className="min-w-0 truncate text-[13px] text-content/85">{peer.name}</span>
                  <span className="shrink-0 text-[11px] text-content/40">{peer.count} {peer.count === 1 ? 'message' : 'messages'}</span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-content/35">{relativeTime(peer.last, now)}</span>
                </button>
              );
            })}
          </div>
        ) : <Muted>Hasn't talked with a teammate yet.</Muted>}
      </Section>

      <Walkthroughs agent={agent} now={now} />

      <Section title={memory?.length ? `Remembers · ${memory.length}` : 'Remembers'}>
        {memory?.length ? (
          <ul className="flex flex-col gap-2">
            {memory.slice(-MEMORIES).reverse().map(entry => (
              <li key={entry.id} className="flex min-w-0 gap-2 text-[12.5px] leading-snug">
                <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-content/30" />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-content/75">{entry.text}</span>
                  <span className="text-[11px] text-content/35">{memoryDate(entry.createdAt, now)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : <Muted>{memory ? 'Nothing yet. Corrections and confirmed approaches are kept here.' : 'Loading…'}</Muted>}
      </Section>

      <p className="mt-6 flex flex-wrap gap-x-3 gap-y-1 border-t border-stroke px-4 pt-3 text-[11px] tabular-nums text-content/40">
        <span>{agent.turns} {agent.turns === 1 ? 'turn' : 'turns'}</span>
        <span>{cost(agent.costUsd) || '$0'}</span>
        <span>{tokenCount(agent.tokens)} tokens</span>
        {git?.isRepo ? <span><span className="text-diff-add-fg">+{git.added}</span> <span className="text-diff-del-fg">-{git.removed}</span></span> : null}
      </p>
    </div>
  );
}

/** Which codebase and branch the agent is in; while idle, where it was last and when. */
function WorkingIn({ agent, where, home, now }: { agent: Agent; where: Whereabouts | null; home: string; now: number }) {
  const recent = agent.status === 'working' || !agent.workingIn;
  return (
    <div className="mx-4 mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-content/8 px-3 py-2 text-[12px]">
      <span className="text-content/40">{recent ? 'Working in' : 'Last in'}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-content/80">
        <Folder className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
        <span className="truncate">{where?.project || home}</span>
      </span>
      {where?.branch ? (
        <span className="flex min-w-0 items-center gap-1.5 text-content/80">
          <GitBranch className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
          <span className="truncate font-mono text-[11.5px]">{where.branch}</span>
        </span>
      ) : null}
      {!recent && agent.workingIn ? <span className="ml-auto shrink-0 tabular-nums text-content/35">{relativeTime(agent.workingIn.at, now)}</span> : null}
    </div>
  );
}

/** The agent's walkthroughs, newest first; it makes them when you ask. Refreshed after each turn. */
function Walkthroughs({ agent, now }: { agent: Agent; now: number }) {
  const [list, setList] = useState<WalkthroughSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    api.walkthroughs(agent.id).then(found => { if (live) setList(found); }, () => { if (live) setList([]); });
    return () => { live = false; };
  }, [agent.id, agent.turns]);
  if (!list?.length) return null;
  return (
    <Section title={`Walkthroughs · ${list.length}`}>
      <div className="-mx-2 flex flex-col gap-px">
        {list.slice(0, 5).map(w => (
          <button
            key={w.id}
            type="button"
            onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'walkthrough', agentId: agent.id, id: w.id, title: w.title })}
            className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-content/5"
          >
            <Route className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
            <span className="min-w-0 truncate text-[13px] text-content/85">{w.title}</span>
            <span className="shrink-0 text-[11px] text-content/40">{w.stepCount} steps</span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-content/35">{relativeTime(w.createdAt, now)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function NowCard({ agent, pending, now }: { agent: Agent; pending: boolean; now: number }) {
  const working = agent.status === 'working';
  const task = agent.currentTask?.summary;
  const ago = relativeTime(agent.lastActiveAt, now);
  const since = working && agent.turnStartedAt ? `for ${duration(now - agent.turnStartedAt)}` : ago === 'now' ? 'just now' : `${ago} ago`;
  return (
    <div className="rounded-xl border border-content/10 bg-content/3 px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-2 text-[12px]">
        <AgentStatus agent={agent} pending={pending} className="min-w-0 text-[12px]" />
        <span className="ml-auto shrink-0 tabular-nums text-content/35">{since}</span>
      </div>
      {task ? (
        <p className="mt-2 line-clamp-4 text-[13px] leading-relaxed text-content/85">{task}</p>
      ) : agent.lastSummary ? (
        <>
          <p className="mt-2.5 text-[11px] font-medium text-content/40">Last result</p>
          <p className="mt-0.5 line-clamp-5 text-[12.5px] leading-relaxed text-content/60">{agent.lastSummary}</p>
        </>
      ) : (
        <p className="mt-2 text-[12.5px] text-content/45">Nothing yet. Send it a message to get started.</p>
      )}
      {agent.error && agent.status === 'error' ? <p className="mt-2 line-clamp-3 text-[12px] text-danger">{agent.error}</p> : null}
      {agent.queued ? <p className="mt-2 text-[12px] text-content/45">{agent.queued} more waiting behind it</p> : null}
    </div>
  );
}

function ContextBar({ used, window }: { used: number; window?: number }) {
  if (!window) return <p className="text-[12.5px] text-content/70">{tokenCount(used)} tokens in context</p>;
  const share = Math.min(1, used / window);
  const tone = share >= 0.9 ? 'bg-danger' : share >= 0.75 ? 'bg-warning' : 'bg-content/60';
  return (
    <div>
      <div className="flex items-baseline justify-between text-[12px] tabular-nums">
        <span className="text-content/80">{Math.round(share * 100)}% full</span>
        <span className="text-content/40">{tokenCount(used)} / {tokenCount(window)}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-content/10" role="meter" aria-valuemin={0} aria-valuemax={window} aria-valuenow={used} aria-label="Context window used">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-4 pt-6">
      <h3 className="pb-2.5 text-[12px] font-medium text-content/50">{title}</h3>
      {children}
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] leading-relaxed text-content/40">{children}</p>;
}
