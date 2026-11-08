import type { ReactNode } from 'react';
import type { Agent } from '../../shared/types.ts';
import { relativeTime } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { projectLabel } from '../projects.ts';
import { whereabouts } from '../whereabouts.ts';
import { SHORTCUTS } from '../shortcuts.ts';
import type { SidebarActions } from '../sidebar/Sidebar.tsx';
import { useApp } from '../store.ts';
import { AgentStatus } from '../ui/AgentStatus.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { Chatting, FolderPlus, Globe, MessageMultiple, Plus, Search, Settings, type IconComponent } from '../mono/icons.tsx';
import { openBrowser } from '../browser.ts';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

const RECENT = 6;

/**
 * What an empty pane shows: the mark, a line on how the team is doing, the things you can start
 * with their shortcuts, and the agents worked with most recently. Inspired by MonoCode's start
 * screen, not a copy of it.
 */
export function HomePane({ chrome, actions }: { chrome: PaneChrome; actions: SidebarActions }) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const projects = useApp(s => s.snapshot?.projects);
  const approvals = useApp(s => s.snapshot?.approvals);
  const pendingIds = new Set(approvals?.map(a => a.agentId));
  const recent = [...agents].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, RECENT);
  const now = Date.now();

  return (
    <PaneFrame chrome={chrome} title={<span className="text-content/50">Home</span>}>
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col justify-center px-8 py-12 font-sans">
          <header className="flex items-center gap-4">
            <LargeMark />
            <div className="min-w-0">
              <h1 className="text-[17px] font-medium tracking-tight text-content/90">AgentsCode</h1>
              <p className="mt-0.5 truncate text-[12px] text-content/45">{teamLine(agents, pendingIds)}</p>
            </div>
          </header>

          <div className="mt-10 grid gap-x-10 gap-y-8 @[560px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <Section title="Start">
              <ActionRow icon={Plus} label="New agent" hint={SHORTCUTS.newAgent} onClick={() => actions.newAgent()} />
              <ActionRow icon={FolderPlus} label="Add project" onClick={actions.addProject} />
              <ActionRow icon={Chatting} label="New channel" onClick={actions.newChannel} />
              <ActionRow icon={MessageMultiple} label="Open Comms" onClick={() => open({ kind: 'comms' })} />
              <ActionRow icon={Globe} label="New browser tab" hint={SHORTCUTS.browser} onClick={() => openBrowser()} />
              <ActionRow icon={Search} label="Command palette" hint={SHORTCUTS.palette} onClick={actions.palette} />
              <ActionRow icon={Settings} label="Settings" hint={SHORTCUTS.settings} onClick={actions.settings} />
            </Section>

            <Section title="Recent agents">
              {recent.length ? recent.map(agent => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  pending={pendingIds.has(agent.id)}
                  project={placeLabel(agent, projects)}
                  when={relativeTime(agent.lastActiveAt, now)}
                />
              )) : (
                <p className="px-2 py-1.5 text-[12px] leading-relaxed text-content/40">
                  No agents yet. Start one and it will show up here.
                </p>
              )}
            </Section>
          </div>

          <p className="mt-10 text-[11px] text-content/35">
            Cmd+click an agent to open it beside this one. {SHORTCUTS.terminal} toggles the terminal, {SHORTCUTS.sidebar} the sidebar.
          </p>
        </div>
      </div>
    </PaneFrame>
  );
}

/** The codebase and branch an agent is in, or its project until it has touched one. */
function placeLabel(agent: Agent, projects: Parameters<typeof whereabouts>[1]): string {
  const where = whereabouts(agent, projects);
  if (!where) return projectLabel(agent.projectId, projects);
  return where.branch ? `${where.project} / ${where.branch}` : where.project;
}

function teamLine(agents: readonly Agent[], pendingIds: ReadonlySet<string>): string {
  if (!agents.length) return 'Run several coding agents side by side, and let them talk to each other.';
  const working = agents.filter(a => a.status === 'working').length;
  const waiting = agents.filter(a => a.status === 'waiting' || pendingIds.has(a.id)).length;
  const parts = [`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`];
  if (working) parts.push(`${working} working`);
  if (waiting) parts.push(`${waiting} ${waiting === 1 ? 'needs' : 'need'} you`);
  if (!working && !waiting) parts.push('all quiet');
  return parts.join(' · ');
}

/** The app's grid mark at hero size, drawn like BrandMark. */
function LargeMark() {
  return (
    <span aria-hidden className="grid size-11 shrink-0 place-items-center rounded-xl border border-content/8 bg-content/[0.04]">
      <svg viewBox="0 0 16 16" className="size-6">
        <rect x="2.5" y="2.5" width="5" height="5" className="fill-content" />
        <rect x="8.5" y="2.5" width="5" height="5" className="fill-content/30" />
        <rect x="2.5" y="8.5" width="5" height="5" className="fill-content/30" />
        <rect x="8.5" y="8.5" width="5" height="5" className="fill-content" />
      </svg>
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h2 className="mb-1.5 px-2 text-[11px] font-medium text-content/40">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

const ROW = 'group flex h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] text-content/70 transition-colors duration-150 hover:bg-content/[0.06] hover:text-content focus-visible:bg-content/[0.06] focus-visible:outline-none';

function ActionRow({ icon: Icon, label, hint, onClick }: { icon: IconComponent; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={ROW}>
      <Icon className="size-3.5 shrink-0 text-content/45 transition-colors duration-150 group-hover:text-content/70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <kbd className="shrink-0 font-sans text-[11px] text-content/35">{hint}</kbd> : null}
    </button>
  );
}

function AgentRow({ agent, pending, project, when }: { agent: Agent; pending: boolean; project: string; when: string }) {
  return (
    <button
      type="button"
      onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id })}
      className={ROW}
    >
      <EngineIcon engine={agent.engine} className="size-3.5 shrink-0 opacity-70" />
      <span className="shrink-0 font-medium text-content/80">{agent.name}</span>
      <span className="min-w-0 truncate text-[11.5px] text-content/35">{project}</span>
      <span className="ml-auto flex min-w-0 shrink items-center justify-end gap-2 pl-2">
        <AgentStatus agent={agent} pending={pending} className="min-w-0 max-w-[140px] text-[11px]" />
        <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-content/30">{when}</span>
      </span>
    </button>
  );
}
