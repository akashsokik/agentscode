/**
 * A channel: the user and invited agents from any project, laid out like Slack. The main list
 * shows top-level posts; replies live in threads, opened in a panel docked on the right
 * (ChannelThread). Posts render through ChannelPosts and the reply box is ChannelComposer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Channel } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { open } from '../layout.ts';
import { attempt, loadPosts, useApp } from '../store.ts';
import { buildThreads } from '../threads.ts';
import { ChannelDialog } from '../dialogs/ChannelDialog.tsx';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { ChipButton, Empty, HeaderButton, MenuLabel, MenuRow } from '../ui/common.tsx';
import { Bot, ChevronDown, Search, Settings } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { Shimmer } from '../mono/Shimmer.tsx';
import { TabLabel } from '../mono/TabLabel.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';
import { ChannelComposer } from './ChannelComposer.tsx';
import { ActivityLine, JumpToLatest, PostList, SPINNER, useFollowLatest } from './ChannelPosts.tsx';
import { ChannelThread } from './ChannelThread.tsx';
import { PaneFrame, type PaneChrome } from './PaneFrame.tsx';

/** The thread open in each channel, so it is still open when you come back to the tab. */
const openThreads = new Map<string, string>();

/** The member pill and its list: MonoCode's ModelPicker trigger with a Popover, searchable when long. */
function Members({ channel, members, onEdit }: { channel: Channel; members: Agent[]; onEdit: () => void }) {
  const [shown, setShown] = useState(false);
  const [filter, setFilter] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const projects = useApp(s => s.snapshot?.projects);
  const projectName = (id: string) => projects?.find(p => p.id === id)?.name ?? '';
  const q = filter.trim().toLowerCase();
  const listed = q ? members.filter(m => [m.name, projectName(m.projectId), rolePreset(m.role).name].some(f => f.toLowerCase().includes(q))) : members;
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setShown(v => !v)}
        title={`Members of #${channel.name}`}
        className="flex h-6.5 shrink-0 items-center gap-1 rounded-md bg-selection px-1.5 font-sans text-[11px] text-content hover:bg-selection-hover"
      >
        <Bot className="size-3.5 text-content/60" strokeWidth={1.75} />
        <span>{members.length} {members.length === 1 ? 'member' : 'members'}</span>
        <ChevronDown className={`size-3 text-content/50 ${shown ? 'rotate-180' : ''}`} strokeWidth={1.75} />
      </button>
      {shown ? (
        <Popover anchor={root} side="bottom" align="end" width={290} maxHeight={420} onDismiss={() => { setShown(false); setFilter(''); }} className="overflow-y-auto overscroll-contain p-1">
          {members.length > 8 ? (
            <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
              <Search className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />
              <input autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Find a member" aria-label="Find a member" className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-content outline-none placeholder:text-content/35" />
            </div>
          ) : null}
          <MenuLabel>You and {members.length} {members.length === 1 ? 'agent' : 'agents'}</MenuLabel>
          {listed.slice(0, 100).map(agent => (
            <MenuRow
              key={agent.id}
              title={<span className="flex items-center gap-1.5"><EngineIcon engine={agent.engine} className="size-3.5" />{agent.name}</span>}
              hint={[projectName(agent.projectId), rolePreset(agent.role).name, agent.status === 'working' ? agent.activity || 'Working' : agent.status === 'waiting' ? 'Needs you' : ''].filter(Boolean).join(', ')}
              onSelect={() => { setShown(false); open({ kind: 'agent', agentId: agent.id }); }}
            />
          ))}
          {q && !listed.length ? <p className="px-2 py-1.5 font-sans text-[12px] text-content/45">No member matches.</p> : null}
          {listed.length > 100 ? <p className="px-2 py-1.5 font-sans text-[11px] text-content/40">Showing 100 of {listed.length}. Type to narrow.</p> : null}
          <MenuRow icon={Settings} title="Add or remove members" hint="Agents from any project." onSelect={() => { setShown(false); onEdit(); }} />
        </Popover>
      ) : null}
    </div>
  );
}

