import { Fragment, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { Agent, Channel, Project, TreeEntry } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { api, type Root } from '../api.ts';
import { modelLabel, relativeTime, shortPath } from '../format.ts';
import { closeTab, focusedAgentId, focusedChannelId, open, openToSide, setProject, setRail, setSidebarView, useLayout, type Layout } from '../layout.ts';
import { ChangesView } from '../right/RightPanel.tsx';
import { attempt, useApp } from '../store.ts';
import { whereabouts } from '../whereabouts.ts';
import { BrandMark } from '../ui/BrandMark.tsx';
import { SidebarUpdateFooter, useDesktopUpdate } from './SidebarUpdate.tsx';
import { isUpdateActionable, updateLabel } from '../../shared/updates.ts';
import { DreamNowMenuRow } from '../ui/DreamNowMenuRow.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { ResizeHandle, useColumnWidth, useWindowWidth } from '../ui/ResizeHandle.tsx';
import { SHORTCUTS } from '../shortcuts.ts';
import { showTerminal } from '../terminal/actions.ts';
import { cx, Empty, HeaderButton, Loading, MenuDivider, MenuLabel, MenuRow, StatusLabel } from '../ui/common.tsx';
import { ArrowDownCircle, ChevronDown, ChevronRight, ChevronsUpDown, File, Folder, FolderOpen, FolderPlus, GitBranch, MessageMultiple, MoreHorizontal, PanelLeft, Plus, RotateCcw, Search, Settings, Sparkles, SplitColumns, Square, StickyNote, Terminal, Trash2, X, type IconComponent } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Select } from '../mono/settings.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { useNow } from '../ui/useNow.ts';
import { railAgents, railAgentStatus, showsWorkspace, type RailAgentStatus } from './agentRail.ts';
import { openAsks, openSuper } from '../super.ts';

export interface SidebarActions {
  /** null preselects No project; undefined starts from the current project. */
  newAgent: (projectId?: string | null) => void;
  addProject: () => void;
  settings: () => void;
  /** About you: what every agent knows about the user (user.md). */
  profile: () => void;
  agentSettings: (agentId: string) => void;
  removeAgent: (agentId: string) => void;
  newChannel: () => void;
  channelSettings: (channelId: string) => void;
  palette: () => void;
}

/** A context menu opens at the pointer, or at its trigger when opened from a button or the keyboard. */
type MenuAnchor = HTMLElement | { x: number; y: number };
type SetMenu = (update: MenuAnchor | null | ((m: MenuAnchor | null) => MenuAnchor | null)) => void;

/** Right-click handler: replaces the browser menu with ours. */
function openContextMenu(e: MouseEvent<HTMLElement>, setMenu: SetMenu): void {
  e.preventDefault();
  // React bubbles events out of portals: a right-click inside the open menu is not a new one.
  if (!e.currentTarget.contains(e.target as Node)) return;
  // The context-menu key fires with no pointer position; anchor to the element instead.
  setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : e.currentTarget);
}

/** Click handler for a ... button: toggles a menu anchored to the button. */
function toggleMenu(e: MouseEvent<HTMLElement>, setMenu: SetMenu): void {
  const el = e.currentTarget;
  setMenu(m => (m ? null : el));
}

function SidebarMenu({ anchor, onClose, children }: { anchor: MenuAnchor; onClose: () => void; children: ReactNode }) {
  return (
    <Popover anchor={anchor} side="bottom" align="start" width={232} constrainHeight={false} onDismiss={onClose} className="p-1.5">
      {children}
    </Popover>
  );
}

/** Everything you can do to an agent from the sidebar: right-click a card, or its ... button. */
function AgentMenu({ agent, anchor, actions, onClose }: { agent: Agent; anchor: MenuAnchor; actions: SidebarActions; onClose: () => void }) {
  const layout = useLayout();
  const tab = layout.tabs.find(t => t.content.kind === 'agent' && t.content.agentId === agent.id);
  const busy = agent.status === 'working' || agent.status === 'waiting';
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <SidebarMenu anchor={anchor} onClose={onClose}>
      <MenuLabel>{agent.name}</MenuLabel>
      <MenuRow icon={SplitColumns} title="Open to the side" onSelect={run(() => openToSide({ kind: 'agent', agentId: agent.id }))} />
      {tab ? <MenuRow icon={X} title="Close tab" hint="The agent and its history stay." onSelect={run(() => closeTab(tab.id))} /> : null}
      <MenuDivider />
      {busy ? <MenuRow icon={Square} title="Stop" hint="Interrupt the current turn." onSelect={run(() => void attempt(() => api.stop(agent.id)))} /> : null}
      <MenuRow icon={RotateCcw} title="New session" hint="Clear the conversation context." disabled={busy} onSelect={run(() => void attempt(() => api.newSession(agent.id)))} />
      <DreamNowMenuRow agent={agent} run={run} />
      <MenuRow icon={Settings} title="Agent settings" onSelect={run(() => actions.agentSettings(agent.id))} />
      <MenuDivider />
      <MenuRow icon={Trash2} danger title="Remove agent…" hint="Stops it and deletes its transcript." onSelect={run(() => actions.removeAgent(agent.id))} />
    </SidebarMenu>
  );
}

