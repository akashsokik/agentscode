import { Fragment, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import type { Agent, Channel, Project, TreeEntry } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { api, type Root } from '../api.ts';
import { modelLabel, relativeTime, shortPath } from '../format.ts';
import { closeTab, focusedAgentId, focusedChannelId, focusedKind, open, openToSide, setProject, setRail, setSectionFolded, setSidebarView, useLayout, type Layout, type RailSectionKey } from '../layout.ts';
import { ChangesView } from '../right/RightPanel.tsx';
import { attempt, useApp } from '../store.ts';
import { whereabouts } from '../whereabouts.ts';
import { BrandMark } from '../ui/BrandMark.tsx';
import { SidebarUpdateFooter, useDesktopUpdate } from './SidebarUpdate.tsx';
import { isUpdateActionable, updateLabel } from '../../shared/updates.ts';
import { DreamNowMenuRow } from '../ui/DreamNowMenuRow.tsx';
import { ResizeHandle, useColumnWidth, useWindowWidth } from '../ui/ResizeHandle.tsx';
import { SHORTCUTS, SHORTCUT_KEYS, MOD_CLICK } from '../shortcuts.ts';
import type { KeySpec } from '../keys.ts';
import { Kbd } from '../ui/Kbd.tsx';
import { showTerminal } from '../terminal/actions.ts';
import { openCount, usePrs, usePrsData } from '../prs/prsData.ts';
import { cx, Empty, HeaderButton, Loading, MenuDivider, MenuLabel, MenuRow, StatusLabel } from '../ui/common.tsx';
import { ArrowDownCircle, ChevronDown, ChevronRight, ChevronsUpDown, File, Folder, FolderOpen, FolderPlus, GitBranch, GitPullRequest, MessageMultiple, MoreHorizontal, PanelLeft, Plus, RotateCcw, Search, Settings, Sparkles, SplitColumns, Square, StickyNote, Terminal, Trash2, X, type IconComponent } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Select } from '../mono/settings.tsx';
import { ContextMenu, openContextMenu, toggleMenu, type MenuAnchor } from '../ui/ContextMenu.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { useNow } from '../ui/useNow.ts';
import { AGENT_GROUP_LABEL, agentsSummary, groupAgents, railAgents, railAgentStatus, showsWorkspace, type RailAgentStatus } from './agentRail.ts';
import { openAsks, openSuper } from '../super.ts';
import { AgentAvatar, AvatarGlyph } from '../ui/Avatar.tsx';
import { AvatarStack } from '../ui/AvatarStack.tsx';
import { SUPER_LOOK } from '../../shared/avatar.ts';

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

