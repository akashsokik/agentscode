/**
 * The thread panel, docked on the right of a channel the way Slack docks a thread: a header,
 * the root post, its replies and a reply box. Mentions there start agents whose replies land
 * in the thread. Below a container width of 44rem it takes the whole pane instead.
 */
import { IS_MAC } from '../platform.ts';
import { formatKeys } from '../keys.ts';
import { useEffect, useRef } from 'react';
import type { Agent, Channel, ChannelPost } from '../../shared/types.ts';
import type { Thread } from '../threads.ts';
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
    // MonoCode's MonoSidebar: docked on the right with its MonoSidebarHeader.
    <aside aria-label={`Thread in #${channel.name}`} className="relative flex min-h-0 w-full shrink-0 flex-col border-stroke font-sans @min-[44rem]:w-[min(26rem,45%)] @min-[44rem]:border-l">
      <header className="flex h-10 shrink-0 items-stretch border-b border-stroke">
        <h3 className="flex min-w-0 flex-1 items-center gap-1.5 pl-4 text-[13px] font-medium text-content">
          <span className="shrink-0">Thread</span>
          <span className="min-w-0 truncate font-normal text-content/45">#{channel.name}</span>
        </h3>
        <div className="flex shrink-0 items-center gap-0.5 px-3">
          <button type="button" title={`Close thread (${formatKeys('Escape', IS_MAC)})`} aria-label="Close thread" onClick={onClose} className="grid size-6 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content">
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={follow.ref} onScroll={follow.onScroll} className="agent-transcript min-h-0 flex-1 overflow-y-auto pb-3 pt-2">
          <PostList posts={[root]} agents={agents} inThread />
          {/* MonoCode's InterjectionDivider, between the root and its replies. */}
          <div role="separator" className="flex items-center gap-3 px-4 pb-1 pt-1">
            <div className="h-px min-w-4 flex-1 bg-content/12" />
            <span className="px-1.5 font-sans text-[12px] text-content/55">{count ? `${count} ${count === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span>
            <div className="h-px min-w-4 flex-1 bg-content/12" />
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
