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
import { ENGINE_NAMES } from '../ui/EngineIcon.tsx';
import { useNow } from '../ui/useNow.ts';
import { Folder, GitBranch, Route } from '../mono/icons.tsx';
import { whereabouts, type Whereabouts } from '../whereabouts.ts';
import { AgentAvatar } from '../ui/Avatar.tsx';
import { emptySections } from './overviewText.ts';

const HANDOFFS = 4;
const PEERS = 4;
const MEMORIES = 3;


/** The agent's walkthroughs, newest first; it makes them when you ask. Refreshed after each turn. */
function useWalkthroughs(agent: Agent): WalkthroughSummary[] | null {
  const [list, setList] = useState<WalkthroughSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    api.walkthroughs(agent.id).then(found => { if (live) setList(found); }, () => { if (live) setList([]); });
    return () => { live = false; };
  }, [agent.id, agent.turns]);
  return list;
}

/**
 * The focused agent at a glance, with as few boxes as it takes: who it is and where it works, what
 * it is doing and for how long, how full its context is, then the work it handed off or took on,
 * who it works with, its walkthroughs and what it has learned. Sections with nothing in them yet
 * fold into one quiet line. Totals stay pinned at the foot.
 */
export function AgentOverview({ agent, git }: { agent: Agent; git: GitStatus | null | undefined }) {
  const models = useApp(s => s.snapshot?.models[agent.engine]);
  const projects = useApp(s => s.snapshot?.projects);
  const pending = useApp(s => Boolean(s.snapshot?.approvals.some(a => a.agentId === agent.id)));
  const messages = useApp(s => s.snapshot?.messages);
  const memory = useApp(s => s.memory[agent.id]);
  const now = useNow(agent.status === 'working' ? 1000 : 30_000);
  useEffect(() => { void loadMemory(agent.id); }, [agent.id]);
  const walkthroughs = useWalkthroughs(agent);

  const mine = useMemo(() => (messages ?? []).filter(m => m.fromAgentId === agent.id || m.toAgentId === agent.id), [messages, agent.id]);
  const delegations = useMemo(() => mine.filter(m => m.delegation), [mine]);
  const handoffs = useMemo(() => {
    const reports = new Map<string, PeerMessage>();
    for (const m of mine) if (m.report && m.replyTo) reports.set(m.replyTo, m);
    return delegations.slice(-HANDOFFS).reverse().map(m => ({ message: m, report: reports.get(m.id)?.report }));
  }, [mine, delegations]);
  const allPeers = useMemo(() => {
    const byPeer = new Map<string, { id: string; name: string; count: number; last: number; conversationId: string }>();
    for (const m of mine) {
      const outgoing = m.fromAgentId === agent.id;
      const id = outgoing ? m.toAgentId : m.fromAgentId;
      const entry = byPeer.get(id) ?? { id, name: outgoing ? m.toName : m.fromName, count: 0, last: 0, conversationId: m.conversationId };
      entry.count += 1;
      if (m.ts >= entry.last) { entry.last = m.ts; entry.conversationId = m.conversationId; }
      byPeer.set(id, entry);
    }
    return [...byPeer.values()].sort((a, b) => b.last - a.last);
  }, [mine, agent.id]);
  const peers = allPeers.slice(0, PEERS);
  const agents = useApp(s => s.snapshot?.agents);

  const subtitle = [rolePreset(agent.role).name, ENGINE_NAMES[agent.engine], modelLabel(agent, models)].filter(Boolean).join(' · ');
  const where = whereabouts(agent, projects);
  // What is still empty, said once at the end instead of a heading and a sentence each.
  const empty = emptySections({ handoffs: handoffs.length, peers: peers.length, walkthroughs: walkthroughs?.length, memories: memory?.length });

  return (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="flex items-center gap-3 px-4 pt-[18px]">
          <AgentAvatar agent={agent} className="size-11" />
          <div className="min-w-0">
            <p className="flex min-w-0 items-baseline gap-2" title={subtitle}>
              <span className="truncate text-[15px] font-semibold leading-5 text-content">{agent.name}</span>
              <span className="shrink-0 text-[12.5px] text-content/45">{rolePreset(agent.role).name}</span>
            </p>
            <WorkingIn agent={agent} where={where} home={projectLabel(agent.projectIds, projects, 'Removed')} now={now} />
          </div>
        </div>

        <Now agent={agent} pending={pending} now={now} />
        {agent.context ? <ContextLine used={agent.context.used} window={agent.context.window} /> : null}

        {handoffs.length ? (
          <Section title="Handoffs" count={delegations.length}>
            <div className="flex flex-col gap-px px-2">
              {handoffs.map(({ message, report }) => {
                const outgoing = message.fromAgentId === agent.id;
                const otherId = outgoing ? message.toAgentId : message.fromAgentId;
                return (
                  <button
                    key={message.id}
                    type="button"
                    onClick={() => openToSide({ kind: 'comms', conversationId: message.conversationId })}
                    className={`${ROW} items-start`}
                  >
                    <AgentAvatar agent={{ id: otherId, ...agents?.find(a => a.id === otherId) }} className="mt-px size-[18px]" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                        <span className="min-w-0 truncate text-content/55">{outgoing ? `To ${message.toName}` : `From ${message.fromName}`}</span>
                        <span className="ml-auto shrink-0">
                          {report
                            ? <StatusLabel tone={outcomeTone(report.outcome, message.delegation?.kind)} className="text-[11.5px]">{outcomeWords(report.outcome, message.delegation?.kind)}</StatusLabel>
                            : <StatusLabel tone="muted" quiet className="text-[11.5px]">Open</StatusLabel>}
                        </span>
                      </span>
                      <span className="mt-px line-clamp-2 text-[12.5px] leading-[1.4] text-content/85">{message.delegation!.task}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        ) : null}

        {peers.length ? (
          <Section title="Works with" count={allPeers.length}>
            <div className="flex flex-col gap-px px-2">
              {peers.map(peer => {
                const teammate = agents?.find(a => a.id === peer.id);
                return (
                  <button
                    key={peer.id}
                    type="button"
                    onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'comms', conversationId: peer.conversationId })}
                    className={`${ROW} items-center`}
                  >
                    {teammate ? <AgentAvatar agent={teammate} className="size-[18px]" /> : <span className="size-[18px] shrink-0" />}
                    <span className="min-w-0 truncate text-[12.5px] text-content/85">{peer.name}</span>
                    <span className="shrink-0 text-[11.5px] text-content/45">{peer.count} {peer.count === 1 ? 'message' : 'messages'}</span>
                    <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-content/35">{relativeTime(peer.last, now)}</span>
                  </button>
                );
              })}
            </div>
          </Section>
        ) : null}

        {walkthroughs?.length ? (
          <Section title="Walkthroughs" count={walkthroughs.length}>
            <div className="flex flex-col gap-px px-2">
              {walkthroughs.slice(0, 5).map(w => (
                <button
                  key={w.id}
                  type="button"
                  onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'walkthrough', agentId: agent.id, id: w.id, title: w.title })}
                  className={`${ROW} items-center`}
                >
                  <Route className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
                  <span className="min-w-0 truncate text-[12.5px] text-content/85">{w.title}</span>
                  <span className="shrink-0 text-[11.5px] text-content/45">{w.stepCount} steps</span>
                  <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-content/35">{relativeTime(w.createdAt, now)}</span>
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {memory?.length ? (
          <Section title="Remembers" count={memory.length}>
            <ul className="flex flex-col gap-2 px-4">
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
          </Section>
        ) : null}

        {empty ? <p className="px-4 pt-5 text-[12px] leading-relaxed text-content/40">No {empty} yet. They show up here once {agent.name} has some.</p> : null}
      </div>

      <p className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 px-4 pb-3 pt-2.5 text-[11px] tabular-nums text-content/40">
        <span>{agent.turns} {agent.turns === 1 ? 'turn' : 'turns'}</span>
        <span>{cost(agent.costUsd) || '$0'}</span>
        <span>{tokenCount(agent.tokens)} tokens</span>
        {git?.isRepo ? <span className="ml-auto"><span className="text-diff-add-fg">+{git.added}</span> <span className="text-diff-del-fg">-{git.removed}</span></span> : null}
      </p>
    </div>
  );
}

const ROW = 'flex w-full min-w-0 gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-content/5';

/** Which codebase and branch the agent is in, under its name; while idle, where it was last. */
function WorkingIn({ agent, where, home, now }: { agent: Agent; where: Whereabouts | null; home: string; now: number }) {
  const recent = agent.status === 'working' || !agent.workingIn;
  const project = where?.project || home;
  const title = `${recent ? 'Working in' : 'Last in'} ${project}${where?.branch ? ` on ${where.branch}` : ''}${!recent && agent.workingIn ? `, ${relativeTime(agent.workingIn.at, now)} ago` : ''}`;
  return (
    <p className="mt-[3px] flex min-w-0 items-center gap-1.5 text-[12px] text-content/50" title={title}>
      <Folder className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />
      <span className="min-w-0 truncate">{project}</span>
      {where?.branch ? (
        <>
          <GitBranch className="ml-1 size-3 shrink-0 text-content/40" strokeWidth={1.75} />
          <span className="min-w-0 truncate font-mono text-[11.5px]">{where.branch}</span>
        </>
      ) : null}
    </p>
  );
}

/** What the agent is doing, as plain text: its state and for how long, then the task or its last result. */
function Now({ agent, pending, now }: { agent: Agent; pending: boolean; now: number }) {
  const working = agent.status === 'working';
  const task = agent.currentTask?.summary;
  const ago = relativeTime(agent.lastActiveAt, now);
  const since = working && agent.turnStartedAt ? `for ${duration(now - agent.turnStartedAt)}` : ago === 'now' ? 'just now' : `${ago} ago`;
  return (
    <div className="px-4 pt-4">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
        <AgentStatus agent={agent} pending={pending} className="min-w-0 text-[12px]" />
        <span className="shrink-0 tabular-nums text-content/40">{since}</span>
        {!task && agent.lastSummary ? <span className="shrink-0 text-content/30">· last result</span> : null}
      </div>
      {task ? (
        <p className="mt-1.5 line-clamp-4 text-[13.5px] leading-normal text-content/90">{task}</p>
      ) : agent.lastSummary ? (
        <p className="mt-1.5 line-clamp-5 text-[13.5px] leading-normal text-content/80">{agent.lastSummary}</p>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-content/45">Nothing yet. Send it a message to get started.</p>
      )}
      {agent.error && agent.status === 'error' ? <p className="mt-2 line-clamp-3 text-[12px] text-danger">{agent.error}</p> : null}
      {agent.queued ? <p className="mt-2 text-[12px] text-content/45">{agent.queued} more waiting behind it</p> : null}
    </div>
  );
}

/** How full the context window is, on one thin line. */
function ContextLine({ used, window }: { used: number; window?: number }) {
  if (!window) return <p className="px-4 pt-3.5 text-[11.5px] tabular-nums text-content/45">Context · {tokenCount(used)} tokens</p>;
  const share = Math.min(1, used / window);
  const tone = share >= 0.9 ? 'bg-danger' : share >= 0.75 ? 'bg-warning' : 'bg-content/55';
  return (
    <div className="flex items-center gap-2.5 px-4 pt-3.5 text-[11.5px] tabular-nums text-content/45">
      <span className="shrink-0">Context</span>
      <div className="h-[3px] min-w-6 flex-1 overflow-hidden rounded-full bg-content/10" role="meter" aria-valuemin={0} aria-valuemax={window} aria-valuenow={used} aria-label="Context window used">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(2, share * 100)}%` }} />
      </div>
      <span className="shrink-0">{Math.round(share * 100)}% · {tokenCount(used)} of {tokenCount(window)}</span>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="pt-[22px]">
      <h3 className="flex items-center px-4 pb-1.5 text-[11px] font-medium tracking-[0.02em] text-content/40">
        {title}
        {count ? <span className="ml-auto font-normal tabular-nums text-content/30">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}
