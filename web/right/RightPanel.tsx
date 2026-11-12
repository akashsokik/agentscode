import { useMemo, useRef, useState, type ReactNode } from 'react';
import { kindWords, messagePreview, outcomeWords, reportKind, taskTitle } from '../peerText.ts';
import type { Agent, ChangedFile, GitStatus } from '../../shared/types.ts';
import { AgentOverview } from './AgentOverview.tsx';
import type { Root } from '../api.ts';
import { rolePreset } from '../../shared/roles.ts';
import { cost, relativeTime } from '../format.ts';
import { refreshGit, useGitStatus } from '../git.ts';
import { focusedAgentId, focusedChannelId, open, openToSide, setRightPanel, setRightView, setSuperView, SUPER_VIEWS, useLayout, type Layout, type SuperView } from '../layout.ts';
import { ALL_PROJECTS } from '../projects.ts';
import { useApp } from '../store.ts';
import { AgentStatus } from '../ui/AgentStatus.tsx';
import { ResizeHandle, useColumnWidth } from '../ui/ResizeHandle.tsx';
import { Empty, HeaderButton, IconTab, Loading, MenuRow, TextButton } from '../ui/common.tsx';
import { ContextMenu, type MenuAnchor } from '../ui/ContextMenu.tsx';
import { fitPanelTabs } from './panelTabsFit.ts';
import { useElementWidth } from '../ui/useElementWidth.ts';
import { Bot, CheckCircle, CircleDot, Clock, DashboardSquare, FileDiff, Folder, GitBranch, ListBullet, MessageMultiple, MoreHorizontal, PanelRight, RefreshCw, StickyNote, type IconComponent } from '../mono/icons.tsx';
import { NotesView } from '../notes/NotesView.tsx';
import { WorkPanel } from '../work/WorkView.tsx';
import { Segmented } from '../mono/settings.tsx';
import { MessageStatus } from '../panes/CommsPane.tsx';
import { DecisionsView, GoalsView, RoutinesView, useSuperTabs } from '../panes/SuperPanel.tsx';
import { superPanelView } from '../superText.ts';
import { useNow } from '../ui/useNow.ts';
import { AgentAvatar } from '../ui/Avatar.tsx';

/** Porcelain codes as MonoCode's Changes list shows them: M, A, D, R, U. */
const STATUS_TONE: Record<string, string> = {
  M: 'text-warning', A: 'text-success', U: 'text-success', D: 'text-danger', R: 'text-info',
};

function statusLetter(status: string): string {
  if (status === '??') return 'U';
  return status.replace(/\s/g, '').charAt(0) || '?';
}

function ChangeRow({ file, root }: { file: ChangedFile; root: Root }) {
  const name = file.path.split('/').pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/, '');
  const letter = statusLetter(file.status);
  return (
    <button type="button" onClick={() => open({ kind: 'diff', root, path: file.path })} title={file.path} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left font-sans transition-colors duration-100 hover:bg-content/5">
      <FileDiff className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
      <span className="shrink-0 text-[13px] text-content">{name}</span>
      <span className="min-w-0 truncate text-[11px] text-content/40">{dir}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums">
        {file.added > 0 ? <span className="text-diff-add-fg">+{file.added}</span> : null}
        {file.removed > 0 ? <span className="text-diff-del-fg">-{file.removed}</span> : null}
        <span className={`w-3 text-center font-semibold ${STATUS_TONE[letter] ?? 'text-content/50'}`}>{letter}</span>
      </span>
    </button>
  );
}

/** The git root for an agent's changes; an agent with no project has no one folder to diff. */
function changesRoot(agent: Agent | undefined): Root | null {
  return agent && agent.projectIds !== null ? { agent: agent.id } : null;
}

