/**
 * The command palette (Cmd+K): jump to an agent, a channel or a project, or run an app action,
 * by typing a few letters. It is a Modal, so App treats it as one more dialog: other shortcuts
 * are held off while it is open, Escape closes it and focus goes back where it was.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { Agent } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { openBrowser } from '../browser.ts';
import { shortPath } from '../format.ts';
import { closeTab, currentProjectId, focusedAgentId, focusedChannelId, open, openToSide, setProject, setRightPanel, setSidebar, setSidebarView, useLayout } from '../layout.ts';
import { rankCommands } from '../paletteMatch.ts';
import { IS_MAC } from '../platform.ts';
import { MOD, SHORTCUTS } from '../shortcuts.ts';
import { projectLabel } from '../projects.ts';
import { showsWorkspace } from '../sidebar/agentRail.ts';
import { attempt, useApp } from '../store.ts';
import { hideTerminal, newTerminal, showTerminal, splitFront } from '../terminal/actions.ts';
import { setTheme, useTheme, type ThemePreference } from '../theme.ts';
import { cx } from './common.tsx';
import { EngineIcon } from './EngineIcon.tsx';
import { Check, Globe, Folder, FolderPlus, FolderTree, GitCompare, MessageMultiple, MessageSquarePlus, Palette, PanelBottom, PanelLeft, PanelRight, Plus, RotateCcw, Search, Settings, SlidersHorizontal, SplitColumns, SplitRows, Square, Terminal, Trash2, X, type IconComponent } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';

/** What the palette needs from the app shell: the dialogs it can open. */
export interface PaletteActions {
  newAgent: (projectId?: string) => void;
  addProject: () => void;
  settings: () => void;
  agentSettings: (agentId: string) => void;
  removeAgent: (agentId: string) => void;
  newChannel: () => void;
  channelSettings: (channelId: string) => void;
}

type Group = 'Agents' | 'Channels' | 'Actions' | 'Projects' | 'Theme';

interface Command {
  id: string;
  group: Group;
  /** What matching sees. Channels keep their # here, so "#gen" finds the channel first. */
  title: string;
  /** What the row shows, when it differs from the title: a channel's name beside its # icon. */
  label?: string;
  keywords?: string;
  hint?: string;
  icon: ReactNode;
  /** A status mark at the end of the row: a spinner, or the warning dot. */
  status?: ReactNode;
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
  priority: number;
  recency?: number;
  /** `side`: Cmd+Enter or Cmd+click, for commands that open something. */
  run: (side: boolean) => void;
}

/** With nothing typed, each of these groups shows its first few; typing searches all of them. */
const IDLE_LIMIT: Partial<Record<Group, number>> = { Agents: 8, Channels: 6 };
const GROUP_ORDER: Group[] = ['Agents', 'Channels', 'Actions', 'Projects', 'Theme'];
/** In search results the group reads as a kind, at the end of the row. */
const KIND: Record<Group, string> = { Agents: 'Agent', Channels: 'Channel', Actions: 'Action', Projects: 'Project', Theme: 'Theme' };

const icon = (Icon: IconComponent) => <Icon className="size-4 text-content/60" strokeWidth={1.75} />;

function agentStatus(agent: Agent, pending: boolean): { label: string; mark?: ReactNode } {
  if (pending || agent.status === 'waiting') return { label: 'Needs you', mark: <span aria-hidden className="size-1.5 rounded-full bg-warning" /> };
  if (agent.status === 'working') return { label: agent.activity || 'Working', mark: <TerminalSpinner className="text-content/45" /> };
  if (agent.status === 'error') return { label: 'Failed' };
  return { label: '' };
}

