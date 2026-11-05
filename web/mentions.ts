import type { Agent } from '../shared/types.ts';

/** @all, @channel and @here address every member. */
const EVERYONE = /(^|[^\w@])@(all|channel|here)(?![\w-])/i;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The members a post mentions with @Name (names may contain spaces), or all of them for @all. */
export function resolveMentions(text: string, members: Agent[]): string[] {
  if (EVERYONE.test(text)) return members.map(m => m.id);
  return members.filter(m => new RegExp(`(^|[^\\w@])@${escape(m.name)}(?![\\w-])`, 'i').test(text)).map(m => m.id);
}

/** The @word being typed just before the caret, if any. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}