export function ChangesView({ agent }: { agent: Agent | undefined }) {
  const root = useMemo(() => changesRoot(agent), [agent?.id, agent?.projectIds?.[0]]);
  const { status, error } = useGitStatus(root, agent ? `${agent.status}:${agent.turns}` : undefined);
  if (agent?.projectIds === null) {
    return (
      <Empty icon={Folder} title={ALL_PROJECTS}>
        {agent.name} has no project of its own, so there is no single working tree to show changes for. Open a project agent, or a project's Changes, to see what changed there.
      </Empty>
    );
  }
  if (!agent || !root) return <Empty icon={Bot} title="No agent selected">Open an agent to see the changes in its workspace.</Empty>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3 font-sans text-[12px]">
        <span className="font-medium text-content/85">Changes</span>
        {status?.isRepo ? <span className="font-mono text-[11px]"><span className="text-diff-add-fg">+{status.added}</span> <span className="text-diff-del-fg">-{status.removed}</span></span> : null}
        {status?.branch ? <span className="ml-auto flex min-w-0 items-center gap-1 text-content/45"><GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} /><span className="truncate">{status.branch}</span></span> : <span className="ml-auto" />}
        <HeaderButton icon={RefreshCw} label="Refresh" onClick={() => refreshGit(root)} />
      </div>
      {error ? <p className="px-3 font-sans text-[12px] text-danger">{error}</p>
        : !status ? <Loading className="px-3 py-4" />
        : !status.isRepo ? <Empty icon={GitBranch} title="Not a git repository">Changes are tracked for folders inside a git repository.</Empty>
        : !status.files.length ? <Empty icon={CheckCircle} title="No changes">{agent.name}'s working tree matches HEAD{status.commits ? `, with ${status.commits} commits on its branch` : ''}.</Empty>
        : (
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
            <p className="flex items-center gap-2 px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-content/40">
              Changes <span className="rounded-full bg-content/10 px-1.5 text-content/70">{status.files.length}</span>
              {status.commits ? <span className="ml-auto normal-case tracking-normal">{status.commits} commits on branch</span> : null}
            </p>
            {status.files.map(file => <ChangeRow key={file.path} file={file} root={root} />)}
          </div>
        )}
    </div>
  );
}