/** A channel with the user and invited agents. */
export function ChannelPane({ channelId, chrome }: { channelId: string; chrome: PaneChrome }) {
  const channel = useApp(s => s.snapshot?.channels.find(c => c.id === channelId));
  const allAgents = useApp(s => s.snapshot?.agents);
  const posts = useApp(s => s.posts[channelId]);
  const [editing, setEditing] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(() => openThreads.get(channelId) ?? null);

  const agents = allAgents ?? [];
  const members = useMemo(() => (channel?.memberIds ?? []).map(id => allAgents?.find(a => a.id === id)).filter((a): a is Agent => Boolean(a)), [channel?.memberIds, allAgents]);
  const working = members.filter(m => m.currentTask?.channelId === channelId && (m.status === 'working' || m.status === 'waiting'));
  const { main, threads } = useMemo(() => buildThreads(posts ?? []), [posts]);
  const root = threadId ? main.find(p => p.id === threadId) : undefined;
  const follow = useFollowLatest(main.length);

  useEffect(() => { void loadPosts(channelId); }, [channelId]);
  useEffect(() => {
    if (channel?.unread && chrome.focused) void attempt(() => api.channelSeen(channelId));
  }, [channel?.unread, chrome.focused, channelId]);
  useEffect(() => {
    if (threadId) openThreads.set(channelId, threadId);
    else openThreads.delete(channelId);
  }, [channelId, threadId]);
  const closeThread = useCallback(() => setThreadId(null), []);

  if (!channel) {
    return <PaneFrame chrome={chrome} title="Channel deleted"><Empty title="This channel was deleted." /></PaneFrame>;
  }

  const waiting = working.filter(m => m.status === 'waiting');
  const running = working.filter(m => m.status === 'working');
  return (
    <PaneFrame
      chrome={chrome}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-content/45">#</span>
          <span className="shrink-0 text-content">{channel.name}</span>
          {channel.topic ? <TabLabel className="font-normal text-content/45">{channel.topic}</TabLabel> : null}
          {running.length ? <TerminalSpinner className={`${SPINNER} text-content/45`} /> : null}
        </span>
      }
      actions={
        <>
          <Members channel={channel} members={members} onEdit={() => setEditing(true)} />
          <HeaderButton icon={Settings} label="Channel settings" onClick={() => setEditing(true)} />
        </>
      }
    >
      <div className="@container flex min-h-0 min-w-0 flex-1">
        {/* In a narrow pane an open thread takes the whole width; Close brings the channel back. */}
        <div className={`min-h-0 min-w-0 flex-1 flex-col ${root ? 'hidden @min-[44rem]:flex' : 'flex'}`}>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div ref={follow.ref} onScroll={follow.onScroll} className="agent-transcript min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl pb-4 pt-2">
                <div className="px-4 pb-2 pt-4 font-sans">
                  <p className="text-[13px] font-medium text-content/80">This is the start of #{channel.name}.</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-content/45">
                    Mention @name to start an agent in its own project; its reply lands in a thread under your post. Agents can mention each other too. Posts without a mention are notes that start nobody.
                  </p>
                  {members.length ? null : <ChipButton className="mt-3" onClick={() => setEditing(true)}>Add members</ChipButton>}
                </div>
                {posts === undefined ? <div className="px-4 py-8 text-center font-sans text-sm text-content/40"><Shimmer duration={1.6}>Loading…</Shimmer></div> : null}
                <PostList posts={main} agents={agents} threads={threads} onOpenThread={setThreadId} />
                <ActivityLine working={running} waiting={waiting} />
              </div>
            </div>
            <JumpToLatest count={follow.newPosts} onClick={follow.jump} />
          </div>
          <ChannelComposer channel={channel} members={members} />
        </div>
        {root ? (
          <ChannelThread key={root.id} channel={channel} root={root} thread={threads.get(root.id)} members={members} agents={agents} focused={chrome.focused} onClose={closeThread} />
        ) : null}
      </div>
      {editing ? <ChannelDialog channel={channel} onClose={() => setEditing(false)} /> : null}
    </PaneFrame>
  );
}
