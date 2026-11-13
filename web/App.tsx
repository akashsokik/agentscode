import { startProjectId } from '../shared/agentProjects.ts';
import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import type { Agent, Snapshot } from '../shared/types.ts';
import { AddProjectDialog } from './dialogs/AddProjectDialog.tsx';
import { AgentSettingsDialog } from './dialogs/AgentSettingsDialog.tsx';
import { ChannelDialog } from './dialogs/ChannelDialog.tsx';
import { NewAgentDialog } from './dialogs/NewAgentDialog.tsx';
import { RemoveAgentDialog } from './dialogs/RemoveAgentDialog.tsx';
import { SettingsDialog, type SettingsGroup } from './dialogs/SettingsDialog.tsx';
import { ProfileDialog } from './dialogs/UserProfile.tsx';
import { SuperQuickBar } from './ui/SuperQuickBar.tsx';
import { openAsks, openSuper, superLabel, useSuperAgent, useSuperBridge } from './super.ts';
import { useGitStatus } from './git.ts';
import { closeOtherTabs, closeTab, closeTabsToRight, focusedAgentId, open, openToSide, pinTab, pruneTabs, reorderTab, setProject, setRightPanel, setSidebar, setSidebarView, toggleMaximize, useLayout, type Pane, type Tab } from './layout.ts';
import { othersToClose, rightToClose } from './tabs.ts';
import { ContextMenu, openContextMenu, type MenuAnchor } from './ui/ContextMenu.tsx';
import { AgentPane } from './panes/AgentPane.tsx';
import { BrowserPane } from './panes/BrowserPane.tsx';
import { ChannelPane } from './panes/ChannelPane.tsx';
import { PullRequestsPane } from './prs/PullRequestsPane.tsx';
import { IssuesPage } from './issues/IssuesPage.tsx';
import { openIssueCount } from './sidebar/navCounts.ts';
import { prsOpenCount } from './prs/prsData.ts';
import { CommsPane } from './panes/CommsPane.tsx';
import { WorkPane } from './work/WorkView.tsx';
import { DiffPane, FilePane } from './panes/FilePane.tsx';
import { HomePane } from './panes/HomePane.tsx';
import { WalkthroughPane } from './panes/WalkthroughPane.tsx';
import type { PaneChrome } from './panes/PaneFrame.tsx';
import { RightPanel } from './right/RightPanel.tsx';
import { IS_DESKTOP_APP } from './platform.ts';
import { MOD_CLICK, SHORTCUTS, useShortcuts } from './shortcuts.ts';
import { paneGrow } from './paneSizes.ts';
import { PaneDivider } from './ui/PaneDivider.tsx';
import { openBrowser } from './browser.ts';
import { Sidebars, useNavFull, type SidebarActions } from './sidebar/Sidebar.tsx';
import { toggleTerminal } from './terminal/actions.ts';
import { TerminalPanel } from './terminal/TerminalPanel.tsx';
import { CommandPalette } from './ui/CommandPalette.tsx';
import { projectLabel } from './projects.ts';
import { dismissToast, useApp } from './store.ts';
import { UsageFooter } from './ui/UsageFooter.tsx';
import { HeaderButton, MenuDivider, MenuRow, StatusLabel } from './ui/common.tsx';
import { AlertCircle, CheckCircle, ChevronRight, CircleX, GitBranch, Route, File, FileDiff, Globe, Maximize2, MessageMultiple, Minimize2, PanelLeft, PanelRight, Pin, PinOff, Plus, SplitColumns, Terminal, X, GitPullRequest, CircleDashed } from './mono/icons.tsx';
import { LAYER } from './mono/layers.ts';
import { Shimmer } from './mono/Shimmer.tsx';
import { TabLabel } from './mono/TabLabel.tsx';
import { TabWidthMotion } from './mono/TabWidthMotion.tsx';
import { TerminalSpinner } from './mono/TerminalSpinner.tsx';
import { useTabCloseMotion } from './mono/useTabCloseMotion.ts';
import { AgentAvatar } from './ui/Avatar.tsx';
import { AvatarStack } from './ui/AvatarStack.tsx';
import { StaleBuildNotice } from './ui/StaleBuildNotice.tsx';

