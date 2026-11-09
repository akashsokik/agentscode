import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Agent } from '../../shared/types.ts';
import { SUPER_LOOK } from '../../shared/avatar.ts';
import { api } from '../api.ts';
import { relativeTime } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { projectLabel } from '../projects.ts';
import { homeRecent, homeTarget, sendQuick, type QuickTarget } from '../quick/route.ts';
import { whereabouts } from '../whereabouts.ts';
import { SHORTCUTS } from '../shortcuts.ts';
import type { SidebarActions } from '../sidebar/Sidebar.tsx';
import { attempt, useApp } from '../store.ts';
import { ArrowUp } from '../mono/icons.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { cx } from '../ui/common.tsx';
import { useNow } from '../ui/useNow.ts';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';
import { AgentAvatar, AvatarGlyph } from '../ui/Avatar.tsx';

const RECENT = 4;
const CREW = 5;
const CHIPS = 4;

/**
 * What an empty pane shows: the team's faces, a line on how it is doing, and a composer, since the
 * fastest thing to do here is to ask an agent something. Pick who gets it with a chip, or open the
 * message with @Name; sending opens that agent. Under it, the agents to pick up with, the ones that
 * need you first, and the few things you can start, which the sidebar and the palette also hold.
 * Inspired by MonoCode's start screen, not a copy of it.
 */
export function HomePane({ chrome, actions }: { chrome: PaneChrome; actions: SidebarActions }) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const projects = useApp(s => s.snapshot?.projects);
  const approvals = useApp(s => s.snapshot?.approvals);
  const superId = useApp(s => s.snapshot?.super.agentId ?? null);
  const pendingIds = useMemo(() => new Set(approvals?.map(a => a.agentId)), [approvals]);
  const team = agents.filter(a => a.role !== 'super');
  const recent = homeRecent(team, pendingIds, RECENT);
  const now = useNow();

  return (
    <PaneFrame chrome={chrome} title={<span className="text-content/50">Home</span>}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[600px] flex-col items-center px-8 pb-7 pt-[max(3rem,12vh)] font-sans">
          <Crew agents={homeRecent(team, pendingIds, CREW)} />
          <h1 className="mt-4 text-center text-[19px] font-semibold tracking-[-0.015em] text-content">What should the team work on?</h1>
          <p className="mt-0.5 text-center text-[12.5px] text-content/45"><TeamLine agents={team} pendingIds={pendingIds} /></p>

          <HomeComposer agents={agents} team={recent.slice(0, CHIPS)} superId={superId} />

          {recent.length ? (
            <section className="mt-7 w-full max-w-[520px]">
              <h2 className="mb-1 px-2 text-[11px] font-medium text-content/40">Pick up where you left off</h2>
              <div className="flex flex-col">
                {recent.map(agent => (
                  <AgentRow key={agent.id} agent={agent} pending={pendingIds.has(agent.id)} place={placeLabel(agent, projects)} now={now} />
                ))}
              </div>
            </section>
          ) : null}

          <nav aria-label="Start" className="mt-auto flex flex-wrap justify-center gap-x-1 gap-y-0.5 pt-7">
            <StartLink label="New agent" hint={SHORTCUTS.newAgent} onClick={() => actions.newAgent()} />
            <StartLink label="Add project" onClick={actions.addProject} />
            <StartLink label="New channel" onClick={actions.newChannel} />
            <StartLink label="Palette" hint={SHORTCUTS.palette} onClick={actions.palette} />
            <StartLink label="Settings" hint={SHORTCUTS.settings} onClick={actions.settings} />
          </nav>
        </div>
      </div>
    </PaneFrame>
  );
}

/** The team's avatars as the hero, the SuperAgent among them; before there is a team, the SuperAgent alone. */
function Crew({ agents }: { agents: Agent[] }) {
  const at = Math.floor(agents.length / 2);
  return (
    <div aria-hidden className="flex items-end justify-center">
      {agents.slice(0, at).map(agent => <AgentAvatar key={agent.id} agent={agent} className="-mx-[3px] size-[34px]" />)}
      <AvatarGlyph look={SUPER_LOOK} seed="super" className="-mx-[3px] size-10" />
      {agents.slice(at).map(agent => <AgentAvatar key={agent.id} agent={agent} className="-mx-[3px] size-[34px]" />)}
    </div>
  );
}

/** The codebase and branch an agent is in, or its project until it has touched one. */
function placeLabel(agent: Agent, projects: Parameters<typeof whereabouts>[1]): string {
  const where = whereabouts(agent, projects);
  if (!where) return projectLabel(agent.projectId, projects);
  return where.branch ? `${where.project} / ${where.branch}` : where.project;
}