function ProjectMenu({ project, agentCount, anchor, actions, onClose }: { project: Project; agentCount: number; anchor: MenuAnchor; actions: SidebarActions; onClose: () => void }) {
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <SidebarMenu anchor={anchor} onClose={onClose}>
      <MenuLabel>{project.name}</MenuLabel>
      <MenuRow icon={Plus} title="New agent" onSelect={run(() => actions.newAgent(project.id))} />
      <MenuRow icon={Terminal} title="Open terminal" hint={`A shell in ${project.name}'s folder.`} disabled={!project.exists} onSelect={run(() => showTerminal(project.id))} />
      <MenuDivider />
      <MenuRow
        icon={Trash2}
        danger
        title="Remove project"
        hint={agentCount ? 'Remove its agents first.' : 'Files stay on disk.'}
        disabled={agentCount > 0}
        onSelect={run(() => void attempt(() => api.removeProject(project.id)))}
      />
    </SidebarMenu>
  );
}

function ChannelMenu({ channel, anchor, actions, onClose }: { channel: Channel; anchor: MenuAnchor; actions: SidebarActions; onClose: () => void }) {
  const layout = useLayout();
  const tab = layout.tabs.find(t => t.content.kind === 'channel' && t.content.channelId === channel.id);
  const run = (action: () => void) => () => { onClose(); action(); };
  return (
    <SidebarMenu anchor={anchor} onClose={onClose}>
      <MenuLabel>#{channel.name}</MenuLabel>
      <MenuRow icon={SplitColumns} title="Open to the side" onSelect={run(() => openToSide({ kind: 'channel', channelId: channel.id }))} />
      {tab ? <MenuRow icon={X} title="Close tab" hint="The channel and its posts stay." onSelect={run(() => closeTab(tab.id))} /> : null}
      <MenuDivider />
      <MenuRow icon={Settings} title="Channel settings" hint="Name, topic and members." onSelect={run(() => actions.channelSettings(channel.id))} />
    </SidebarMenu>
  );
}

/** Whether members are working in a channel right now, and whether one of them waits on you. */
function useChannelActivity(channelId: string): { working: boolean; waiting: boolean } {
  const working = useApp(s => Boolean(s.snapshot?.agents.some(a => a.currentTask?.channelId === channelId && a.status === 'working')));
  const waiting = useApp(s => Boolean(s.snapshot?.agents.some(a => a.currentTask?.channelId === channelId && a.status === 'waiting')));
  return { working, waiting };
}

/** The accent dot for news you have not opened yet. */
function UnreadDot() {
  return <span role="img" className="size-1.5 shrink-0 rounded-full bg-accent" title="Unread" aria-label="Unread" />;
}

/** Agent status at the end of a card: MonoCode's terminal spinner, unread dot, or words. */
function StatusMark({ agent, pending }: { agent: Agent; pending: boolean }) {
  if (pending || agent.status === 'waiting') return <StatusLabel tone="warning" className="text-[11px] font-medium">Needs you</StatusLabel>;
  if (agent.status === 'working') return <TerminalSpinner className="text-content/55" />;
  if (agent.status === 'error') return <StatusLabel tone="danger" className="text-[11px]">Failed</StatusLabel>;
  if (agent.unread) return <UnreadDot />;
  return null;
}

