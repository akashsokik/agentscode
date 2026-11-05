/** MonoCode's composer box for a channel, with an @mention list in a Popover. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Channel } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { someNames } from '../format.ts';
import { mentionQuery, resolveMentions } from '../mentions.ts';
import { attempt, useApp } from '../store.ts';
import { settleDraft } from '../threads.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import { MenuLabel, MenuRow } from '../ui/common.tsx';
import { ArrowUp } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';

/** Drafts by key, shared across mounts: a composer that closes and reopens picks up where it was. */
const drafts = new Map<string, string>();
/** The composers mounted on each draft key, told when a send that finished changes their draft. */
const draftListeners = new Map<string, Set<(text: string) => void>>();

const EVERYONE = { id: '__all', name: 'all' };

/** In the mention list, worded as the Members popover does: what a busy agent is on now. */
function busyLabel(agent: Agent): string {
  if (agent.status === 'waiting') return 'Needs you';
  if (agent.status === 'working') return agent.activity || 'Working';
  return '';
}

/**
 * MonoCode's composer box, with @mentions and a line saying exactly who a post starts.
 * With `threadId` it replies in that thread and keeps its own draft; render it with
 * `key={threadId}` so switching threads starts from that thread's draft.
 */
export function ChannelComposer({ channel, members, threadId }: { channel: Channel; members: Agent[]; threadId?: string }) {
  const projects = useApp(s => s.snapshot?.projects);
  const draftKey = threadId ? `${channel.id}:${threadId}` : channel.id;
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  /** A post that starts three or more agents needs a second Enter; this is the text that was armed. */
  const [armed, setArmed] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { drafts.set(draftKey, text); }, [draftKey, text]);
  useEffect(() => {
    const listener = (next: string) => { setText(next); setCaret(next.length); };
    let listeners = draftListeners.get(draftKey);
    if (!listeners) draftListeners.set(draftKey, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) draftListeners.delete(draftKey);
    };
  }, [draftKey]);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const query = mentionQuery(text, caret);
  const options = useMemo(() => {
    if (!query || query.start === dismissedAt) return [];
    const q = query.query.toLowerCase();
    // Names that start with what you typed first, then names that contain it; a few dozen at most.
    const starts = members.filter(m => m.name.toLowerCase().startsWith(q));
    const contains = q ? members.filter(m => !m.name.toLowerCase().startsWith(q) && m.name.toLowerCase().includes(q)) : [];
    const matches: { id: string; name: string; agent?: Agent }[] = [...starts, ...contains].slice(0, 30).map(m => ({ id: m.id, name: m.name, agent: m }));
    if (members.length > 1 && 'all'.startsWith(q)) matches.push(EVERYONE);
    return matches;
  }, [query?.start, query?.query, dismissedAt, members]);
  const active = Math.min(highlight, Math.max(0, options.length - 1));

  const mentioned = members.filter(m => resolveMentions(text, members).includes(m.id));
  const busy = mentioned.filter(m => m.status === 'working' || m.status === 'waiting');
  const confirming = armed !== null && armed === text.trim();
  const hint = !members.length
    ? 'Add members to start agents from here.'
    : confirming
      ? `Starts ${mentioned.length} agents: ${someNames(mentioned.map(m => m.name))}. Press Enter again to post.`
    : mentioned.length
      ? `Starts ${someNames(mentioned.map(m => m.name))}.${busy.length ? ` ${someNames(busy.map(m => m.name))} ${busy.length > 1 ? 'are' : 'is'} busy and will get to it next.` : ''}`
      // Short enough for the thread panel; the placeholder no longer repeats this.
      : text.trim()
        ? threadId ? 'No mention, so this reply starts nobody.' : 'No mention, so this posts as a note.'
        : threadId ? 'Type @ to start an agent in this thread.' : 'Type @ to start an agent, or @all for everyone.';

  const pick = (name: string) => {
    if (!query) return;
    const before = text.slice(0, query.start);
    const insert = `@${name} `;
    const next = before + insert + text.slice(caret);
    const at = before.length + insert.length;
    setText(next);
    drafts.set(draftKey, next);
    setCaret(at);
    setHighlight(0);
    requestAnimationFrame(() => field.current?.setSelectionRange(at, at));
  };

  const send = async () => {
    const sent = text;
    const value = sent.trim();
    if (!value || sending) return;
    // Starting many sessions at once costs real money; ask once, the way Agent Office does for @all.
    if (resolveMentions(value, members).length >= 3 && armed !== value) {
      setArmed(value);
      return;
    }
    setArmed(null);
    setSending(true);
    const ok = await attempt(() => api.post(channel.id, value, resolveMentions(value, members), threadId));
    setSending(false);
    if (ok) {
      // This composer may have closed while the post was in flight, and another opened on the same
      // draft. Clear only what was posted from the shared draft, then update whichever one is mounted.
      const rest = settleDraft(drafts, draftKey, sent);
      for (const listener of draftListeners.get(draftKey) ?? []) listener(rest);
    }
  };

  const trackCaret = () => setCaret(field.current?.selectionStart ?? 0);

  return (
    <div data-composer className="relative mx-auto w-full max-w-3xl shrink-0 p-1.5 pt-0">
      <div ref={box} data-composer-box className="relative z-10 rounded-lg border border-content/10">
        <textarea
          ref={field}
          value={text}
          rows={2}
          aria-label={threadId ? `Reply in thread, #${channel.name}` : `Message #${channel.name}`}
          onChange={e => { setText(e.target.value); drafts.set(draftKey, e.target.value); setCaret(e.target.selectionStart); setDismissedAt(null); }}
          onSelect={trackCaret}
          onClick={trackCaret}
          onKeyDown={e => {
            if (options.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(options[active].name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissedAt(query?.start ?? null);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={threadId ? 'Reply in thread' : `Message #${channel.name}`}
          className="scrollbar-none relative min-h-16 max-h-40 w-full resize-none overflow-x-hidden whitespace-pre-wrap wrap-break-word bg-transparent px-3 pb-1.5 pt-3.5 font-sans text-sm leading-5.5 text-content outline-none placeholder:text-content/40"
        />
        <div className="flex items-center gap-2 px-3 pb-2.5">
          <span className={`min-w-0 flex-1 truncate font-sans text-[12px] ${confirming ? 'text-warning' : 'text-content/45'}`} title={hint}>{hint}</span>
          <button
            type="button"
            title={mentioned.length ? 'Post and start' : 'Post'}
            aria-label={mentioned.length ? 'Post and start' : 'Post'}
            disabled={!text.trim() || sending}
            onClick={() => void send()}
            className="composer-send primary-action grid size-6.5 shrink-0 place-items-center rounded-md disabled:cursor-default"
          >
            <ArrowUp className="size-3.5" strokeWidth={2.25} />
          </button>
        </div>
      </div>
      {options.length ? (
        <Popover anchor={box} side="top" align="start" width={280} maxHeight={300} onDismiss={() => setDismissedAt(query?.start ?? null)} role="listbox" aria-label="Mention" className="overflow-y-auto overscroll-contain p-1">
          <MenuLabel>Mention to start</MenuLabel>
          {options.map((option, index) => (
            <MenuRow
              key={option.id}
              highlighted={index === active}
              title={option.agent
                ? <span className="flex items-center gap-1.5"><EngineIcon engine={option.agent.engine} className="size-3.5" />{option.name}</span>
                : '@all'}
              hint={option.agent
                ? [projects?.find(p => p.id === option.agent!.projectId)?.name, rolePreset(option.agent.role).name, busyLabel(option.agent)].filter(Boolean).join(', ')
                : `Every member: ${someNames(members.map(m => m.name))}.`}
              onSelect={() => { pick(option.name); field.current?.focus(); }}
            />
          ))}
        </Popover>
      ) : null}
    </div>
  );
}