const MAX_PANES = 3;

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * Icon, headline and meta line for a title tab, from live state. `busy` shows a spinner;
 * `attention` (an agent waiting on you) shows a dot instead, so it reads from across the bar.
 */
function describeTab(tab: Tab, snapshot: Snapshot | null): { icon: ReactNode; headline: string; meta: string; busy?: boolean; attention?: boolean } {
  const c = tab.content;
  if (c.kind === 'agent') {
    const agent = snapshot?.agents.find(a => a.id === c.agentId);
    if (!agent) return { icon: <X className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />, headline: 'Removed', meta: '' };
    const pending = Boolean(snapshot?.approvals.some(a => a.agentId === agent.id));
    return {
      icon: <AgentAvatar agent={agent} className="size-3.5" />,
      headline: agent.name,
      meta: agent.currentTask?.summary || agent.lastSummary || projectLabel(agent.projectIds, snapshot?.projects),
      busy: agent.status === 'working',
      attention: agent.status === 'waiting' || pending,
    };
  }
  if (c.kind === 'channel') {
    const channel = snapshot?.channels.find(ch => ch.id === c.channelId);
    if (!channel) return { icon: <X className="size-3.5 shrink-0 text-content/40" strokeWidth={1.75} />, headline: 'Deleted', meta: '' };
    const members = channel.memberIds.length;
    const onIt = snapshot?.agents.filter(a => a.currentTask?.channelId === channel.id) ?? [];
    return {
      icon: <span className="w-3.5 shrink-0 text-center font-sans text-[13px] leading-none">#</span>,
      headline: channel.name,
      meta: channel.topic || `${members} ${members === 1 ? 'member' : 'members'}`,
      busy: onIt.some(a => a.status === 'working'),
      attention: onIt.some(a => a.status === 'waiting'),
    };
  }
  if (c.kind === 'walkthrough') {
    const agent = snapshot?.agents.find(a => a.id === c.agentId);
    return { icon: <Route className="size-3.5 shrink-0" strokeWidth={1.75} />, headline: c.title, meta: `Walkthrough${agent ? `, ${agent.name}` : ''}` };
  }
  if (c.kind === 'browser') {
    const agent = c.agentId ? snapshot?.agents.find(a => a.id === c.agentId) : undefined;
    let host = '';
    try {
      host = c.url ? new URL(c.url).host : '';
    } catch {
      // not a URL yet
    }
    return { icon: <Globe className="size-3.5 shrink-0" strokeWidth={1.75} />, headline: c.title || host || 'New tab', meta: agent ? `Browser, ${agent.name}` : host || 'Browser' };
  }
  if (c.kind === 'work') {
    return { icon: <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />, headline: 'Work', meta: 'Branches, merges and cleanup' };
  }
  if (c.kind === 'issues') {
    const count = openIssueCount(snapshot?.super.issues);
    return { icon: <CircleDashed className="size-3.5 shrink-0" strokeWidth={1.75} />, headline: 'Issues', meta: count ? `${count} open` : 'The issues backlog' };
  }
  if (c.kind === 'pullRequests') {
    const openCount = prsOpenCount();
    return { icon: <GitPullRequest className="size-3.5 shrink-0" strokeWidth={1.75} />, headline: 'Pull requests', meta: openCount === null ? 'Across your projects' : `${openCount} open` };
  }
  if (c.kind === 'comms') {
    const active = snapshot?.messages.filter(m => !m.channelId && (m.status === 'queued' || m.status === 'delivering')).length ?? 0;
    return { icon: <MessageMultiple className="size-3.5 shrink-0" strokeWidth={1.75} />, headline: 'Comms', meta: active ? `${active} in flight` : 'Agent conversations', busy: active > 0 };
  }
  const owner = 'agent' in c.root
    ? snapshot?.agents.find(a => a.id === (c.root as { agent: string }).agent)?.name
    : snapshot?.projects.find(p => p.id === (c.root as { project: string }).project)?.name;
  return {
    icon: c.kind === 'diff' ? <FileDiff className="size-3.5 shrink-0" strokeWidth={1.75} /> : <File className="size-3.5 shrink-0" strokeWidth={1.75} />,
    headline: baseName(c.path),
    meta: c.kind === 'diff' ? `Diff${owner ? `, ${owner}` : ''}` : owner ?? '',
  };
}