/** A session card in MonoCode's sidebar: engine and model, title, then branch and status. */
function AgentCard({ agent, selected, now, actions }: { agent: Agent; selected: boolean; now: number; actions: SidebarActions }) {
  const models = useApp(s => s.snapshot?.models[agent.engine]);
  const pending = useApp(s => Boolean(s.snapshot?.approvals.some(a => a.agentId === agent.id)));
  const from = useApp(s => (agent.currentTask?.source === 'agent' ? s.snapshot?.agents.find(a => a.id === agent.currentTask?.fromAgentId)?.name : undefined));
  const projects = useApp(s => s.snapshot?.projects);
  const where = whereabouts(agent, projects);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const task = agent.status === 'error' && agent.error ? agent.error : agent.currentTask?.summary || agent.lastSummary || 'No task yet';
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id })}
        title="Click to open, Cmd+click to open beside, right-click for more"
        aria-current={selected ? 'page' : undefined}
        className={cx('flex w-full flex-col rounded-md border border-transparent px-2.5 py-2 text-left font-sans transition-colors duration-100', selected || menu ? 'bg-selection text-content' : 'text-content/80 hover:bg-content/5 hover:text-content')}
      >
        {/* MonoCode's session card: engine and model, then the name, then what it is on. */}
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <EngineIcon engine={agent.engine} className="size-3.5" />
            <span className="min-w-0 truncate text-[11px] text-content/50">{modelLabel(agent, models)}</span>
          </span>
          {/* The ... button takes this spot on hover. */}
          <span className={cx('shrink-0 text-[11px] tabular-nums text-content/45 group-hover:invisible group-has-[[data-card-more]:focus-visible]:invisible', menu && 'invisible')}>{relativeTime(agent.lastActiveAt, now)}</span>
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-[13px] font-semibold leading-snug text-content">{agent.name}</span>
          <span className="shrink-0 text-[11px] text-content/40">{rolePreset(agent.role).name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {agent.queued > 0 ? <span className="rounded-full bg-content/10 px-1.5 text-[10px] tabular-nums text-content/70" title={`${agent.queued} ${agent.queued === 1 ? 'message' : 'messages'} waiting`}>{agent.queued}</span> : null}
            <StatusMark agent={agent} pending={pending} />
          </span>
        </span>
        <span className={cx('mt-1 min-w-0 truncate text-[12px] leading-snug', agent.currentTask ? 'text-content/70' : 'text-content/45')}>
          {from ? <span className="text-content/50">from {from}: </span> : null}
          {task}
        </span>
        {where && (where.branch || !where.own) ? (
          <span className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-content/45" title={`Working in ${where.project}${where.branch ? ` on ${where.branch}` : ''}`}>
            <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
            {/* The card sits under its own project already, so only another project is named. */}
            {where.own ? null : <span className="max-w-[60%] shrink-0 truncate text-content/60">{where.project}</span>}
            {where.own || !where.branch ? null : <span aria-hidden className="shrink-0 text-content/25">/</span>}
            {where.branch ? <span className="min-w-0 truncate">{where.branch}</span> : null}
          </span>
        ) : agent.status === 'working' && agent.activity ? <span className="mt-1 min-w-0 truncate text-[11px] text-content/45">{agent.activity}</span> : null}
      </button>
      <button
        type="button"
        data-card-more
        aria-label={`${agent.name} actions`}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={e => toggleMenu(e, setMenu)}
        className={cx(
          'absolute right-1.5 top-1.5 grid size-5 place-items-center rounded text-content/55 transition-opacity duration-150 hover:bg-content/10 hover:text-content focus-visible:opacity-100',
          menu ? 'bg-content/10 opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
      </button>
      {menu ? <AgentMenu agent={agent} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

function TreeNode({ root, entry, depth }: { root: Root; entry: TreeEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeEntry[] | null>(null);
  const toggle = async () => {
    if (!entry.dir) {
      open({ kind: 'file', root, path: entry.path });
      return;
    }
    if (!expanded && !children) {
      const listing = await attempt(() => api.tree(root, entry.path));
      setChildren(listing?.entries ?? []);
    }
    setExpanded(e => !e);
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={entry.dir ? expanded : undefined}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left font-sans text-[13px] text-content/80 transition-colors duration-100 hover:bg-content/5 hover:text-content"
      >
        {entry.dir
          ? <>{expanded ? <ChevronDown className="size-3 shrink-0 text-content/40" strokeWidth={1.75} /> : <ChevronRight className="size-3 shrink-0 text-content/40" strokeWidth={1.75} />}{expanded ? <FolderOpen className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} /> : <Folder className="size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />}</>
          : <><span className="w-3 shrink-0" /><File className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} /></>}
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      {expanded && children?.map(child => <TreeNode key={child.path} root={root} entry={child} depth={depth + 1} />)}
      {expanded && children && !children.length ? <p style={{ paddingLeft: 32 + depth * 12 }} className="py-0.5 text-[12px] text-content/35">Empty</p> : null}
    </>
  );
}

/** The Files view: the project's folder, or one of its agents' workspaces. `projectId` limits the choice. */
function FileTree({ projectId }: { projectId?: string }) {
  const layout = useLayout();
  const agents = useApp(s => s.snapshot?.agents);
  const projects = useApp(s => s.snapshot?.projects);
  const home = useApp(s => s.snapshot?.home);
  const focused = focusedAgentId(layout);
  const [choice, setChoice] = useState<string | null>(null);
  const options = useMemo(() => [
    ...(agents ?? []).filter(a => !projectId || a.projectId === projectId).map(a => ({ value: `a:${a.id}`, root: { agent: a.id } as Root, label: `${a.name}'s workspace`, detail: a.worktree?.branch ?? '' })),
    ...(projects ?? []).filter(p => !projectId || p.id === projectId).map(p => ({ value: `p:${p.id}`, root: { project: p.id } as Root, label: p.name, detail: shortPath(p.path, home) })),
  ], [agents, projects, home, projectId]);
  // Follow the focused agent unless the user picked a root.
  const current = options.find(o => o.value === choice) ?? options.find(o => o.value === `a:${focused}`) ?? options.find(o => o.value.startsWith('p:'));
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = current?.value;

  useEffect(() => {
    if (!current) return;
    let live = true;
    setEntries(null);
    setError(null);
    api.tree(current.root).then(listing => { if (live) setEntries(listing.entries); }, err => { if (live) setError((err as Error).message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!current) return <Empty icon={Folder} title="No project yet" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center border-b border-stroke px-2 [&>div]:w-full [&>div]:max-w-none">
        <Select
          label="Browse"
          value={current.value}
          options={options.map(o => ({ value: o.value, label: o.label, icon: o.value.startsWith('a:') ? <GitBranch className="size-3.5 text-content/50" strokeWidth={1.75} /> : <Folder className="size-3.5 text-content/50" strokeWidth={1.75} /> }))}
          onChange={setChoice}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error ? <p className="px-2 py-2 font-sans text-[12px] text-danger">{error}</p>
          : !entries ? <Loading className="px-2 py-2" />
          : entries.map(entry => <TreeNode key={`${current.value}:${entry.path}`} root={current.root} entry={entry} depth={0} />)}
      </div>
    </div>
  );
}

// ---- MonoCode's Classic shell: a navigation column, then the workspace column ----------------

/** A row at the top or foot of the navigation column: MonoCode's RailAction. */
function RailAction({ icon: Icon, label, hint, active = false, onClick, children }: { icon: IconComponent; label: string; hint?: string; active?: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150', active ? 'bg-selection text-content' : 'text-content/75 hover:bg-content/10 hover:text-content')}
    >
      <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{label}</span>
      {children}
      {/* MonoCode's shortcut hint at the end of the row, as in "Settings ⌘,". */}
      {hint ? <kbd className="shrink-0 font-sans text-[11px] text-content/40">{hint}</kbd> : null}
    </button>
  );
}

/** A titled list in the navigation column, with MonoCode's quiet + beside the title. */
function RailSection({ title, addLabel, onAdd, children }: { title: string; addLabel: string; onAdd: () => void; children: ReactNode }) {
  return (
    <section aria-label={title} className="mb-2 shrink-0">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1">
        <h2 className="min-w-0 flex-1 truncate px-1 text-xs font-normal leading-5 text-content/50">{title}</h2>
        <button type="button" title={addLabel} aria-label={addLabel} onClick={onAdd} className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 transition-colors duration-150 hover:bg-content/8 hover:text-content">
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex flex-col gap-px px-2">{children}</div>
    </section>
  );
}

/** The single row of an empty rail section: a quiet way to add the first one. */
function RailEmptyRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-content/45 transition-colors duration-150 hover:bg-content/5 hover:text-content">
      <Plus className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate leading-tight">{label}</span>
    </button>
  );
}

/** A rail row makes room at its end only for a status mark, or for the ... button while hovered (MonoCode's group-hover:pr-6). */
function railRow(reserve: boolean): string {
  return cx(
    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-[background-color,color,padding] duration-150 group-hover:pr-7 group-focus-within:pr-7',
    reserve && 'pr-7',
  );
}

function railRowState(selected: boolean): string {
  return selected ? 'bg-selection-strong text-content' : 'text-content/65 hover:bg-content/5 hover:text-content';
}

/** The ... at the end of a rail row: shows on hover or focus, and stays while its menu is open. */
function RowMore({ label, open: isOpen, onClick }: { label: string; open: boolean; onClick: (e: MouseEvent<HTMLElement>) => void }) {
  return (
    <button
      type="button"
      data-card-more
      aria-label={label}
      title="More actions"
      aria-haspopup="menu"
      aria-expanded={isOpen}
      onClick={onClick}
      className={cx(
        'absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-content/55 transition-opacity duration-150 hover:bg-content/8 hover:text-content focus-visible:opacity-100',
        isOpen ? 'bg-content/8 opacity-100' : 'opacity-0 group-hover:opacity-100',
      )}
    >
      <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

/** The end of a rail row: a status mark that gives way to the ... button on hover. */
function RowStatus({ hidden, children }: { hidden: boolean; children: ReactNode }) {
  return (
    <span className={cx('pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center group-hover:invisible group-has-[[data-card-more]:focus-visible]:invisible', hidden && 'invisible')}>
      {children}
    </span>
  );
}

/** The warning dot a row shows while an agent there waits on you. */
function NeedsYouDot() {
  return <span role="img" aria-label="Needs you" title="Needs you" className="size-1.5 shrink-0 rounded-full bg-warning" />;
}

/** NeedsYouDot's danger twin, for an agent whose last turn failed. */
function FailedDot() {
  return <span role="img" aria-label="Failed" title="Failed" className="size-1.5 shrink-0 rounded-full bg-danger" />;
}

/** Whether an approval or question from this agent waits on you. */
function usePendingApproval(agentId: string): boolean {
  return useApp(s => Boolean(s.snapshot?.approvals.some(a => a.agentId === agentId)));
}

/** Opens an agent with no project from the navigation column; the workspace column keeps its project. */
function openRailAgent(agent: Agent, e: MouseEvent<HTMLElement>): void {
  (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id });
}

/** An agent's status at the end of a rail row or in a rail icon's corner; `compact` swaps the spinner for a dot. */
function AgentRailMark({ status, compact = false }: { status: RailAgentStatus; compact?: boolean }) {
  switch (status) {
    case 'needs-you': return <NeedsYouDot />;
    case 'working': return compact ? <WorkingDot /> : <TerminalSpinner className="text-content/55" />;
    case 'failed': return <FailedDot />;
    case 'unread': return <UnreadDot />;
    default: return null;
  }
}

/** An agent with no project in the navigation column: its engine and name; it works across all projects. */
function AgentRailRow({ agent, selected, actions }: { agent: Agent; selected: boolean; actions: SidebarActions }) {
  const status = railAgentStatus(agent, usePendingApproval(agent.id));
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={e => openRailAgent(agent, e)}
        title={`${agent.name}, works across all projects. Click to open, Cmd+click to open beside, right-click for more.`}
        aria-current={selected ? 'page' : undefined}
        className={cx(railRow(status !== null || Boolean(menu)), railRowState(selected || Boolean(menu)))}
      >
        <EngineIcon engine={agent.engine} className="size-4 shrink-0" />
        <span className={cx('min-w-0 flex-1 truncate text-sm leading-tight', agent.unread ? 'font-semibold text-content' : 'font-medium')}>{agent.name}</span>
      </button>
      <RowStatus hidden={Boolean(menu)}><AgentRailMark status={status} /></RowStatus>
      <RowMore label={`${agent.name} actions`} open={Boolean(menu)} onClick={e => toggleMenu(e, setMenu)} />
      {menu ? <AgentMenu agent={agent} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/** A channel in the navigation column: a spinner while members work on it, a dot for unread replies. */
function ChannelRailRow({ channel, selected, actions }: { channel: Channel; selected: boolean; actions: SidebarActions }) {
  const { working, waiting } = useChannelActivity(channel.id);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'channel', channelId: channel.id })}
        title={`${channel.topic || `#${channel.name}`}. Click to open, Cmd+click to open beside, right-click for more.`}
        aria-current={selected ? 'page' : undefined}
        className={cx(railRow(waiting || working || channel.unread || Boolean(menu)), railRowState(selected || Boolean(menu)))}
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-[14px] leading-none opacity-70">#</span>
        <span className={cx('min-w-0 flex-1 truncate text-sm leading-tight', channel.unread ? 'font-semibold text-content' : 'font-medium')}>{channel.name}</span>
      </button>
      <RowStatus hidden={Boolean(menu)}>
        {waiting ? <NeedsYouDot /> : working ? <TerminalSpinner className="text-content/55" /> : channel.unread ? <UnreadDot /> : null}
      </RowStatus>
      <RowMore label={`#${channel.name} actions`} open={Boolean(menu)} onClick={e => toggleMenu(e, setMenu)} />
      {menu ? <ChannelMenu channel={channel} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/**
 * Selects a project: its agents fill the workspace column. A project with no agents has no
 * workspace column, so selecting it offers to add its first agent instead.
 */
function selectProject(project: Project, agentCount: number, actions: SidebarActions): void {
  setProject(project.id);
  if (!agentCount && project.exists) actions.newAgent(project.id);
}

/** A project in the navigation column: selecting it fills the workspace column with its agents. */
function ProjectRailRow({ project, agents, selected, actions }: { project: Project; agents: Agent[]; selected: boolean; actions: SidebarActions }) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const waiting = agents.some(a => a.status === 'waiting');
  const working = agents.some(a => a.status === 'working');
  const Icon = selected ? FolderOpen : Folder;
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={() => selectProject(project, agents.length, actions)}
        title={project.path}
        aria-current={selected ? 'true' : undefined}
        className={cx(railRow(!project.exists || waiting || working || Boolean(menu)), railRowState(selected || Boolean(menu)))}
      >
        <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{project.name}</span>
      </button>
      <RowStatus hidden={Boolean(menu)}>
        {!project.exists ? <span className="text-[11px] text-danger">missing</span>
          : waiting ? <NeedsYouDot />
          : working ? <TerminalSpinner className="text-content/55" /> : null}
      </RowStatus>
      <RowMore label={`${project.name} actions`} open={Boolean(menu)} onClick={e => toggleMenu(e, setMenu)} />
      {menu ? <ProjectMenu project={project} agentCount={agents.length} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/** The navigation column: New agent and Comms, channels, agents with no project, projects, and Settings at the foot. */
function NavRail({ actions, projectId }: { actions: SidebarActions; projectId: string | undefined }) {
  const layout = useLayout();
  const channels = useApp(s => s.snapshot?.channels);
  const projects = useApp(s => s.snapshot?.projects);
  const agents = useApp(s => s.snapshot?.agents);
  const inFlight = useApp(s => s.snapshot?.messages.filter(m => !m.channelId && (m.status === 'queued' || m.status === 'delivering')).length ?? 0);
  const waiting = useApp(s => s.snapshot?.profile.proposals.length ?? 0);
  const focusedPane = layout.panes.find(p => p.id === layout.focused);
  const commsOpen = layout.tabs.find(t => t.id === focusedPane?.tabId)?.content.kind === 'comms';
  const channelId = focusedChannelId(layout);
  const sorted = useMemo(() => [...(channels ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [channels]);
  const listed = useMemo(() => railAgents(agents ?? []), [agents]);
  const agentId = focusedAgentId(layout);
  const superId = useApp(s => s.snapshot?.super.agentId ?? null);
  const superWaiting = useApp(s => openAsks(s.snapshot?.super.asks).length);
  const column = useColumnWidth('nav', 200, 168, 0.3);
  return (
    <nav aria-label="AgentsCode" style={{ width: column.width }} className="sidebar-glass relative flex shrink-0 flex-col border-r border-stroke font-sans">
      {/* In the desktop app the traffic lights take the brand's place, as in MonoCode. */}
      <div data-window-drag className="flex h-10 shrink-0 items-center gap-2 pl-3.5 pr-1.5 desktop:pl-[76px]">
        <span className="flex min-w-0 flex-1 items-center gap-2 desktop:invisible">
          <BrandMark />
          <span className="min-w-0 truncate text-[13px] font-semibold text-content/85">AgentsCode</span>
        </span>
        <HeaderButton icon={PanelLeft} label="Collapse navigation" onClick={() => setRail(false)} />
      </div>
      <div className="flex shrink-0 flex-col gap-px px-2 pb-2 pt-0.5">
        <RailAction icon={Plus} label="New agent" hint={SHORTCUTS.newAgent} onClick={() => actions.newAgent(projectId)} />
        <RailAction icon={Search} label="Search" hint={SHORTCUTS.palette} onClick={actions.palette} />
        <RailAction icon={MessageMultiple} label="Comms" active={commsOpen} onClick={() => open({ kind: 'comms' })}>
          {inFlight ? <span className="shrink-0 text-[11px] tabular-nums text-content/40" title={`${inFlight} in flight`}>{inFlight}</span> : null}
        </RailAction>
        <RailAction icon={Sparkles} label="SuperAgent" hint={SHORTCUTS.superQuick} active={Boolean(superId) && agentId === superId} onClick={() => void openSuper()}>
          {superWaiting ? <span className="shrink-0 text-[11px] tabular-nums text-content/40" title={`${superWaiting} waiting for you`}>{superWaiting}</span> : null}
        </RailAction>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2">
        <RailSection title="Channels" addLabel="New channel" onAdd={actions.newChannel}>
          {sorted.map(channel => <ChannelRailRow key={channel.id} channel={channel} selected={channel.id === channelId} actions={actions} />)}
          {channels && !channels.length ? <RailEmptyRow label="New channel" onClick={actions.newChannel} /> : null}
        </RailSection>
        {/* Agents with no project, which work across all of them; a project's agents are in its workspace column. */}
        <RailSection title="Agents" addLabel="New agent with no project" onAdd={() => actions.newAgent(null)}>
          {listed.map(agent => <AgentRailRow key={agent.id} agent={agent} selected={agent.id === agentId} actions={actions} />)}
          {agents && !listed.length ? <RailEmptyRow label="New agent" onClick={() => actions.newAgent(null)} /> : null}
        </RailSection>
        <RailSection title="Projects" addLabel="Add project" onAdd={actions.addProject}>
          {(projects ?? []).map(project => (
            <ProjectRailRow key={project.id} project={project} agents={(agents ?? []).filter(a => a.projectId === project.id)} selected={project.id === projectId} actions={actions} />
          ))}
          {projects && !projects.length ? <RailEmptyRow label="Add project" onClick={actions.addProject} /> : null}
        </RailSection>
      </div>
      <SidebarUpdateFooter />
      <div className="flex shrink-0 flex-col gap-px p-2">
        <RailAction icon={StickyNote} label="About you" onClick={actions.profile}>
          {waiting ? <span className="shrink-0 text-[11px] tabular-nums text-content/40" title={`${waiting} waiting for your approval`}>{waiting}</span> : null}
        </RailAction>
        <RailAction icon={Settings} label="Settings" hint={SHORTCUTS.settings} onClick={actions.settings} />
      </div>
      <ResizeHandle column={column} edge="right" label="Resize navigation" />
    </nav>
  );
}

/** The workspace column's title: the project's name, opening a list of projects to switch to. */
function ProjectSwitcher({ project, projects, actions }: { project: Project; projects: Project[]; actions: SidebarActions }) {
  const home = useApp(s => s.snapshot?.home);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const run = (action: () => void) => () => { setMenu(null); action(); };
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        title={`${project.path}. Switch project.`}
        onClick={e => toggleMenu(e, setMenu)}
        className="-ml-1.5 flex h-6.5 min-w-0 max-w-full items-center gap-2 rounded-md px-1.5 text-sm font-medium leading-tight text-content transition-colors duration-150 hover:bg-content/8 aria-expanded:bg-content/8"
      >
        <span className="min-w-0 truncate">{project.name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
      </button>
      {menu ? (
        <SidebarMenu anchor={menu} onClose={() => setMenu(null)}>
          <MenuLabel>Projects</MenuLabel>
          {projects.map(p => <MenuRow key={p.id} icon={Folder} title={p.name} hint={shortPath(p.path, home)} selected={p.id === project.id} onSelect={run(() => setProject(p.id))} />)}
          <MenuDivider />
          <MenuRow icon={FolderPlus} title="Add project" onSelect={run(actions.addProject)} />
        </SidebarMenu>
      ) : null}
    </>
  );
}

const WORKSPACE_VIEWS: { value: Layout['sidebarView']; label: string }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'files', label: 'Files' },
  { value: 'changes', label: 'Changes' },
];

/**
 * The workspace column: the selected project's agents, files and changes, as MonoCode's sessions
 * column. Sidebars leaves it out for a project with no agents (see showsWorkspace). Its header lines up with whatever stands beside it: the 40px tab strip, or, when the
 * strip spans the window above (`titleBarAbove`), the panes' 36px headers.
 */
function WorkspaceColumn({ actions, project, titleBarAbove }: { actions: SidebarActions; project: Project | undefined; titleBarAbove: boolean }) {
  const layout = useLayout();
  const projects = useApp(s => s.snapshot?.projects);
  const agents = useApp(s => s.snapshot?.agents);
  const now = useNow();
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const selected = focusedAgentId(layout);
  const mine = useMemo(() => (agents ?? []).filter(a => a.projectId === project?.id).sort((a, b) => a.createdAt - b.createdAt), [agents, project?.id]);
  const column = useColumnWidth('workspace', window.innerWidth < 1200 ? 240 : 260, 220, 0.4);

  if (!project) {
    return (
      <aside aria-label="Workspace" style={{ width: column.width }} className="body-glass relative flex shrink-0 flex-col border-r border-stroke font-sans">
        <div data-window-drag className={cx('shrink-0 border-b border-stroke', titleBarAbove ? 'h-9' : 'h-10')} />
        <Empty icon={FolderPlus} title="Open a project folder" action={<SecondaryButton onClick={actions.addProject}><FolderPlus className="size-3.5" strokeWidth={1.75} /> Add project</SecondaryButton>}>
          Agents work inside a project folder. Add one to start.
        </Empty>
      </aside>
    );
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? mine.filter(a => [a.name, rolePreset(a.role).name, a.currentTask?.summary ?? '', a.lastSummary ?? ''].some(text => text.toLowerCase().includes(q)))
    : mine;
  // Changes follow the focused agent when it is in this project, else its most recently active one.
  const changesAgent = mine.find(a => a.id === selected) ?? [...mine].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];

  return (
    <aside aria-label={`${project.name} workspace`} style={{ width: column.width }} className="body-glass relative flex shrink-0 flex-col border-r border-stroke font-sans">
      <ResizeHandle column={column} edge="right" label="Resize workspace" />
      <div data-window-drag className={cx('flex shrink-0 items-center gap-1 border-b border-stroke pl-3 pr-1.5', titleBarAbove ? 'h-9' : 'h-10')}>
        <div className="flex min-w-0 flex-1 items-center">
          <ProjectSwitcher project={project} projects={projects ?? []} actions={actions} />
        </div>
        <HeaderButton icon={MoreHorizontal} label={`${project.name} actions`} aria-haspopup="menu" aria-expanded={Boolean(menu)} onClick={e => toggleMenu(e, setMenu)} />
        <HeaderButton icon={Plus} label={`New agent in ${project.name}`} onClick={() => actions.newAgent(project.id)} />
      </div>
      {menu ? <ProjectMenu project={project} agentCount={mine.length} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
      <div role="radiogroup" aria-label="Workspace view" className="flex h-9 shrink-0 items-center gap-px border-b border-stroke px-2">
        {WORKSPACE_VIEWS.map(view => {
          const active = layout.sidebarView === view.value;
          return (
            <button
              key={view.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSidebarView(view.value)}
              className={cx('flex h-6 min-w-0 flex-1 items-center justify-center rounded-md px-2 text-[12px] leading-none transition-colors duration-150', active ? 'bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content')}
            >
              <span className="block truncate">{view.label}</span>
            </button>
          );
        })}
      </div>
      {layout.sidebarView === 'files' ? <FileTree key={project.id} projectId={project.id} />
        : layout.sidebarView === 'changes' ? <ChangesView agent={changesAgent} />
        : (
          <>
            <div className="flex h-9 shrink-0 items-center border-b border-stroke px-2">
              <label className="relative flex h-7 min-w-0 flex-1 items-center">
                <Search aria-hidden className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" strokeWidth={1.75} />
                <input
                  type="search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Filter agents…"
                  aria-label="Filter agents"
                  className="h-full w-full min-w-0 rounded-md bg-transparent py-0 pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/35"
                />
              </label>
            </div>
            <div className="sidebar-session-scroll min-h-0 flex-1 overflow-y-auto overscroll-none">
              <div className="flex flex-col gap-0.5 p-1.5 pb-10">
                {shown.map(agent => <AgentCard key={agent.id} agent={agent} selected={agent.id === selected} now={now} actions={actions} />)}
                {!mine.length ? (
                  <button type="button" onClick={() => actions.newAgent(project.id)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-content/50 transition-colors duration-100 hover:bg-content/5 hover:text-content">
                    <Plus className="size-3.5" strokeWidth={1.75} /> Add an agent
                  </button>
                ) : !shown.length ? <p className="px-2.5 py-2 text-[12px] text-content/40">No agents match “{query.trim()}”.</p> : null}
              </div>
            </div>
          </>
        )}
    </aside>
  );
}

/** A button in the folded navigation rail: an icon, its name as the tooltip, and a status dot in the corner. */
function RailIconButton({ label, active = false, dot, onClick, onContextMenu, children }: {
  label: string;
  active?: boolean;
  dot?: ReactNode;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cx('relative grid size-8 shrink-0 place-items-center rounded-md transition-colors duration-150', active ? 'bg-selection-strong text-content' : 'text-content/60 hover:bg-content/10 hover:text-content')}
    >
      {children}
      {dot ? <span className="absolute right-1 top-1 flex">{dot}</span> : null}
    </button>
  );
}

/** A working mark small enough for a rail corner. */
function WorkingDot() {
  return <span role="img" aria-label="Working" title="Working" className="size-1.5 shrink-0 animate-pulse rounded-full bg-content/55 motion-reduce:animate-none" />;
}

function ChannelRailIcon({ channel, selected, actions }: { channel: Channel; selected: boolean; actions: SidebarActions }) {
  const { working, waiting } = useChannelActivity(channel.id);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <RailIconButton
        label={`#${channel.name}`}
        active={selected || Boolean(menu)}
        dot={waiting ? <NeedsYouDot /> : working ? <WorkingDot /> : channel.unread ? <UnreadDot /> : null}
        onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'channel', channelId: channel.id })}
        onContextMenu={e => openContextMenu(e, setMenu)}
      >
        <span aria-hidden className="text-[15px] leading-none">#</span>
      </RailIconButton>
      {menu ? <ChannelMenu channel={channel} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function AgentRailIcon({ agent, selected, actions }: { agent: Agent; selected: boolean; actions: SidebarActions }) {
  const status = railAgentStatus(agent, usePendingApproval(agent.id));
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <RailIconButton
        label={`${agent.name}, works across all projects`}
        active={selected || Boolean(menu)}
        dot={<AgentRailMark status={status} compact />}
        onClick={e => openRailAgent(agent, e)}
        onContextMenu={e => openContextMenu(e, setMenu)}
      >
        <EngineIcon engine={agent.engine} className="size-4" />
      </RailIconButton>
      {menu ? <AgentMenu agent={agent} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function ProjectRailIcon({ project, agents, selected, actions }: { project: Project; agents: Agent[]; selected: boolean; actions: SidebarActions }) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const waiting = agents.some(a => a.status === 'waiting');
  const working = agents.some(a => a.status === 'working');
  const Icon = selected ? FolderOpen : Folder;
  return (
    <>
      <RailIconButton
        label={project.name}
        active={selected || Boolean(menu)}
        dot={waiting ? <NeedsYouDot /> : working ? <WorkingDot /> : null}
        onClick={() => selectProject(project, agents.length, actions)}
        onContextMenu={e => openContextMenu(e, setMenu)}
      >
        <Icon className="size-4" strokeWidth={1.75} />
      </RailIconButton>
      {menu ? <ProjectMenu project={project} agentCount={agents.length} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/**
 * The navigation folded to icons, for narrow windows: everything stays one click away, names in
 * tooltips. As MonoCode's compact rail: an empty header lines up with the columns beside it, or
 * none when the desktop app's tab strip spans the window above (`titleBarAbove`).
 */
function CompactRail({ actions, projectId, titleBarAbove }: { actions: SidebarActions; projectId: string | undefined; titleBarAbove: boolean }) {
  const layout = useLayout();
  const channels = useApp(s => s.snapshot?.channels);
  const projects = useApp(s => s.snapshot?.projects);
  const agents = useApp(s => s.snapshot?.agents);
  const inFlight = useApp(s => s.snapshot?.messages.filter(m => !m.channelId && (m.status === 'queued' || m.status === 'delivering')).length ?? 0);
  const superWaiting = useApp(s => openAsks(s.snapshot?.super.asks).length);
  const update = useDesktopUpdate();
  const focusedPane = layout.panes.find(p => p.id === layout.focused);
  const commsOpen = layout.tabs.find(t => t.id === focusedPane?.tabId)?.content.kind === 'comms';
  const channelId = focusedChannelId(layout);
  const sorted = useMemo(() => [...(channels ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [channels]);
  const listed = useMemo(() => railAgents(agents ?? []), [agents]);
  const agentId = focusedAgentId(layout);
  // Channels, agents, then projects, with a divider between groups that have something in them.
  const groups = [
    sorted.map(channel => <ChannelRailIcon key={channel.id} channel={channel} selected={channel.id === channelId} actions={actions} />),
    listed.map(agent => <AgentRailIcon key={agent.id} agent={agent} selected={agent.id === agentId} actions={actions} />),
    (projects ?? []).map(project => (
      <ProjectRailIcon key={project.id} project={project} agents={(agents ?? []).filter(a => a.projectId === project.id)} selected={project.id === projectId} actions={actions} />
    )),
  ].filter(group => group.length);
  return (
    <nav aria-label="AgentsCode" className="sidebar-glass relative flex w-12 shrink-0 flex-col items-center font-sans">
      {titleBarAbove ? null : <div data-window-drag className="h-10 w-full shrink-0 border-b border-stroke" />}
      {/* The edge starts under the header, so the header row reads as one band with the workspace's. */}
      <span aria-hidden className={cx('pointer-events-none absolute bottom-0 right-0 w-px bg-stroke', titleBarAbove ? 'top-0' : 'top-10')} />
      <div className="flex shrink-0 flex-col items-center gap-0.5 py-1.5">
        <RailIconButton label="Expand navigation" onClick={() => setRail(true)}><PanelLeft className="size-4" strokeWidth={1.75} /></RailIconButton>
        <RailIconButton label={`New agent (${SHORTCUTS.newAgent})`} onClick={() => actions.newAgent(projectId)}><Plus className="size-4" strokeWidth={1.75} /></RailIconButton>
        <RailIconButton label={`Search (${SHORTCUTS.palette})`} onClick={actions.palette}><Search className="size-4" strokeWidth={1.75} /></RailIconButton>
        <RailIconButton label={inFlight ? `Comms, ${inFlight} in flight` : 'Comms'} active={commsOpen} dot={inFlight ? <span className="size-1.5 rounded-full bg-accent" /> : null} onClick={() => open({ kind: 'comms' })}>
          <MessageMultiple className="size-4" strokeWidth={1.75} />
        </RailIconButton>
        <RailIconButton label={superWaiting ? `SuperAgent, ${superWaiting} waiting for you` : 'SuperAgent'} dot={superWaiting ? <span className="size-1.5 rounded-full bg-accent" /> : null} onClick={() => void openSuper()}>
          <Sparkles className="size-4" strokeWidth={1.75} />
        </RailIconButton>
      </div>
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto overscroll-none border-t border-stroke py-2">
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index ? <span aria-hidden className="my-1 h-px w-5 shrink-0 bg-stroke" /> : null}
            {group}
          </Fragment>
        ))}
      </div>
      <div className="flex shrink-0 flex-col items-center gap-0.5 pb-2 pt-1">
        {update && isUpdateActionable(update) ? (
          <RailIconButton
            label={`${updateLabel(update)} (you have v${update.currentVersion})`}
            dot={<span className="size-1.5 rounded-full bg-accent" />}
            onClick={() => void window.agentscodeDesktop?.updates?.install()}
          >
            <ArrowDownCircle className="size-4 text-accent" strokeWidth={1.75} />
          </RailIconButton>
        ) : null}
        <RailIconButton label="About you" onClick={actions.profile}><StickyNote className="size-4" strokeWidth={1.75} /></RailIconButton>
        <RailIconButton label={`Settings (${SHORTCUTS.settings})`} onClick={actions.settings}><Settings className="size-4" strokeWidth={1.75} /></RailIconButton>
      </div>
    </nav>
  );
}

/** Whether the navigation column shows in full: the user's pick, else folded below 1280px. */
export function useNavFull(): boolean {
  const rail = useLayout().rail;
  const width = useWindowWidth();
  return rail ?? width >= 1280;
}

/**
 * MonoCode's Classic sidebar: the navigation column, then the workspace column for the
 * selected project when it has agents of its own. Opening an agent from elsewhere (a tab, a
 * channel) brings its project in. `titleBarAbove`: the tab strip spans the window over both
 * (the desktop app, folded).
 */
export function Sidebars({ actions, titleBarAbove }: { actions: SidebarActions; titleBarAbove: boolean }) {
  const layout = useLayout();
  const projects = useApp(s => s.snapshot?.projects);
  const agents = useApp(s => s.snapshot?.agents);
  // App brings the focused agent's project in (setProject), for this column and the terminal.
  const project = projects?.find(p => p.id === layout.projectId) ?? projects?.[0];
  const full = useNavFull();
  return (
    <div className="flex h-full shrink-0">
      {full ? <NavRail actions={actions} projectId={project?.id} /> : <CompactRail actions={actions} projectId={project?.id} titleBarAbove={titleBarAbove} />}
      {showsWorkspace(agents ?? [], project?.id) ? <WorkspaceColumn actions={actions} project={project} titleBarAbove={titleBarAbove} /> : null}
    </div>
  );
}