function CommsFeed({ agent }: { agent: Agent | undefined }) {
  const messages = useApp(s => s.snapshot?.messages);
  const channels = useApp(s => s.snapshot?.channels);
  const agents = useApp(s => s.snapshot?.agents);
  const [scope, setScope] = useState<'all' | 'agent'>('all');
  const now = useNow();
  const effective = scope === 'agent' && agent ? 'agent' : 'all';
  const list = useMemo(() => {
    const all = messages ?? [];
    const filtered = effective === 'agent' && agent ? all.filter(m => m.fromAgentId === agent.id || m.toAgentId === agent.id) : all;
    return filtered.slice(-120).reverse();
  }, [messages, effective, agent]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-2 py-2">
        <Segmented
          label="Messages"
          value={effective}
          onChange={setScope}
          options={[{ value: 'all', label: 'All agents' }, { value: 'agent', label: agent ? agent.name : 'This agent' }]}
        />
        <TextButton onClick={() => open({ kind: 'comms' })} className="ml-auto">Open all</TextButton>
      </div>
      {!list.length ? (
        <Empty icon={MessageMultiple} title="No messages yet">When agents message, delegate to or report back to each other, the traffic appears here as it happens.</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {list.map(message => (
            <button
              key={message.id}
              type="button"
              onClick={() => openToSide(message.channelId ? { kind: 'channel', channelId: message.channelId } : { kind: 'comms', conversationId: message.conversationId })}
              className="mb-0.5 block w-full rounded-lg px-2.5 py-2 text-left font-sans text-content transition-colors duration-100 hover:bg-content/5"
            >
              <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <AgentAvatar agent={agents?.find(a => a.id === message.fromAgentId) ?? { id: message.fromAgentId }} className="size-3.5" />
                <span className="min-w-0 truncate font-medium">
                  {message.fromName} <span className="font-normal text-content/45">to</span>{' '}
                  <AgentAvatar agent={agents?.find(a => a.id === message.toAgentId) ?? { id: message.toAgentId }} animate={false} className="mr-1 inline-block size-3.5 align-[-0.2em]" />{message.toName}
                  {message.channelId ? <span className="font-normal text-content/45"> in #{channels?.find(c => c.id === message.channelId)?.name ?? 'deleted-channel'}</span> : null}
                </span>
                <time dateTime={new Date(message.ts).toISOString()} title={new Date(message.ts).toLocaleString()} className="ml-auto shrink-0 text-[11px] tabular-nums text-content/40">{relativeTime(message.ts, now)}</time>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-content/55">
                {message.report ? `${outcomeWords(message.report.outcome, reportKind(message, messages?.find(m => m.id === message.replyTo)))}: ${messagePreview(message)}` : message.delegation ? `${kindWords(message.delegation.kind)}: ${taskTitle(message.delegation.task)}` : messagePreview(message)}
              </p>
              <div className="mt-1 text-[11px]"><MessageStatus message={message} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the Overview's totals, inline: a number and its label, no box. */
function Stat({ value, label }: { value: ReactNode; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[15px] font-semibold tabular-nums text-content">{value}</span>
      <span className="text-[12px] text-content/45">{label}</span>
    </span>
  );
}

function OverviewSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="px-4 pt-[22px]">
      <h3 className="flex items-center pb-1.5 text-[11px] font-medium tracking-[0.02em] text-content/40">
        {title}
        {count ? <span className="ml-auto font-normal tabular-nums text-content/30">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** One agent in a team overview: logo, name and role, and how it is doing. Opens the agent. */
function TeamRow({ agent, pending }: { agent: Agent; pending: boolean }) {
  return (
    <button
      type="button"
      onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id })}
      title={`Open ${agent.name}`}
      className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-content/5"
    >
      <AgentAvatar agent={agent} className="size-[18px]" />
      <span className="shrink-0 text-[13px] font-medium text-content">{agent.name}</span>
      <span className="shrink-0 text-[11px] text-content/40">{rolePreset(agent.role).name}</span>
      <AgentStatus agent={agent} pending={pending} className="ml-auto min-w-0 max-w-[55%] text-[12px]" />
    </button>
  );
}

/**
 * The overview when no agent has focus: the focused channel's members, or everyone. The same
 * cards as an agent's, for the group: who is working, who needs you, turns and cost.
 */
function TeamOverview() {
  const layout = useLayout();
  const channelId = focusedChannelId(layout);
  const channel = useApp(s => s.snapshot?.channels.find(c => c.id === channelId));
  const everyone = useApp(s => s.snapshot?.agents);
  const approvals = useApp(s => s.snapshot?.approvals);
  const agents = useMemo(() => {
    const all = everyone ?? [];
    return channel ? all.filter(a => channel.memberIds.includes(a.id)) : all;
  }, [everyone, channel]);
  if (!agents.length && !channel) return <Empty icon={DashboardSquare} title="No agents yet">Add an agent to see how the team is doing.</Empty>;
  const pending = (agent: Agent) => Boolean(approvals?.some(a => a.agentId === agent.id));
  const working = agents.filter(a => a.status === 'working').length;
  const waiting = agents.filter(a => a.status === 'waiting' || pending(a)).length;
  const turns = agents.reduce((sum, a) => sum + a.turns, 0);
  const spent = agents.reduce((sum, a) => sum + a.costUsd, 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-6 font-sans">
      <div className="flex items-center gap-3.5 px-4 pt-5">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-content/[0.06] text-content/55">
          {channel ? <span className="text-[18px] leading-none">#</span> : <Bot className="size-5" strokeWidth={1.75} />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold leading-6 text-content">{channel ? channel.name : 'Team'}</p>
          <p className="truncate text-[13px] text-content/50">
            {channel?.topic || `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}${channel ? ' in this channel' : ''}`}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pt-4">
        <Stat value={working} label="working" />
        <Stat value={waiting ? <span className="text-warning">{waiting}</span> : 0} label={waiting === 1 ? 'needs you' : 'need you'} />
        <Stat value={turns} label={turns === 1 ? 'turn' : 'turns'} />
        <Stat value={cost(spent) || '$0'} label="spent" />
      </div>
      <OverviewSection title={channel ? 'Members' : 'Agents'} count={agents.length}>
        {agents.length ? (
          <div className="-mx-2 flex flex-col gap-px">
            {agents.map(agent => <TeamRow key={agent.id} agent={agent} pending={pending(agent)} />)}
          </div>
        ) : <p className="text-[13px] text-content/45">Nobody yet. Add members in the channel's settings.</p>}
      </OverviewSection>
    </div>
  );
}

/** The Overview tab: the focused agent, or the team when no agent has focus. */
function OverviewView({ agent, git }: { agent: Agent | undefined; git: GitStatus | null }) {
  return agent ? <AgentOverview key={agent.id} agent={agent} git={git} /> : <TeamOverview />;
}

type PanelView = Layout['rightView'] | SuperView;

const PANEL_TABS: { view: Layout['rightView']; label: string; icon: IconComponent }[] = [
  { view: 'overview', label: 'Overview', icon: DashboardSquare },
  { view: 'comms', label: 'Comms', icon: MessageMultiple },
  { view: 'changes', label: 'Changes', icon: FileDiff },
  { view: 'notes', label: 'Notes', icon: StickyNote },
  { view: 'work', label: 'Work', icon: GitBranch },
];

/**
 * The SuperAgent's tabs: its Overview, then its own Decisions, Goals and Routines, then Comms and the
 * projects' Notes. No
 * Changes: it works across all projects and never edits, so it has no working tree of its own.
 */
const SUPER_PANEL_TABS: { view: SuperView; label: string; icon: IconComponent }[] = [
  { view: 'overview', label: 'Overview', icon: DashboardSquare },
  { view: 'decisions', label: 'Decisions', icon: ListBullet },
  { view: 'goals', label: 'Goals', icon: CircleDot },
  { view: 'routines', label: 'Routines', icon: Clock },
  { view: 'comms', label: 'Comms', icon: MessageMultiple },
  { view: 'notes', label: 'Notes', icon: StickyNote },
  { view: 'work', label: 'Work', icon: GitBranch },
];

/** What a tab's count means, for its tooltip and a screen reader. */
const COUNT_WORDS: Partial<Record<PanelView, (n: number) => string>> = {
  comms: n => `${n} on the way`,
  decisions: n => `${n} you can undo today`,
  goals: n => `${n} open`,
  routines: n => `${n} waiting for you`,
};

/**
 * The right panel, with MonoCode's icon tabs: Overview, Comms, Changes and Notes for the focused
 * agent; for the SuperAgent, Overview, Decisions, Goals, Routines, Comms and Notes. The tabs follow the ARIA tabs
 * pattern: one tab stop, the arrow keys (and Home and End) move between them and open the one reached.
 */
export function RightPanel() {
  const layout = useLayout();
  const agentId = focusedAgentId(layout);
  const agent = useApp(s => s.snapshot?.agents.find(a => a.id === agentId));
  const inFlight = useApp(s => s.snapshot?.messages.filter(m => !m.channelId && (m.status === 'queued' || m.status === 'delivering')).length ?? 0);
  const root = useMemo(() => changesRoot(agent), [agent?.id, agent?.projectIds?.[0]]);
  const { status: git } = useGitStatus(root, agent ? `${agent.status}:${agent.turns}` : undefined);
  const isSuper = agent?.role === 'super';
  const tabs: { view: PanelView; label: string; icon: IconComponent }[] = isSuper ? SUPER_PANEL_TABS : PANEL_TABS;
  const view: PanelView = isSuper
    ? superPanelView(layout.superView, SUPER_VIEWS)
    : PANEL_TABS.some(t => t.view === layout.rightView) ? layout.rightView : 'overview';
  const pick = (next: PanelView) => (isSuper ? setSuperView(next as SuperView) : setRightView(next as Layout['rightView']));
  const superTabs = useSuperTabs(isSuper ? view : '');
  const column = useColumnWidth('panel', 320, 260, 0.4);
  const list = useRef<HTMLDivElement>(null);
  // How the tabs fit the strip's real width (panelTabsFit.ts): names first, then the open tab's
  // name, then the last tabs go into a "…" menu. The strip never reaches the collapse button.
  // Measured on the area that holds the tabs and the "…" button, so that button is counted once.
  const area = useRef<HTMLDivElement>(null);
  const stripWidth = useElementWidth(area);
  const [moreAnchor, setMoreAnchor] = useState<MenuAnchor | null>(null);
  const count = (tab: PanelView): number | undefined => {
    if (tab === 'comms') return inFlight || undefined;
    if (isSuper && (tab === 'decisions' || tab === 'goals' || tab === 'routines')) return superTabs.counts[tab] || undefined;
    return undefined;
  };
  const dot = (tab: PanelView): boolean => {
    if (tab === 'changes') return view !== 'changes' && Boolean(git?.files.length);
    return isSuper && (tab === 'decisions' || tab === 'goals' || tab === 'routines') && superTabs.dots[tab];
  };
  // Before the first measure, icons only: no names that open and then fold away.
  const fit = stripWidth === null
    ? { allLabelled: false, activeLabelled: false, visible: tabs.map(t => t.view), overflow: [] as PanelView[] }
    : fitPanelTabs(tabs.map(t => ({ view: t.view, label: t.label, count: count(t.view) })), view, stripWidth);
  const shown = tabs.filter(t => fit.visible.includes(t.view));
  const hidden = tabs.filter(t => fit.overflow.includes(t.view));
  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = tabs.findIndex(t => t.view === view);
    const to = event.key === 'ArrowRight' ? (at + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    pick(tabs[to].view);
    list.current?.querySelector<HTMLElement>(`#panel-tab-${tabs[to].view}`)?.focus();
  };
  return (
    <aside aria-label="Panel" style={{ width: column.width }} className="body-glass relative flex shrink-0 flex-col max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-20 max-xl:border-l max-xl:border-stroke">
      {/* One gap between every tab and before the collapse button (ACH-D30); the strip is clipped, so
          it can never reach under that button. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke pl-2 pr-1.5">
        <div ref={area} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        <div ref={list} role="tablist" aria-label="Panel" onKeyDown={onKeyDown} className="flex min-w-0 items-center gap-1">
          {shown.map(tab => {
            const n = count(tab.view);
            const fresh = dot(tab.view);
            const words = [tab.label, n ? COUNT_WORDS[tab.view]?.(n) : null, fresh ? 'new' : null].filter(Boolean).join(', ');
            return (
              <IconTab
                key={tab.view}
                id={`panel-tab-${tab.view}`}
                role="tab"
                aria-selected={view === tab.view}
                aria-controls="panel-view"
                tabIndex={view === tab.view ? 0 : -1}
                icon={tab.icon}
                label={tab.label}
                aria-label={words}
                title={words}
                selected={view === tab.view}
                showLabel={fit.allLabelled || (view === tab.view && fit.activeLabelled)}
                count={n}
                dot={fresh}
                onClick={() => pick(tab.view)}
              />
            );
          })}
        </div>
        {hidden.length ? (
          <HeaderButton
            icon={MoreHorizontal}
            label={`More: ${hidden.map(t => t.label).join(', ')}`}
            active={Boolean(moreAnchor)}
            aria-haspopup="menu"
            aria-expanded={Boolean(moreAnchor)}
            onClick={e => { const el = e.currentTarget; setMoreAnchor(a => (a ? null : el)); }}
          />
        ) : null}
        </div>
        <HeaderButton icon={PanelRight} label="Hide panel" onClick={() => setRightPanel(false)} />
        {moreAnchor && hidden.length ? (
          <ContextMenu anchor={moreAnchor} onClose={() => setMoreAnchor(null)} label="More panel tabs" width={200}>
            {hidden.map(tab => {
              const n = count(tab.view);
              return <MenuRow key={tab.view} icon={tab.icon} title={n ? `${tab.label} (${n})` : tab.label} onSelect={() => { setMoreAnchor(null); pick(tab.view); }} />;
            })}
          </ContextMenu>
        ) : null}
      </div>
      <div id="panel-view" role="tabpanel" aria-labelledby={`panel-tab-${view}`} className="flex min-h-0 flex-1 flex-col">
        {view === 'overview' ? <OverviewView agent={agent} git={git} />
          : view === 'changes' ? <ChangesView agent={agent} />
          : view === 'decisions' ? <DecisionsView />
          : view === 'goals' ? <GoalsView />
          : view === 'routines' ? <RoutinesView />
          : view === 'notes' ? <NotesView agent={agent} />
          : view === 'work' ? <WorkPanel />
          : <CommsFeed agent={agent} />}
      </div>
      <ResizeHandle column={column} edge="left" label="Resize panel" />
    </aside>
  );
}