/** How the team is doing in one line; whoever needs you is named, in the warning tone. */
function TeamLine({ agents, pendingIds }: { agents: readonly Agent[]; pendingIds: ReadonlySet<string> }) {
  if (!agents.length) return <>Run several coding agents side by side, and let them talk to each other.</>;
  const working = agents.filter(a => a.status === 'working').length;
  const waiting = agents.filter(a => a.status === 'waiting' || pendingIds.has(a.id));
  return (
    <>
      {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
      {working ? ` · ${working} working` : ''}
      {waiting.length ? <> · <span className="text-warning">{waiting.length === 1 ? `${waiting[0].name} needs you` : `${waiting.length} need you`}</span></> : null}
      {!working && !waiting.length ? ' · all quiet' : ''}
    </>
  );
}

/**
 * Home's composer, with the floating look of the agent composer: write, pick who gets it, send.
 * Enter sends, Shift+Enter breaks the line. The message goes out through the quick composer's
 * routing (sendQuick), and the agent that has it opens in this pane.
 */
function HomeComposer({ agents, team, superId }: { agents: readonly Agent[]; team: readonly Agent[]; superId: string | null }) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<QuickTarget>({ kind: 'super' });
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // A picked agent that was removed falls back to the SuperAgent.
  const live: QuickTarget = picked.kind === 'agent' && !agents.some(a => a.id === picked.agentId) ? { kind: 'super' } : picked;
  // An opening @Name says who it is for, whatever chip is picked; the chip follows it.
  const routed = homeTarget(text, agents, live);
  const canSend = Boolean(routed.text) && !sending;

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const sent = await attempt(() => sendQuick(routed.target, routed.text, { agents, superId }, api));
    setSending(false);
    if (!sent) return;
    setText('');
    open({ kind: 'agent', agentId: sent.agentId });
  };

  const isOn = (target: QuickTarget) => (target.kind === 'super' ? routed.target.kind === 'super' : routed.target.kind === 'agent' && target.kind === 'agent' && routed.target.agentId === target.agentId);
  const to = routed.target.kind === 'agent' ? agents.find(a => a.id === (routed.target as { agentId: string }).agentId)?.name ?? 'an agent' : 'SuperAgent';
  const chip = (target: QuickTarget, label: string, mark: ReactNode) => (
    <button
      key={label}
      type="button"
      role="radio"
      aria-checked={isOn(target)}
      onClick={() => { setPicked(target); field.current?.focus(); }}
      className={cx('flex h-[26px] min-w-0 shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2.5 text-[12px] transition-colors duration-150', isOn(target) ? 'bg-content/[0.09] text-content' : 'text-content/60 hover:bg-content/5 hover:text-content')}
    >
      {mark}
      <span className="max-w-24 truncate">{label}</span>
    </button>
  );

  return (
    <div data-composer-box className="relative z-10 mt-5 w-full max-w-[520px] rounded-[14px] border border-content/10">
      <textarea
        ref={field}
        autoFocus
        value={text}
        rows={1}
        aria-label={`Message ${to}`}
        onChange={e => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={superId || team.length ? 'Ask SuperAgent, or @ an agent…' : 'Ask the SuperAgent. It is set up when you send.'}
        className="scrollbar-none relative block max-h-40 min-h-11 w-full resize-none overflow-x-hidden whitespace-pre-wrap wrap-break-word bg-transparent px-3.5 pb-2 pt-3 font-sans text-sm leading-5.5 text-content outline-none placeholder:text-content/40"
      />
      <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
        <div role="radiogroup" aria-label="Send to" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chip({ kind: 'super' }, 'SuperAgent', <AvatarGlyph look={SUPER_LOOK} seed="super" className="size-4" />)}
          {team.map(agent => chip({ kind: 'agent', agentId: agent.id }, agent.name, <AgentAvatar agent={agent} className="size-4" />))}
        </div>
        <button type="button" title={`Send to ${to}`} aria-label={`Send to ${to}`} disabled={!canSend} onClick={() => void send()} className="composer-send primary-action grid size-6.5 shrink-0 place-items-center rounded-lg transition-[background-color,transform] duration-150 active:scale-[0.94] disabled:cursor-default disabled:active:scale-100">
          <ArrowUp className="size-3.5" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

/** One agent to pick up with: who, what it is on, and how it is doing at the right. */
function AgentRow({ agent, pending, place, now }: { agent: Agent; pending: boolean; place: string; now: number }) {
  const what = agent.currentTask?.summary || agent.lastSummary || place;
  const state = pending || agent.status === 'waiting' ? <span className="font-medium text-warning">Needs you</span>
    : agent.status === 'working' ? <span className="flex items-center gap-1.5 text-content/45"><TerminalSpinner className="text-content/55" />{agent.turnStartedAt ? relativeTime(agent.turnStartedAt, now) : ''}</span>
    : agent.status === 'error' ? <span className="text-danger">Failed</span>
    : <span className="text-content/35">{relativeTime(agent.lastActiveAt, now)}</span>;
  return (
    <button
      type="button"
      onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id })}
      title={`${agent.name}, ${place}. Cmd+click to open beside.`}
      className="flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] transition-colors duration-150 hover:bg-content/[0.06] focus-visible:bg-content/[0.06] focus-visible:outline-none"
    >
      <AgentAvatar agent={agent} className="size-5" />
      <span className="shrink-0 font-medium text-content/85">{agent.name}</span>
      <span className="min-w-0 flex-1 truncate text-content/45">{what}</span>
      <span className="shrink-0 pl-2 text-[11px] tabular-nums">{state}</span>
    </button>
  );
}

/** One of the few things to start from Home, as a quiet word with its shortcut. */
function StartLink({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-content/45 transition-colors duration-150 hover:bg-content/[0.06] hover:text-content focus-visible:bg-content/[0.06] focus-visible:outline-none">
      {label}
      {hint ? <kbd className="font-sans text-[11px] text-content/30">{hint}</kbd> : null}
    </button>
  );
}