/** Builds every command from live state; the palette ranks and filters them as you type. */
function useCommands(actions: PaletteActions): Command[] {
  const snapshot = useApp(s => s.snapshot);
  const layout = useLayout();
  const theme = useTheme();
  return useMemo(() => {
    if (!snapshot) return [];
    const commands: Command[] = [];
    const projectName = (id: string | null) => projectLabel(id, snapshot.projects);
    const pending = (id: string) => snapshot.approvals.some(a => a.agentId === id);

    // Agents waiting on you first, then the most recently active.
    const agents = [...snapshot.agents].sort((a, b) => Number(b.status === 'waiting' || pending(b.id)) - Number(a.status === 'waiting' || pending(a.id)) || b.lastActiveAt - a.lastActiveAt);
    for (const agent of agents) {
      const status = agentStatus(agent, pending(agent.id));
      commands.push({
        id: `agent:${agent.id}`,
        group: 'Agents',
        title: agent.name,
        keywords: [projectName(agent.projectId), rolePreset(agent.role).name, agent.currentTask?.summary ?? ''].join(' '),
        hint: [projectName(agent.projectId), rolePreset(agent.role).name, status.label].filter(Boolean).join(' · '),
        icon: <EngineIcon engine={agent.engine} className="size-4" />,
        status: status.mark,
        priority: 2,
        recency: agent.lastActiveAt,
        run: side => (side ? openToSide : open)({ kind: 'agent', agentId: agent.id }),
      });
    }

    const channels = [...snapshot.channels].sort((a, b) => Number(b.unread) - Number(a.unread) || a.name.localeCompare(b.name));
    for (const channel of channels) {
      const members = channel.memberIds.length;
      commands.push({
        id: `channel:${channel.id}`,
        group: 'Channels',
        title: `#${channel.name}`,
        label: channel.name,
        keywords: channel.topic,
        hint: channel.topic || `${members} ${members === 1 ? 'member' : 'members'}`,
        icon: <span aria-hidden className="grid size-4 place-items-center text-[14px] leading-none text-content/60">#</span>,
        status: channel.unread ? <span aria-hidden className="size-1.5 rounded-full bg-accent" /> : undefined,
        priority: 2,
        run: side => (side ? openToSide : open)({ kind: 'channel', channelId: channel.id }),
      });
    }

    const action = (command: Omit<Command, 'group' | 'icon'> & { icon: IconComponent }) => commands.push({ ...command, group: 'Actions', icon: icon(command.icon) });
    action({ id: 'new-agent', title: 'New agent', keywords: 'create add session', icon: Plus, shortcut: SHORTCUTS.newAgent, priority: 3, run: () => actions.newAgent(layout.projectId ?? undefined) });
    action({ id: 'new-channel', title: 'New channel', keywords: 'create add room', icon: MessageSquarePlus, priority: 3, run: actions.newChannel });
    action({ id: 'add-project', title: 'Add project', keywords: 'open folder create new', icon: FolderPlus, priority: 3, run: actions.addProject });
    action({ id: 'comms', title: 'Open Comms', keywords: 'messages conversations delegations', icon: MessageMultiple, priority: 2, run: side => (side ? openToSide : open)({ kind: 'comms' }) });

    // The focused agent or channel, by name, so "ada" finds what you can do to Ada.
    const agent = snapshot.agents.find(a => a.id === focusedAgentId(layout));
    if (agent) {
      const busy = agent.status === 'working' || agent.status === 'waiting';
      action({ id: 'agent-settings', title: `${agent.name} settings`, keywords: 'agent model role instructions autonomy', icon: Settings, priority: 1, run: () => actions.agentSettings(agent.id) });
      if (busy) action({ id: 'agent-stop', title: `Stop ${agent.name}`, keywords: 'interrupt cancel turn', icon: Square, priority: 0, run: () => void attempt(() => api.stop(agent.id)) });
      else action({ id: 'agent-new-session', title: `New session for ${agent.name}`, keywords: 'clear reset context', icon: RotateCcw, priority: 0, run: () => void attempt(() => api.newSession(agent.id)) });
      action({ id: 'agent-remove', title: `Remove ${agent.name}…`, keywords: 'delete agent', icon: Trash2, danger: true, priority: 0, run: () => actions.removeAgent(agent.id) });
    }
    const channel = snapshot.channels.find(c => c.id === focusedChannelId(layout));
    if (channel) {
      action({ id: 'channel-settings', title: `#${channel.name} settings`, keywords: 'channel members topic rename', icon: SlidersHorizontal, priority: 1, run: () => actions.channelSettings(channel.id) });
    }

    const pane = layout.panes.find(p => p.id === layout.focused);
    if (pane?.tabId) action({ id: 'close-tab', title: 'Close tab', icon: X, shortcut: SHORTCUTS.closeTab, priority: 1, run: () => closeTab(pane.tabId!) });
    action({ id: 'sidebar', title: layout.sidebar ? 'Hide sidebar' : 'Show sidebar', keywords: 'toggle navigation', icon: PanelLeft, shortcut: SHORTCUTS.sidebar, priority: 1, run: () => setSidebar(!layout.sidebar) });
    action({ id: 'panel', title: layout.rightPanel ? 'Hide panel' : 'Show panel', keywords: 'toggle right overview', icon: PanelRight, shortcut: SHORTCUTS.panel, priority: 1, run: () => setRightPanel(!layout.rightPanel) });
    action({ id: 'browser', title: 'New browser tab', keywords: 'web preview localhost url page open site', icon: Globe, shortcut: SHORTCUTS.browser, priority: 1, run: side => openBrowser('', side) });
    const terminalProject = snapshot.projects.find(p => p.id === (layout.projectId ?? snapshot.projects[0]?.id)) ?? snapshot.projects[0];
    if (terminalProject) {
      action({ id: 'terminal', title: layout.terminal ? 'Hide terminal' : 'Show terminal', keywords: `toggle shell console panel ${terminalProject.name}`, hint: layout.terminal ? undefined : terminalProject.name, icon: PanelBottom, shortcut: SHORTCUTS.terminal, priority: 1, run: () => (layout.terminal ? hideTerminal() : showTerminal(terminalProject.id)) });
      action({ id: 'new-terminal', title: 'New terminal', keywords: `shell console ${terminalProject.name}`, hint: terminalProject.name, icon: Terminal, priority: 1, run: () => void newTerminal(terminalProject.id) });
      if (layout.terminal) {
        const inTerminal = IS_MAC ? 'In a terminal: ' : '';
        action({ id: 'split-terminal-right', title: 'Split terminal right', keywords: 'shell pane side by side', hint: IS_MAC ? `${inTerminal}⌘D` : undefined, icon: SplitColumns, priority: 1, run: () => splitFront('right') });
        action({ id: 'split-terminal-down', title: 'Split terminal down', keywords: 'shell pane below stacked', hint: IS_MAC ? `${inTerminal}⇧⌘D` : undefined, icon: SplitRows, priority: 1, run: () => splitFront('down') });
      }
    }
    // Files and changes live in the workspace column, which a project with no agents does not have.
    if (showsWorkspace(snapshot.agents, currentProjectId(layout, snapshot.projects.map(p => p.id)))) {
      action({ id: 'view-files', title: 'Show files', keywords: 'sidebar tree browse', icon: FolderTree, priority: 1, run: () => setSidebarView('files') });
      action({ id: 'view-changes', title: 'Show changes', keywords: 'sidebar git diff', icon: GitCompare, priority: 1, run: () => setSidebarView('changes') });
    }
    action({ id: 'settings', title: 'Settings', keywords: 'preferences options', icon: Settings, shortcut: SHORTCUTS.settings, priority: 1, run: actions.settings });

    for (const project of snapshot.projects) {
      commands.push({
        id: `project:${project.id}`,
        group: 'Projects',
        title: project.name,
        keywords: project.path,
        hint: shortPath(project.path, snapshot.home),
        icon: icon(Folder),
        checked: project.id === (layout.projectId ?? snapshot.projects[0]?.id),
        priority: 1,
        // A project with no agents has no workspace column to show, so offer its first agent instead.
        run: () => { setProject(project.id); setSidebar(true); if (project.exists && !showsWorkspace(snapshot.agents, project.id)) actions.newAgent(project.id); },
      });
    }

    const themes: [ThemePreference, string][] = [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']];
    for (const [value, label] of themes) {
      commands.push({ id: `theme:${value}`, group: 'Theme', title: `Theme: ${label}`, keywords: 'appearance color mode', icon: icon(Palette), checked: theme === value, priority: 1, run: () => setTheme(value) });
    }
    return commands;
  }, [snapshot, layout, theme, actions]);
}

type Section = { group: Group | null; items: Command[] };

/** Nothing typed: each group under its heading, long ones trimmed. Typing: one ranked list. */
function arrange(commands: Command[], query: string): Section[] {
  if (query.trim()) return [{ group: null, items: rankCommands(commands, query) }];
  return GROUP_ORDER
    .map(group => ({ group, items: commands.filter(c => c.group === group).slice(0, IDLE_LIMIT[group] ?? Infinity) }))
    .filter(section => section.items.length);
}

export function CommandPalette({ actions, onClose }: { actions: PaletteActions; onClose: () => void }) {
  const commands = useCommands(actions);
  const [query, setQuery] = useState('');
  // The highlighted command by id, so it stays put when live updates re-sort the list.
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const sections = useMemo(() => arrange(commands, query), [commands, query]);
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections]);
  const current = Math.max(0, flat.findIndex(c => c.id === activeId));
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => { setActiveId(null); }, [query]);
  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Close first, then run: a command that opens a dialog must mount after the palette has
  // handed focus back, or the new dialog would record the palette's field as its opener.
  const run = (command: Command | undefined, side: boolean) => {
    if (!command) return;
    onClose();
    setTimeout(() => command.run(side));
  };

  let index = -1;
  return (
    <Modal title="Command palette" size="md" minimalHeader hideClose onClose={onClose}>
      {/* The field keeps focus wherever you click, so typing and the arrows go on working. */}
      <div className="flex flex-col font-sans" onMouseDown={e => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-content/7 px-4">
          <Search aria-hidden className="size-4 shrink-0 text-content/45" strokeWidth={1.75} />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              const mod = IS_MAC ? e.metaKey : e.ctrlKey;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (flat.length) setActiveId(flat[(current + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length].id);
              } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                run(flat[current], mod);
              } else if (mod && e.code === 'KeyK') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'Tab') {
                // Focus stays in the field; the arrows move through the list.
                e.preventDefault();
              }
            }}
            placeholder="Search agents, channels and actions"
            aria-label="Search agents, channels and actions"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={flat.length ? optionId(current) : undefined}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-content outline-none placeholder:text-content/35"
          />
          <kbd className="shrink-0 rounded border border-content/10 px-1.5 py-0.5 text-[10px] text-content/40">Esc</kbd>
        </label>
        <div id={listId} role="listbox" aria-label="Commands" className="max-h-[min(420px,55vh)] overflow-y-auto overscroll-contain p-1.5">
          {flat.length ? sections.map(section => (
            <div key={section.group ?? 'results'} role="group" aria-label={section.group ?? 'Results'}>
              {section.group ? <p className="px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-content/40">{section.group}</p> : null}
              {section.items.map(command => {
                index += 1;
                const at = index;
                const selected = at === current;
                return (
                  <div
                    key={command.id}
                    id={optionId(at)}
                    role="option"
                    aria-selected={selected}
                    aria-checked={command.checked}
                    onMouseMove={() => { if (!selected) setActiveId(command.id); }}
                    onClick={e => run(command, IS_MAC ? e.metaKey : e.ctrlKey)}
                    className={cx(
                      'flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px]',
                      selected ? 'bg-selection' : '',
                      command.danger ? 'text-danger' : 'text-content',
                    )}
                  >
                    <span className="grid size-4 shrink-0 place-items-center">{command.icon}</span>
                    <span className="min-w-0 max-w-[65%] shrink-0 truncate font-medium">{command.label ?? command.title}</span>
                    {command.hint ? <span className="min-w-0 flex-1 truncate text-[12px] text-content/45">{command.hint}</span> : <span className="flex-1" />}
                    {command.status ? <span className="flex shrink-0 items-center">{command.status}</span> : null}
                    {command.checked ? <Check className="size-3.5 shrink-0 text-content/70" strokeWidth={2.25} /> : null}
                    {command.shortcut ? <kbd className="shrink-0 text-[11px] text-content/40">{command.shortcut}</kbd> : null}
                    {section.group ? null : <span className="w-14 shrink-0 text-right text-[11px] text-content/35">{KIND[command.group]}</span>}
                  </div>
                );
              })}
            </div>
          )) : <p className="px-2.5 py-6 text-center text-[13px] text-content/45">Nothing matches “{query.trim()}”.</p>}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-4 border-t border-content/7 px-4 text-[11px] text-content/40">
          <span>↑↓ to move</span>
          <span>↵ to run</span>
          <span>{MOD}↵ to open beside</span>
          <span className="ml-auto">{SHORTCUTS.palette} to close</span>
        </div>
      </div>
    </Modal>
  );
}