function SidebarMenu({ anchor, onClose, children }: { anchor: MenuAnchor; onClose: () => void; children: ReactNode }) {
  return <ContextMenu anchor={anchor} onClose={onClose} label="Actions">{children}</ContextMenu>;
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

/** A channel with posts you have not opened: the accent pill a count would sit in. The server keeps no count, so it says "new". */
function UnreadPill() {
  return <span className="rounded bg-accent px-1 text-[10px] font-medium leading-4 text-white" title="Unread posts">new</span>;
}

/** The accent dot for news you have not opened yet. */
function UnreadDot() {
  return <span role="img" className="size-1.5 shrink-0 rounded-full bg-accent" title="Unread" aria-label="Unread" />;
}

/**
 * How an agent is doing, at the right of its name in a card or a sidebar row, always in the same
 * place: Needs you, a spinner with how long it has worked, Failed, or how long ago it was active
 * (with the unread dot when it has news).
 */
function AgentStateMark({ agent, pending, now }: { agent: Agent; pending: boolean; now: number }) {
  if (pending || agent.status === 'waiting') return <span className="text-[11px] font-medium text-warning">Needs you</span>;
  if (agent.status === 'working') {
    const since = agent.turnStartedAt ? relativeTime(agent.turnStartedAt, now) : 'now';
    return (
      <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-content/45" title="Working">
        <TerminalSpinner className="text-content/55" />
        {since === 'now' ? null : since}
      </span>
    );
  }
  if (agent.status === 'error') return <span className="text-[11px] text-danger">Failed</span>;
  return (
    <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-content/40">
      {agent.unread ? <UnreadDot /> : null}
      {relativeTime(agent.lastActiveAt, now)}
    </span>
  );
}

/**
 * An agent in the workspace column. The agent leads: its avatar in a column of its own, then its
 * name and role with its state at the right, what it is on, and, while it is active, one quiet line
 * with the model and the branch.
 */
function AgentCard({ agent, selected, now, actions }: { agent: Agent; selected: boolean; now: number; actions: SidebarActions }) {
  const models = useApp(s => s.snapshot?.models[agent.engine]);
  const pending = useApp(s => Boolean(s.snapshot?.approvals.some(a => a.agentId === agent.id)));
  const from = useApp(s => (agent.currentTask?.source === 'agent' ? s.snapshot?.agents.find(a => a.id === agent.currentTask?.fromAgentId)?.name : undefined));
  const projects = useApp(s => s.snapshot?.projects);
  const where = whereabouts(agent, projects);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const task = agent.status === 'error' && agent.error ? agent.error : agent.currentTask?.summary || agent.lastSummary || 'No task yet';
  const active = pending || agent.status === 'working' || agent.status === 'waiting';
  const place = where && (where.branch || !where.own) ? where : null;
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={e => (e.metaKey || e.ctrlKey ? openToSide : open)({ kind: 'agent', agentId: agent.id })}
        title={`Click to open, ${MOD_CLICK} to open beside, right-click for more`}
        aria-current={selected ? 'page' : undefined}
        className={cx('grid w-full grid-cols-[28px_minmax(0,1fr)] items-start gap-x-2.5 rounded-lg px-2.5 py-2 text-left font-sans transition-colors duration-100', selected || menu ? 'bg-selection text-content' : 'text-content/80 hover:bg-content/5 hover:text-content')}
      >
        <AgentAvatar agent={agent} className="mt-px size-7" />
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate text-[13px] font-semibold leading-[18px] text-content">{agent.name}</span>
            <span className="shrink-0 text-[11.5px] text-content/40">{rolePreset(agent.role).name}</span>
            {/* The ... button takes this spot on hover. */}
            <span className={cx('ml-auto flex shrink-0 items-center gap-1.5 pl-1.5 group-hover:invisible group-has-[[data-card-more]:focus-visible]:invisible', menu && 'invisible')}>
              {agent.queued > 0 ? <span className="rounded-full bg-content/10 px-1.5 text-[10px] tabular-nums text-content/70" title={`${agent.queued} ${agent.queued === 1 ? 'message' : 'messages'} waiting`}>{agent.queued}</span> : null}
              <AgentStateMark agent={agent} pending={pending} now={now} />
            </span>
          </span>
          <span className={cx('mt-px line-clamp-2 min-w-0 break-words text-[12px] leading-[17px]', agent.currentTask ? 'text-content/70' : 'text-content/45')}>
            {from ? <span className="text-content/50">from {from}: </span> : null}
            {task}
          </span>
          {active ? (
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-content/40" title={place ? `Working in ${place.project}${place.branch ? ` on ${place.branch}` : ''}` : undefined}>
              <span className="shrink-0">{modelLabel(agent, models)}</span>
              {place ? (
                <>
                  <span aria-hidden className="shrink-0 text-content/20">/</span>
                  <GitBranch className="size-3 shrink-0" strokeWidth={1.75} />
                  {/* The card sits under its own project already, so only another project is named. */}
                  {place.own ? null : <span className="max-w-[50%] shrink-0 truncate text-content/55">{place.project}</span>}
                  {place.branch ? <span className="min-w-0 truncate">{place.branch}</span> : null}
                </>
              ) : agent.status === 'working' && agent.activity ? (
                <>
                  <span aria-hidden className="shrink-0 text-content/20">/</span>
                  <span className="min-w-0 truncate">{agent.activity}</span>
                </>
              ) : null}
            </span>
          ) : null}
        </span>
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
    ...(agents ?? []).filter(a => !projectId || a.projectIds?.[0] === projectId).map(a => ({ value: `a:${a.id}`, root: { agent: a.id } as Root, label: `${a.name}'s workspace`, detail: a.worktree?.branch ?? '' })),
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

/** "Pull requests" (ACH-D42): opens the page; its count is the open PRs across the projects. */
function PullRequestsAction() {
  usePrsData();
  const count = usePrs(s => openCount(s.data));
  const active = focusedKind(useLayout()) === 'pullRequests';
  return (
    <RailAction icon={GitPullRequest} label="Pull requests" active={active} onClick={() => open({ kind: 'pullRequests' })}>
      {count ? <span className="shrink-0 text-[11px] tabular-nums text-content/40" title={`${count} open`}>{count}</span> : null}
    </RailAction>
  );
}

/** A row at the top or foot of the navigation column: MonoCode's RailAction. */
function RailAction({ icon: Icon, mark, label, hint, active = false, onClick, children }: { icon: IconComponent; mark?: ReactNode; label: string; hint?: KeySpec; active?: boolean; onClick: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx('relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors duration-150', active ? 'bg-selection text-content' : 'text-content/75 hover:bg-content/10 hover:text-content')}
    >
      {mark ?? <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />}
      <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight">{label}</span>
      {children}
      {/* MonoCode's shortcut hint at the end of the row, as in "Settings ⌘,". */}
      {hint ? <Kbd spec={hint} quiet /> : null}
    </button>
  );
}

/**
 * A titled list in the navigation column, with MonoCode's quiet + beside the title. The title folds
 * the list away (remembered in the layout) and carries its count; folded, it still says whether
 * something inside needs you or is working (`mark`). An empty section is its header alone: the +
 * is the one way to add.
 */
function RailSection({ id, title, count, mark, addLabel, onAdd, children }: { id: RailSectionKey; title: string; count: number; mark?: ReactNode; addLabel: string; onAdd: () => void; children: ReactNode }) {
  const folded = Boolean(useLayout().folded?.[id]);
  const Chevron = folded ? ChevronRight : ChevronDown;
  return (
    <section aria-label={title} className="mb-2 shrink-0">
      <div className="group/section flex items-center gap-1 px-3 pb-1.5 pt-1">
        <h2 className="flex min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={!folded}
            onClick={() => setSectionFolded(id, !folded)}
            title={folded ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`}
            className="-ml-0.5 flex h-5 min-w-0 items-center gap-1.5 rounded px-1 text-xs font-normal leading-5 text-content/50 transition-colors duration-150 hover:text-content"
          >
            {/* The chevron keeps its place so titles never shift; it shows when pointed at, and stays while folded. */}
            <Chevron className={cx('-ml-0.5 size-2.5 shrink-0 transition-opacity duration-150', folded ? 'opacity-70' : 'opacity-0 group-hover/section:opacity-70 group-focus-within/section:opacity-70')} strokeWidth={2} />
            <span className="min-w-0 truncate">{title}</span>
            {count ? <span className="shrink-0 tabular-nums text-content/30">{count}</span> : null}
            {folded && mark ? <span className="ml-0.5 flex shrink-0 items-center">{mark}</span> : null}
          </button>
        </h2>
        <button type="button" title={addLabel} aria-label={addLabel} onClick={onAdd} className="grid size-5 shrink-0 place-items-center rounded-md text-content/50 transition-colors duration-150 hover:bg-content/8 hover:text-content">
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {folded ? null : <div className="flex flex-col gap-px px-2">{children}</div>}
    </section>
  );
}

/** What a folded section or a project says about its agents: how many need you, or that one is working. */
function SummaryMark({ needs, working }: { needs: number; working: boolean }) {
  if (needs) return <span className="text-[11px] font-medium tabular-nums text-warning" title={`${needs} ${needs === 1 ? 'needs' : 'need'} you`}>{needs}</span>;
  return working ? <TerminalSpinner className="text-content/55" /> : null;
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

/**
 * An agent with no project in the navigation column; it works across all projects. One line: avatar,
 * name, and how it is doing (a spinner with the time it has worked, how long ago, or the needs-you
 * mark).
 */
function AgentRailRow({ agent, selected, actions }: { agent: Agent; selected: boolean; actions: SidebarActions }) {
  const pending = usePendingApproval(agent.id);
  const now = useNow();
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={e => openRailAgent(agent, e)}
        title={`${agent.name}, works across all projects. Click to open, ${MOD_CLICK} to open beside, right-click for more.`}
        aria-current={selected ? 'page' : undefined}
        className={cx(railRow(Boolean(menu)), railRowState(selected || Boolean(menu)))}
      >
        <AgentAvatar agent={agent} className="size-5" />
        <span className={cx('min-w-0 flex-1 truncate text-sm leading-tight', agent.unread ? 'font-semibold text-content' : 'font-medium')}>{agent.name}</span>
        {/* How it is doing, in the same place on every row; the ... button takes the spot on hover. */}
        <span className={cx('flex shrink-0 items-center group-hover:hidden group-has-[[data-card-more]:focus-visible]:hidden', menu && 'hidden')}>
          <AgentStateMark agent={agent} pending={pending} now={now} />
        </span>
      </button>
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
        title={`${channel.topic || `#${channel.name}`}. Click to open, ${MOD_CLICK} to open beside, right-click for more.`}
        aria-current={selected ? 'page' : undefined}
        className={cx(railRow(waiting || working || channel.unread || Boolean(menu)), channel.unread && !waiting && !working && !menu && 'pr-10', railRowState(selected || Boolean(menu)))}
      >
        <span aria-hidden className="grid size-4 shrink-0 place-items-center text-[14px] leading-none opacity-70">#</span>
        <span className={cx('min-w-0 flex-1 truncate text-sm leading-tight', channel.unread ? 'font-semibold text-content' : 'font-medium')}>{channel.name}</span>
      </button>
      <RowStatus hidden={Boolean(menu)}>
        {waiting ? <NeedsYouDot /> : working ? <TerminalSpinner className="text-content/55" /> : channel.unread ? <UnreadPill /> : null}
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

/**
 * A project in the navigation column: selecting it fills the workspace column with its agents. The
 * current project is marked by brighter text and an open folder, never by the fill, which means
 * "open in front of you" and belongs to tabs. The row carries its agents' avatars, so you can see
 * where the team is without selecting each project; one with no agents is quieter.
 */
function ProjectRailRow({ project, agents, pendingIds, selected, actions }: { project: Project; agents: Agent[]; pendingIds: ReadonlySet<string>; selected: boolean; actions: SidebarActions }) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const summary = agentsSummary(agents, pendingIds);
  const Icon = selected ? FolderOpen : Folder;
  const quiet = !selected && (!agents.length || !project.exists);
  return (
    <div className="group relative" onContextMenu={e => openContextMenu(e, setMenu)}>
      <button
        type="button"
        onClick={() => selectProject(project, agents.length, actions)}
        title={`${project.path}${agents.length ? `. ${agents.map(a => a.name).join(', ')}` : ''}`}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          railRow(Boolean(menu)),
          menu ? 'bg-selection-strong text-content' : selected ? 'text-content hover:bg-content/5' : quiet ? 'text-content/45 hover:bg-content/5 hover:text-content' : 'text-content/65 hover:bg-content/5 hover:text-content',
        )}
      >
        <Icon className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
        <span className={cx('min-w-0 flex-1 truncate text-sm leading-tight', quiet ? 'font-normal' : 'font-medium')}>{project.name}</span>
        {/* Marks first, then who is inside; the ... button takes the spot on hover. */}
        <span className={cx('flex shrink-0 items-center gap-1.5 group-hover:hidden group-has-[[data-card-more]:focus-visible]:hidden', menu && 'hidden')}>
          {!project.exists ? <span className="text-[11px] text-danger">missing</span> : <SummaryMark needs={summary.needsYou} working={summary.working} />}
          {agents.length ? <AvatarStack agents={agents} max={3} size="size-4" ring="bg-transparent" /> : null}
        </span>
      </button>
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
  const approvals = useApp(s => s.snapshot?.approvals);
  const pendingIds = useMemo(() => new Set((approvals ?? []).map(a => a.agentId)), [approvals]);
  // What each section says about itself while it is folded.
  const listedSummary = agentsSummary(listed, pendingIds);
  const projectSummary = agentsSummary((agents ?? []).filter(a => a.projectIds !== null), pendingIds);
  const channelsWaiting = (agents ?? []).some(a => a.currentTask?.channelId && a.status === 'waiting');
  const channelsWorking = (agents ?? []).some(a => a.currentTask?.channelId && a.status === 'working');
  return (
    <nav aria-label="PodCode" style={{ width: column.width }} className="sidebar-glass relative flex shrink-0 flex-col border-r border-stroke font-sans">
      {/* In the desktop app the traffic lights take the brand's place, as in MonoCode. */}
      <div data-window-drag className="flex h-10 shrink-0 items-center gap-2 pl-3.5 pr-1.5 desktop:pl-[76px]">
        <span className="flex min-w-0 flex-1 items-center gap-2 desktop:invisible">
          <BrandMark />
          <span className="min-w-0 truncate text-[13px] font-semibold text-content/85">PodCode</span>
        </span>
      </div>
      {/* New agent is the one raised control; Search sits beside it as an icon. */}
      <div className="flex shrink-0 items-center gap-1.5 px-2 pb-2 pt-0.5">
        <button
          type="button"
          onClick={() => actions.newAgent(projectId)}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-lg bg-content/[0.09] px-2.5 text-left text-[13px] font-medium text-content transition-colors duration-150 hover:bg-content/[0.14]"
        >
          <Plus className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">New agent</span>
          <Kbd spec={SHORTCUT_KEYS.newAgent} quiet className="font-normal" />
        </button>
        <button
          type="button"
          title={`Search (${SHORTCUTS.palette})`}
          aria-label={`Search (${SHORTCUTS.palette})`}
          onClick={actions.palette}
          className="grid size-[30px] shrink-0 place-items-center rounded-lg text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content"
        >
          <Search className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex shrink-0 flex-col gap-px px-2 pb-2">
        <RailAction icon={MessageMultiple} label="Comms" active={commsOpen} onClick={() => open({ kind: 'comms' })}>
          {inFlight ? <span className="shrink-0 text-[11px] tabular-nums text-content/40" title={`${inFlight} in flight`}>{inFlight}</span> : null}
        </RailAction>
        <PullRequestsAction />
        <RailAction icon={Sparkles} mark={<SuperMark superId={superId} />} label="SuperAgent" hint={SHORTCUT_KEYS.superQuick} active={Boolean(superId) && agentId === superId} onClick={() => void openSuper()}>
          {superWaiting ? <span className="shrink-0 text-[11px] tabular-nums text-content/40" title={`${superWaiting} waiting for you`}>{superWaiting}</span> : null}
        </RailAction>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none pb-2">
        <RailSection
          id="channels"
          title="Channels"
          count={sorted.length}
          mark={channelsWaiting ? <NeedsYouDot /> : channelsWorking ? <TerminalSpinner className="text-content/55" /> : sorted.some(c => c.unread) ? <UnreadDot /> : null}
          addLabel="New channel"
          onAdd={actions.newChannel}
        >
          {sorted.map(channel => <ChannelRailRow key={channel.id} channel={channel} selected={channel.id === channelId} actions={actions} />)}
        </RailSection>
        {/* Agents with no project, which work across all of them; a project's agents are in its workspace column. */}
        <RailSection id="agents" title="Agents" count={listed.length} mark={<SummaryMark needs={listedSummary.needsYou} working={listedSummary.working} />} addLabel="New agent with no project" onAdd={() => actions.newAgent(null)}>
          {listed.map(agent => <AgentRailRow key={agent.id} agent={agent} selected={agent.id === agentId} actions={actions} />)}
        </RailSection>
        <RailSection id="projects" title="Projects" count={projects?.length ?? 0} mark={<SummaryMark needs={projectSummary.needsYou} working={projectSummary.working} />} addLabel="Add project" onAdd={actions.addProject}>
          {(projects ?? []).map(project => (
            <ProjectRailRow key={project.id} project={project} agents={(agents ?? []).filter(a => Boolean(a.projectIds?.includes(project.id)))} pendingIds={pendingIds} selected={project.id === projectId} actions={actions} />
          ))}
        </RailSection>
      </div>
      <SidebarUpdateFooter />
      {/* One row at the foot: About you with what waits there, then Settings and Collapse as icons. */}
      <div className="flex shrink-0 items-center gap-0.5 px-2 pb-2 pt-1.5">
        <button
          type="button"
          onClick={actions.profile}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-[13px] font-medium text-content/70 transition-colors duration-150 hover:bg-content/10 hover:text-content"
        >
          <StickyNote className="size-4 shrink-0 opacity-70" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 truncate">About you</span>
          {waiting ? <span className="min-w-4 shrink-0 rounded bg-content/[0.14] px-1 text-center text-[10px] font-medium leading-4 tabular-nums text-content/80" title={`${waiting} waiting for your approval`}>{waiting}</span> : null}
        </button>
        <HeaderButton icon={Settings} label={`Settings (${SHORTCUTS.settings})`} onClick={actions.settings} className="size-[30px]" />
        <HeaderButton icon={PanelLeft} label="Collapse navigation" onClick={() => setRail(false)} className="size-[30px]" />
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
  const approvals = useApp(s => s.snapshot?.approvals);
  const pendingIds = useMemo(() => new Set((approvals ?? []).map(a => a.agentId)), [approvals]);
  const mine = useMemo(() => (agents ?? []).filter(a => Boolean(project && a.projectIds?.includes(project.id))).sort((a, b) => a.createdAt - b.createdAt), [agents, project?.id]);
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
                {groupAgents(shown, pendingIds).map(group => (
                  <section key={group.key} aria-label={AGENT_GROUP_LABEL[group.key]} className="flex flex-col gap-0.5">
                    {/* A quiet label, no rule: the list sorts itself by what wants attention. */}
                    <h3 className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-2 text-[11px] font-medium text-content/40">
                      {AGENT_GROUP_LABEL[group.key]}
                      <span className="font-normal tabular-nums text-content/25">{group.agents.length}</span>
                    </h3>
                    {group.agents.map(agent => <AgentCard key={agent.id} agent={agent} selected={agent.id === selected} now={now} actions={actions} />)}
                  </section>
                ))}
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
/** The collapsed rail's Pull requests, with the open count in its label (ACH-D42). */
function PullRequestsIcon() {
  usePrsData();
  const count = usePrs(s => openCount(s.data)) ?? 0;
  const active = focusedKind(useLayout()) === 'pullRequests';
  return (
    <RailIconButton label={count ? `Pull requests, ${count} open` : 'Pull requests'} active={active} onClick={() => open({ kind: 'pullRequests' })}>
      <GitPullRequest className="size-4" strokeWidth={1.75} />
    </RailIconButton>
  );
}

function RailIconButton({ label, active = false, dot, badge = 0, onClick, onContextMenu, children }: {
  label: string;
  active?: boolean;
  dot?: ReactNode;
  /** How many things behind this icon wait on you; shown as a count in place of the dot. */
  badge?: number;
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
      {badge > 0 ? (
        <span role="img" aria-label={`${badge} ${badge === 1 ? 'needs' : 'need'} you`} className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-warning px-[3px] text-center text-[10px] font-semibold leading-[15px] tabular-nums text-black">{badge > 9 ? '9+' : badge}</span>
      ) : dot ? <span className="absolute right-1 top-1 flex">{dot}</span> : null}
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
        <AgentAvatar agent={agent} className="size-4" />
      </RailIconButton>
      {menu ? <AgentMenu agent={agent} anchor={menu} actions={actions} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function ProjectRailIcon({ project, agents, selected, actions }: { project: Project; agents: Agent[]; selected: boolean; actions: SidebarActions }) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const approvals = useApp(s => s.snapshot?.approvals);
  const summary = agentsSummary(agents, new Set((approvals ?? []).map(a => a.agentId)));
  const Icon = selected ? FolderOpen : Folder;
  return (
    <>
      <RailIconButton
        label={summary.needsYou ? `${project.name}, ${summary.needsYou} ${summary.needsYou === 1 ? 'needs' : 'need'} you` : project.name}
        active={selected || Boolean(menu)}
        badge={summary.needsYou}
        dot={summary.working ? <WorkingDot /> : null}
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
  const superId = useApp(s => s.snapshot?.super.agentId ?? null);
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
      <ProjectRailIcon key={project.id} project={project} agents={(agents ?? []).filter(a => Boolean(a.projectIds?.includes(project.id)))} selected={project.id === projectId} actions={actions} />
    )),
  ].filter(group => group.length);
  return (
    <nav aria-label="PodCode" className="sidebar-glass relative flex w-12 shrink-0 flex-col items-center font-sans">
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
        <PullRequestsIcon />
        <RailIconButton label={superWaiting ? `SuperAgent, ${superWaiting} waiting for you` : 'SuperAgent'} badge={superWaiting} onClick={() => void openSuper()}>
          <SuperMark superId={superId} />
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
            onClick={() => void window.podcodeDesktop?.updates?.install()}
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

/** The SuperAgent's own avatar, in its current mood once it exists. */
function SuperMark({ superId }: { superId: string | null | undefined }) {
  const agent = useApp(s => (superId ? s.snapshot?.agents.find(a => a.id === superId) : undefined));
  return agent ? <AgentAvatar agent={agent} className="size-4" /> : <AvatarGlyph look={SUPER_LOOK} seed="super" className="size-4" />;
}