/** Drag data type for reordering tabs within their group. */
const TAB_DRAG = 'application/x-podcode-tab';

/**
 * Right-click on a tab (ACH-D27): Pin or Unpin, the close actions, Split right and Maximize pane.
 * Items with nothing to do stay, greyed: Close others with no other unpinned tab, Close to the
 * right with none after it, Maximize with one pane.
 */
function TabMenu({ tab, anchor, onClose }: { tab: Tab; anchor: MenuAnchor; onClose: () => void }) {
  const layout = useLayout();
  const { headline } = describeTab(tab, useApp(s => s.snapshot));
  const run = (action: () => void) => () => { onClose(); action(); };
  const pane = layout.panes.find(p => p.tabId === tab.id) ?? layout.panes.find(p => p.id === layout.focused);
  const maximized = Boolean(pane && layout.maximized === pane.id);
  return (
    <ContextMenu anchor={anchor} onClose={onClose} label={`Tab ${headline}`}>
      <MenuRow icon={tab.pinned ? PinOff : Pin} title={tab.pinned ? 'Unpin tab' : 'Pin tab'} onSelect={run(() => pinTab(tab.id, !tab.pinned))} />
      <MenuDivider />
      <MenuRow icon={X} title="Close" shortcut="Mod+W" onSelect={run(() => closeTab(tab.id))} />
      <MenuRow icon={CircleX} title="Close others" shortcut="Alt+Mod+W" disabled={!othersToClose(layout.tabs, tab.id).length} onSelect={run(() => closeOtherTabs(tab.id))} />
      <MenuRow icon={ChevronRight} title="Close to the right" disabled={!rightToClose(layout.tabs, tab.id).length} onSelect={run(() => closeTabsToRight(tab.id))} />
      <MenuDivider />
      <MenuRow icon={SplitColumns} title="Split right" onSelect={run(() => openToSide(tab.content))} />
      <MenuRow
        icon={maximized ? Minimize2 : Maximize2}
        title={maximized ? 'Restore panes' : 'Maximize pane'}
        shortcut="Shift+Mod+Enter"
        disabled={layout.panes.length < 2 || !pane}
        onSelect={run(() => { if (pane) toggleMaximize(pane.id); })}
      />
    </ContextMenu>
  );
}

/**
 * MonoCode's tab strip: tabs, a quiet +, then the changes pill and the panel toggle. It heads the
 * main column, or the whole window in the desktop app with the navigation folded.
 * `underLights`: it starts at the window's left edge, where the desktop app's traffic lights sit.
 */
