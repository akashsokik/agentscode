import type { ChannelPost } from '../../shared/types.ts';

/** Resolve old reply chains as well as explicit thread ids, without crossing channel boundaries. */
export function threadRoot(posts: ReadonlyMap<string, ChannelPost>, id: string, channelId: string): ChannelPost | undefined {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const post = posts.get(current);
    if (!post || post.channelId !== channelId || post.kind === 'event') return undefined;
    const parent = post.threadId ?? post.inReplyTo;
    if (!parent) return post;
    current = parent;
  }
  return undefined;
}

/** Keep recent posts in first-seen order, including the older roots needed to display their threads. */
export function withThreadRoots(posts: ChannelPost[], limit: number): ChannelPost[] {
  const recent = posts.slice(-limit);
  const ids = new Set(recent.map(p => p.id));
  const byId = new Map(posts.map(p => [p.id, p]));
  for (const post of recent) {
    const root = threadRoot(byId, post.id, post.channelId);
    if (root) ids.add(root.id);
  }
  return posts.filter(p => ids.has(p.id));
}
