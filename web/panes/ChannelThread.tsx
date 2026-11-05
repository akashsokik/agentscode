/**
 * The thread panel, docked on the right of a channel the way Slack docks a thread: a header,
 * the root post, its replies and a reply box. Mentions there start agents whose replies land
 * in the thread. Below a container width of 44rem it takes the whole pane instead.
 */
import { useEffect, useRef } from 'react';
import type { Agent, Channel, ChannelPost } from '../../shared/types.ts';
import type { Thread } from '../threads.ts';
import { HeaderButton } from '../ui/common.tsx';
import { X } from '../mono/icons.tsx';
import { ChannelComposer } from './ChannelComposer.tsx';
import { ActivityLine, JumpToLatest, PostList, threadActivity, useFollowLatest } from './ChannelPosts.tsx';

export function ChannelThread({ channel, root, thread, members, agents, focused, onClose }: {
  channel: Channel;
  root: ChannelPost;
  thread: Thread | undefined;
  members: Agent[];
  agents: Agent[];
  /** Escape closes the thread only while its pane has focus. */
  focused: boolean;
  onClose: () => void;
}) {
  const replies = thread?.replies ?? [];
  const follow = useFollowLatest(replies.length);
  const activity = threadActivity([root, ...replies], agents);
  const count = replies.filter(r => r.kind !== 'event').length;
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!focused) return;
    // Bubble phase: an open popover, the mention list or a dialog handles Escape first and marks it handled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  return (
    <aside aria-label={`Thread in #${channel.name}`} className="flex min-h-0 w-full shrink-0 flex-col border-stroke @min-[44rem]:w-[min(26rem,45%)] @min-[44rem]:border-l">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke pl-4 pr-1.5 font-sans">
        <span className="shrink-0 text-[13px] font-semibold text-content">Thread</span>
        <span className="min-w-0 truncate text-[12px] text-content/45">#{channel.name}</span>
        <HeaderButton icon={X} label="Close thread (Esc)" className="ml-auto" onClick={onClose} />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={follow.ref} onScroll={follow.onScroll} className="agent-transcript min-h-0 flex-1 overflow-y-auto pb-3">
          <PostList posts={[root]} agents={agents} inThread />
          <div className="flex items-center gap-2 px-4 pb-1 pt-2 font-sans text-[12px] text-content/45">
            <span className="shrink-0">{count ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span>
            <span className="h-px flex-1 bg-content/10" />
          </div>
          <PostList posts={replies} agents={agents} inThread after={root} />
          <ActivityLine {...activity} />
        </div>
        <JumpToLatest count={follow.newPosts} onClick={follow.jump} />
      </div>
      <ChannelComposer key={root.id} channel={channel} members={members} threadId={root.id} />
    </aside>
  );
}