function TabBar({ onNewAgent, underLights }: { onNewAgent: () => void; underLights: boolean }) {
  const layout = useLayout();
  const snapshot = useApp(s => s.snapshot);
  const focusedPane = layout.panes.find(p => p.id === layout.focused);
  const agentId = focusedAgentId(layout);
  const agent = snapshot?.agents.find(a => a.id === agentId);
  const root = useMemo(() => (agentId ? { agent: agentId } : null), [agentId]);
  const { status } = useGitStatus(root, agent ? `${agent.status}:${agent.turns}` : undefined);
  const strip = useRef<HTMLDivElement>(null);
  const { displayed, tabNodeRef, finishMotion } = useTabCloseMotion(layout.tabs);
  // The tab whose right-click menu is open (ACH-D27).
  const [menu, setMenu] = useState<{ tabId: string; anchor: MenuAnchor } | null>(null);
  const menuTab = menu ? layout.tabs.find(t => t.id === menu.tabId) : undefined;
  const onTabMenu = (tabId: string) => (e: MouseEvent<HTMLElement>) =>
    openContextMenu(e, anchor => setMenu(anchor && typeof anchor !== 'function' ? { tabId, anchor } : null));

  // The traffic lights end 76px in (electron/main.ts places them 16px from the edge); with the
  // strip's own 6px the first tab starts at 88px, 12px clear of them.
  return (
    <header data-window-drag className={`flex h-10 shrink-0 select-none items-stretch border-b border-stroke font-sans ${underLights ? 'desktop:pl-[82px]' : ''}`}>
      {/* As in MonoCode, the title bar offers the sidebar only while it is hidden; the rail folds itself. */}
      {layout.sidebar ? null : (
        <div className="flex shrink-0 items-center pl-1.5">
          <HeaderButton icon={PanelLeft} label="Show sidebar" title={`Show sidebar (${SHORTCUTS.sidebar})`} onClick={() => setSidebar(true)} />
        </div>
      )}
      <div
        ref={strip}
        className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none pl-1.5 pr-2.5 [scrollbar-width:none]"
        onWheel={e => { if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY; }}
      >
        {displayed.map((entry, index) => {
          const tab = entry.item;
          const { icon, headline, meta, busy, attention } = describeTab(tab, snapshot);
          const active = !entry.closing && focusedPane?.tabId === tab.id;
          const pinned = Boolean(tab.pinned);
          // A hairline ends the pinned group (ACH-D27); only when normal tabs follow.
          const groupEnd = pinned && displayed[index + 1] && !displayed[index + 1].item.pinned;
          // As in MonoCode, a tab opens out from nothing and folds away when closed (useTabCloseMotion).
          const moving = entry.closing || entry.opening;
          const status = attention
            ? <span aria-hidden className="size-1.5 rounded-full bg-warning" />
            : busy ? <TerminalSpinner className="text-content/45" /> : null;
          const dragProps = {
            draggable: !moving,
            onDragStart: (e: DragEvent) => { e.dataTransfer.setData(TAB_DRAG, tab.id); e.dataTransfer.effectAllowed = 'move'; },
            // Only within its own group: a pinned tab among the pinned, a normal one among the normal.
            onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(TAB_DRAG)) e.preventDefault(); },
            onDrop: (e: DragEvent) => { const id = e.dataTransfer.getData(TAB_DRAG); if (id) { e.preventDefault(); reorderTab(id, tab.id); } },
          };
          const shell = pinned ? (
            // Pinned (variant B, ACH-D28): icon only at a fixed width, no close button, status at the
            // top right of the icon; the full name is in the tooltip.
            <div
              ref={entry.closing ? undefined : tabNodeRef(tab.id)}
              className={`relative flex h-full shrink-0 items-center ${moving ? 'w-full min-w-0 overflow-hidden' : ''}`}
              onContextMenu={onTabMenu(tab.id)}
              {...dragProps}
            >
              <button
                type="button"
                title={meta ? `${headline} · ${meta} (pinned)` : `${headline} (pinned)`}
                aria-label={attention ? `${headline}, pinned, needs you` : `${headline}, pinned`}
                aria-current={active ? 'page' : undefined}
                onClick={() => open(tab.content)}
                className={`relative grid h-7.5 w-8.5 place-items-center self-center rounded-md transition-colors duration-150 ${active || menu?.tabId === tab.id ? 'bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content'}`}
              >
                <span className={`grid size-3.5 place-items-center ${active ? '' : 'opacity-55'}`}>{icon}</span>
                {status ? <span className="pointer-events-none absolute right-1 top-1 grid scale-90 place-items-center">{status}</span> : null}
              </button>
              {groupEnd ? <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-content/10" /> : null}
            </div>
          ) : (
            <div
              ref={entry.closing ? undefined : tabNodeRef(tab.id)}
              className={`group relative flex h-full items-center ${moving ? 'w-full min-w-0 overflow-hidden' : 'w-56 min-w-28 shrink'}`}
              onContextMenu={onTabMenu(tab.id)}
              {...dragProps}
            >
              <button
                type="button"
                title={meta ? `${headline} · ${meta}` : headline}
                aria-label={attention ? `${headline}, needs you` : headline}
                aria-current={active ? 'page' : undefined}
                onClick={() => open(tab.content)}
                onAuxClick={e => { if (e.button === 1) closeTab(tab.id); }}
                className={`relative flex h-7.5 min-w-0 flex-1 items-center gap-1.5 self-center rounded-md px-2 pr-7 text-left transition-colors duration-150 ${active || menu?.tabId === tab.id ? 'bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content'}`}
              >
                <span className={`grid size-3.5 shrink-0 place-items-center ${active ? '' : 'opacity-55'}`}>{icon}</span>
                <TabLabel className="min-w-0 flex-1 text-[13px] leading-tight">{headline}</TabLabel>
              </button>
              {status ? (
                <span className="pointer-events-none absolute right-2 grid w-3.5 place-items-center group-hover:hidden group-has-[[data-tab-close]:focus-visible]:hidden">
                  {status}
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`Close ${headline}`}
                title={`Close tab (${SHORTCUTS.closeTab})`}
                data-tab-close
                onClick={() => closeTab(tab.id)}
                className="absolute right-1 grid size-5 place-items-center rounded text-content/50 opacity-0 transition-opacity duration-150 hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
              >
                <X className="size-3" strokeWidth={1.8} />
              </button>
            </div>
          );
          if (moving) {
            return (
              <TabWidthMotion key={tab.id} phase={entry.closing ? 'closing' : 'opening'} width={entry.width} onFinish={() => finishMotion(tab.id)}>
                {shell}
              </TabWidthMotion>
            );
          }
          return <div key={tab.id} className="contents">{shell}</div>;
        })}
        {menuTab && menu?.anchor ? <TabMenu tab={menuTab} anchor={menu.anchor} onClose={() => setMenu(null)} /> : null}
        <button
          type="button"
          title={`New agent (${SHORTCUTS.newAgent})`}
          aria-label="New agent"
          onClick={onNewAgent}
          className="ml-0.5 grid size-7.5 shrink-0 place-items-center rounded-md bg-content/4 text-content/50 opacity-65 transition-[background-color,color,opacity] duration-150 hover:bg-content/7 hover:text-content hover:opacity-100 focus-visible:opacity-100"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1 pr-1.5">
        {status?.isRepo && status.files.length > 0 ? (
          <button
            type="button"
            title={`${status.files.length} changed files in ${agent?.name ?? 'the workspace'}. Show changes.`}
            onClick={() => setSidebarView('changes')}
            className="flex h-6.5 shrink-0 items-center gap-1.5 rounded-md bg-selection px-2 font-mono text-[11px] tabular-nums transition-colors duration-150 hover:bg-selection-hover"
          >
            <span className="text-diff-add-fg">+{status.added}</span>
            <span className="text-diff-del-fg">-{status.removed}</span>
          </button>
        ) : null}
        <HeaderButton
          icon={Globe}
          label="New browser tab"
          title={`New browser tab (${SHORTCUTS.browser}); ${MOD_CLICK} to open it beside`}
          onClick={e => openBrowser('', e.metaKey || e.ctrlKey)}
        />
        <HeaderButton
          icon={PanelRight}
          label={layout.rightPanel ? 'Hide panel' : 'Show panel'}
          title={`${layout.rightPanel ? 'Hide panel' : 'Show panel'} (${SHORTCUTS.panel})`}
          active={layout.rightPanel}
          aria-pressed={layout.rightPanel}
          onClick={() => setRightPanel(!layout.rightPanel)}
        />
      </div>
    </header>
  );
}

/**
 * MonoCode's footer under the main column: each engine's subscription usage (or the connection,
 * while it is down), who is busy, the terminal and Comms.
 */
/** The SuperAgent in the status bar: what it is doing and what waits for you; a click opens it. */
function SuperDock() {
  const agent = useSuperAgent();
  const waiting = useApp(s => openAsks(s.snapshot?.super.asks).length);
  if (!agent) return null;
  return (
    <button
      type="button"
      onClick={() => void openSuper()}
      title={`SuperAgent (${SHORTCUTS.superQuick} for the quick bar)`}
      className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 transition-colors duration-150 hover:bg-content/10 hover:text-content ${waiting ? 'text-content/75' : 'text-content/40'}`}
    >
      <AgentAvatar agent={agent} className="size-3.5" />
      {superLabel(agent, waiting)}
    </button>
  );
}

function StatusFooter() {
  const connection = useApp(s => s.connection);
  const terminalOpen = Boolean(useLayout().terminal);
  const agents = useApp(s => s.snapshot?.agents);
  const working = agents?.filter(a => a.status === 'working').length ?? 0;
  const waiting = agents?.filter(a => a.status === 'waiting').length ?? 0;
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 overflow-x-auto border-t border-stroke px-3 font-sans text-[11px] text-content/55">
      {connection === 'open' ? (
        <UsageFooter
          fallback={(
            <span role="status" className="flex shrink-0 items-center">
              <StatusLabel tone="success" quiet>Connected</StatusLabel>
            </span>
          )}
        />
      ) : (
        <span role="status" className="flex shrink-0 items-center">
          <StatusLabel tone="warning">{connection === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</StatusLabel>
        </span>
      )}
      {working ? <span className="flex shrink-0 items-center gap-1 text-content/45" title={(agents ?? []).filter(a => a.status === 'working').map(a => a.name).join(', ')}><AvatarStack agents={(agents ?? []).filter(a => a.status === 'working')} size="size-3.5" />{working} working</span> : null}
      {waiting ? <span className="flex shrink-0 items-center gap-1 text-warning" title={(agents ?? []).filter(a => a.status === 'waiting').map(a => a.name).join(', ')}><AvatarStack agents={(agents ?? []).filter(a => a.status === 'waiting')} size="size-3.5" />{waiting} {waiting === 1 ? 'needs' : 'need'} you</span> : null}
      {/* This page is older than the build the server serves now (web/staleBuild.ts). */}
      <StaleBuildNotice />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <SuperDock />
        <button
          type="button"
          onClick={toggleTerminal}
          aria-pressed={terminalOpen}
          title={`${terminalOpen ? 'Hide' : 'Show'} terminal (${SHORTCUTS.terminal})`}
          className={`inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 transition-colors duration-150 hover:bg-content/10 hover:text-content ${terminalOpen ? 'text-content/70' : 'text-content/40'}`}
        >
          <Terminal className="size-3" strokeWidth={1.75} />
          Terminal
        </button>
        <button
          type="button"
          onClick={() => open({ kind: 'comms' })}
          className="inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-content/40 transition-colors duration-150 hover:bg-content/10 hover:text-content"
        >
          <MessageMultiple className="size-3" strokeWidth={1.75} />
          Comms
        </button>
      </div>
    </footer>
  );
}

function PaneView({ pane, tab, chrome, actions }: { pane: Pane; tab: Tab | undefined; chrome: PaneChrome; actions: SidebarActions }) {
  if (!tab) return <HomePane chrome={chrome} actions={actions} />;
  const c = tab.content;
  switch (c.kind) {
    case 'agent': return <AgentPane key={pane.id + c.agentId} agentId={c.agentId} chrome={chrome} />;
    case 'file': return <FilePane key={pane.id + tab.id} root={c.root} path={c.path} chrome={chrome} />;
    case 'diff': return <DiffPane key={pane.id + tab.id} root={c.root} path={c.path} chrome={chrome} />;
    case 'comms': return <CommsPane conversationId={c.conversationId} chrome={chrome} />;
    case 'issues': return <IssuesPage chrome={chrome} />;
    case 'pullRequests': return <PullRequestsPane prId={c.prId} chrome={chrome} />;
    case 'work': return <WorkPane chrome={chrome} />;
    case 'channel': return <ChannelPane key={pane.id + c.channelId} channelId={c.channelId} chrome={chrome} />;
    case 'walkthrough': return <WalkthroughPane key={pane.id + tab.id} agentId={c.agentId} id={c.id} chrome={chrome} />;
    case 'browser': return <BrowserPane key={pane.id + tab.id} id={c.id} url={c.url} agentId={c.agentId ?? null} chrome={chrome} />;
  }
}

function Toasts() {
  const toasts = useApp(s => s.toasts);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" style={{ zIndex: LAYER.toast }}>
      {toasts.map(t => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`toast-in pointer-events-auto relative isolate flex items-start gap-2 overflow-hidden rounded-xl border bg-background-base px-3 py-2.5 font-sans text-[12px] text-content ${t.tone === 'error' ? 'border-danger/25' : 'border-content/10'}`}
        >
          {t.tone === 'error'
            ? <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-danger" strokeWidth={1.75} />
            : <CheckCircle className="mt-0.5 size-3.5 shrink-0 text-content/50" strokeWidth={1.75} />}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-5">{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="grid size-5 shrink-0 place-items-center rounded text-content/45 transition-colors duration-150 hover:bg-content/10 hover:text-content">
            <X className="size-3" strokeWidth={1.8} />
          </button>
        </div>
      ))}
    </div>
  );
}

type Dialog =
  | { kind: 'newAgent'; projectId?: string | null }
  | { kind: 'addProject'; thenNewAgent?: boolean }
  | { kind: 'settings'; group?: SettingsGroup }
  | { kind: 'profile' }
  | { kind: 'agentSettings' | 'removeAgent'; agentId: string }
  | { kind: 'newChannel' }
  | { kind: 'channelSettings'; channelId: string }
  | { kind: 'palette' }
  | { kind: 'superQuick' }
  | null;

export function App() {
  const snapshot = useApp(s => s.snapshot);
  const connection = useApp(s => s.connection);
  const layout = useLayout();
  const [dialog, setDialog] = useState<Dialog>(null);
  const opened = useRef(false);

  // Close tabs of removed agents and deleted channels; on first load, open the most recently active agent.
  useEffect(() => {
    if (!snapshot) return;
    pruneTabs(new Set(snapshot.agents.map(a => a.id)), new Set(snapshot.channels.map(c => c.id)));
    if (!opened.current) {
      opened.current = true;
      if (!layout.tabs.length && snapshot.agents.length) {
        const recent = [...snapshot.agents].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        open({ kind: 'agent', agentId: recent.id });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.agents, snapshot?.channels]);

  // Opening an agent from anywhere (a tab, a channel) brings its project into the sidebar and
  // the terminal panel, with the sidebar shown or not.
  const focused = snapshot?.agents.find(a => a.id === focusedAgentId(layout));
  const focusedProject = focused ? startProjectId(focused) : undefined;
  useEffect(() => {
    if (focusedProject) setProject(focusedProject);
  }, [focusedProject]);

  // The browser tab shows how many agents are waiting on the user.
  const waiting = snapshot?.agents.filter(a => a.status === 'waiting').length ?? 0;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) PodCode` : 'PodCode';
  }, [waiting]);

  // An agent's settings link to Settings at a group (the SuperAgent's limits); see openSettingsAt.
  useEffect(() => {
    const onOpen = (event: Event) => setDialog({ kind: 'settings', group: (event as CustomEvent<{ group?: SettingsGroup }>).detail?.group });
    window.addEventListener('podcode:open-settings', onOpen);
    return () => window.removeEventListener('podcode:open-settings', onOpen);
  }, []);

  // The app menu's About PodCode (electron/main.ts) opens Settings at About.
  useEffect(() => window.podcodeDesktop?.updates?.onShowAbout?.(() => setDialog({ kind: 'settings', group: 'about' })), []);

  const actions: SidebarActions = {
    newAgent: projectId => setDialog({ kind: 'newAgent', projectId }),
    addProject: () => setDialog({ kind: 'addProject' }),
    settings: () => setDialog({ kind: 'settings' }),
    profile: () => setDialog({ kind: 'profile' }),
    agentSettings: agentId => setDialog({ kind: 'agentSettings', agentId }),
    removeAgent: agentId => setDialog({ kind: 'removeAgent', agentId }),
    newChannel: () => setDialog({ kind: 'newChannel' }),
    channelSettings: channelId => setDialog({ kind: 'channelSettings', channelId }),
    palette: () => setDialog({ kind: 'palette' }),
  };
  const superQuick = () => setDialog(d => (d?.kind === 'superQuick' ? null : { kind: 'superQuick' }));
  useShortcuts({ newAgent: () => actions.newAgent(layout.projectId ?? undefined), settings: actions.settings, palette: actions.palette, superQuick, blocked: dialog !== null });
  // The menu bar and the system-wide shortcut (desktop app), and notifications when it asks you something.
  useSuperBridge(() => setDialog({ kind: 'superQuick' }));
  const navFull = useNavFull();

  if (!snapshot) {
    return (
      <div className="body-glass grid h-full place-items-center font-sans text-sm text-content/50">
        <Shimmer duration={1.6}>{connection === 'closed' ? 'Waiting for the PodCode server on this machine…' : 'Connecting…'}</Shimmer>
      </div>
    );
  }

  // Agent dialogs read the live agent; they close on their own if it is removed meanwhile.
  const dialogAgent = dialog?.kind === 'agentSettings' || dialog?.kind === 'removeAgent' ? snapshot.agents.find(a => a.id === dialog.agentId) : undefined;
  const dialogChannel = dialog?.kind === 'channelSettings' ? snapshot.channels.find(c => c.id === dialog.channelId) : undefined;

  // In the desktop app the folded rail is narrower than the traffic lights, so, as MonoCode does,
  // the tab strip moves up to span the window and the lights sit at its start. The slots keep
  // the panes in place in the tree either way, so switching never remounts a session.
  const spans = IS_DESKTOP_APP && layout.sidebar && !navFull;
  const tabBar = <TabBar onNewAgent={() => actions.newAgent(layout.projectId ?? undefined)} underLights={spans || !layout.sidebar} />;

  return (
    <div className="body-glass flex h-full flex-col text-content">
      {spans ? tabBar : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        {layout.sidebar ? <Sidebars actions={actions} titleBarAbove={spans} /> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {spans ? null : tabBar}
          {/* Below 1280px the right panel floats over the panes instead of squeezing them. */}
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {/* Panes share the width by weight (web/paneSizes.ts); dividers move it, one pane can fill it. */}
            {layout.panes.map((pane, index) => {
              const maximized = layout.maximized && layout.panes.some(p => p.id === layout.maximized) ? layout.maximized : null;
              return (
                <Fragment key={pane.id}>
                  {index > 0 && !maximized ? <PaneDivider left={layout.panes[index - 1].id} right={pane.id} /> : null}
                  <div
                    data-pane-box={pane.id}
                    className={`min-h-0 min-w-0 ${maximized && maximized !== pane.id ? 'hidden' : 'flex'}`}
                    style={{ flexGrow: paneGrow(layout.paneWeights, layout.panes.map(p => p.id), pane.id), flexShrink: 1, flexBasis: 0 }}
                  >
                    <PaneView
                      pane={pane}
                      tab={layout.tabs.find(t => t.id === pane.tabId)}
                      actions={actions}
                      chrome={{
                        paneId: pane.id,
                        focused: pane.id === layout.focused,
                        canSplit: layout.panes.length < MAX_PANES,
                        multiple: layout.panes.length > 1,
                        maximized: maximized === pane.id,
                      }}
                    />
                  </div>
                </Fragment>
              );
            })}
            {layout.rightPanel ? <><div aria-hidden className="w-px shrink-0 bg-stroke max-xl:hidden" /><RightPanel /></> : null}
          </div>
          <TerminalPanel />
          <StatusFooter />
        </div>
      </div>
      {dialog?.kind === 'newAgent' ? <NewAgentDialog projectId={dialog.projectId} onClose={() => setDialog(null)} onAddProject={() => setDialog({ kind: 'addProject', thenNewAgent: true })} /> : null}
      {dialog?.kind === 'addProject' ? (
        <AddProjectDialog
          onClose={() => setDialog(d => (d?.kind === 'addProject' ? null : d))}
          onAdded={projectId => { if (dialog.thenNewAgent) setTimeout(() => setDialog({ kind: 'newAgent', projectId })); }}
        />
      ) : null}
      {dialog?.kind === 'settings' ? <SettingsDialog group={dialog.group} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'profile' ? <ProfileDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'agentSettings' && dialogAgent ? <AgentSettingsDialog agent={dialogAgent} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'removeAgent' && dialogAgent ? <RemoveAgentDialog agent={dialogAgent} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'newChannel' ? <ChannelDialog onClose={() => setDialog(null)} onNewAgent={() => setTimeout(() => setDialog({ kind: 'newAgent' }))} /> : null}
      {dialog?.kind === 'channelSettings' && dialogChannel ? <ChannelDialog key={dialogChannel.id} channel={dialogChannel} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'superQuick' ? <SuperQuickBar onClose={() => setDialog(d => (d?.kind === 'superQuick' ? null : d))} /> : null}
      {dialog?.kind === 'palette' ? <CommandPalette actions={actions} onClose={() => setDialog(d => (d?.kind === 'palette' ? null : d))} /> : null}
      <Toasts />
    </div>
  );
}
