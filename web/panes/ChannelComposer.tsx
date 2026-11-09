/** MonoCode's composer box for a channel, with the same @ picker as the agent composer. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Channel } from '../../shared/types.ts';
import { channelRecipients, findMentions } from '../../shared/mentions.ts';
import { api } from '../api.ts';
import { useProjectsFiles } from '../composer/catalog.ts';
import { mentionNames, useMentionHints } from '../composer/mentionHints.ts';
import { MentionPicker } from '../composer/Pickers.tsx';
import { mentionTokenAt, pickValue, rankMentions, replaceToken, withFolders, type MentionPick } from '../composer/tokens.ts';
import { someNames } from '../format.ts';
import { attempt, useApp } from '../store.ts';
import { settleDraft } from '../threads.ts';
import { TextButton } from '../ui/common.tsx';
import { ArrowUp, ImagePlus } from '../mono/icons.tsx';
import { ToolButton } from './Composer.tsx';
import { ComposerImageTray, useChannelImages } from './ComposerImages.tsx';

/** Drafts by key, shared across mounts: a composer that closes and reopens picks up where it was. */
const drafts = new Map<string, string>();
/** The composers mounted on each draft key, told when a send that finished changes their draft. */
const draftListeners = new Map<string, Set<(text: string) => void>>();

/**
 * MonoCode's composer box, with @mentions and a line saying exactly who a post starts.
 * With `threadId` it replies in that thread and keeps its own draft; render it with
 * `key={threadId}` so switching threads starts from that thread's draft.
 */
export function ChannelComposer({ channel, members, threadId }: { channel: Channel; members: Agent[]; threadId?: string }) {
  const projects = useApp(s => s.snapshot?.projects);
  const agents = useApp(s => s.snapshot?.agents);
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
  const images = useChannelImages(channel.id, draftKey, () => field.current?.focus());
  const hasContent = Boolean(text.trim()) || images.ready.length > 0;
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

  // The same @ picker as the agent composer: members first (a mention starts them), then other agents,
  // projects, and files in the members' projects as project/path.
  const query = mentionTokenAt(text, caret, mentionNames(agents, projects));
  const open = Boolean(query) && query?.start !== dismissedAt;
  const memberProjects = useMemo(() => {
    const ids = new Set(members.map(m => m.projectId).filter((id): id is string => Boolean(id)));
    return (projects ?? []).filter(p => ids.has(p.id));
  }, [members, projects]);
  const projectFiles = useProjectsFiles(memberProjects, open);
  const folders = useMemo(() => withFolders(projectFiles.value?.files ?? []), [projectFiles.value]);
  const options = useMemo(() => {
    if (!open || !query) return [];
    const memberIds = new Set(members.map(m => m.id));
    return rankMentions({
      agents: [...members, ...(agents ?? []).filter(a => !memberIds.has(a.id))],
      projects: projects ?? [],
      files: folders,
      query: query.query,
      everyone: members.length > 1,
    });
  }, [open, query?.query, members, agents, projects, folders]);
  const active = Math.min(highlight, Math.max(0, options.length - 1));
  useEffect(() => { setHighlight(0); }, [query?.query]);

  // Who a post starts comes from the same parse as its chips (shared/mentions.ts): a name in code,
  // an email or a path starts nobody, and a picked project never starts the agent that shares its name.
  const hints = useMentionHints();
  const recipients = (value: string) => channelRecipients(value, members.map(m => m.id), { agents: agents ?? [], projects: projects ?? [], hints: hints.for(value) });
  const startIds = recipients(text);
  const mentioned = members.filter(m => startIds.includes(m.id));
  // Agents named here who are not members: a mention cannot start them, so say so and offer to add them.
  const outsiders = useMemo(() => {
    const memberIds = new Set(channel.memberIds);
    const named = findMentions(text, { agents: agents ?? [], projects: projects ?? [], channel: true, hints: hints.for(text) }).filter(m => m.kind === 'agent' && !memberIds.has(m.id));
    return [...new Map(named.map(m => [m.kind === 'agent' ? m.id : '', m])).values()].map(m => (m.kind === 'agent' ? (agents ?? []).find(a => a.id === m.id) : undefined)).filter((a): a is Agent => Boolean(a));
  }, [text, agents, projects, channel.memberIds, hints]);
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

  const caretAfter = useRef<number | null>(null);
  const pick = (choice: MentionPick) => {
    if (!query) return;
    hints.add(choice, query.start);
    const next = replaceToken(text, query, '@', pickValue(choice));
    caretAfter.current = next.caret;
    setText(next.text);
    drafts.set(draftKey, next.text);
    setCaret(next.caret);
    setHighlight(0);
  };
  // A pick moves the caret past what it wrote, once the new text is in the field.
  useLayoutEffect(() => {
    if (caretAfter.current == null) return;
    field.current?.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  const invite = (agent: Agent) => void attempt(() => api.updateChannel(channel.id, { memberIds: [...channel.memberIds, agent.id] }));

  const send = async () => {
    const sent = text;
    const value = sent.trim();
    // Images still uploading would be left behind, so Post waits for them.
    if ((!value && !images.ready.length) || images.uploading || sending) return;
    // Starting many sessions at once costs real money; ask once, the way Agent Office does for @all.
    if (recipients(value).length >= 3 && armed !== value) {
      setArmed(value);
      return;
    }
    setArmed(null);
    setSending(true);
    const attached = images.ready;
    const ok = await attempt(() => api.post(channel.id, value, recipients(value), threadId, attached, hints.for(value)));
    setSending(false);
    if (ok) {
      images.clear();
      hints.clear();
      // This composer may have closed while the post was in flight, and another opened on the same
      // draft. Clear only what was posted from the shared draft, then update whichever one is mounted.
      const rest = settleDraft(drafts, draftKey, sent);
      for (const listener of draftListeners.get(draftKey) ?? []) listener(rest);
    }
  };

  const trackCaret = () => setCaret(field.current?.selectionStart ?? 0);

  return (
    <div data-composer className="relative mx-auto w-full max-w-3xl shrink-0 p-1.5 pt-0">
      <div ref={box} data-composer-box className="relative z-10 rounded-lg border border-content/10 has-focus:border-content/20" {...images.dropProps}>
        <ComposerImageTray images={images} />
        <textarea
          ref={field}
          value={text}
          rows={2}
          aria-label={threadId ? `Reply in thread, #${channel.name}` : `Message #${channel.name}`}
          onChange={e => { setText(e.target.value); drafts.set(draftKey, e.target.value); setCaret(e.target.selectionStart); setDismissedAt(null); }}
          onSelect={trackCaret}
          onClick={trackCaret}
          onPaste={images.onPaste}
          onKeyDown={e => {
            if (open && e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDismissedAt(query?.start ?? null);
              return;
            }
            if (options.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlight((active + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(options[active]);
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
        {/* MonoCode's toolbar row, as in the agent Composer: tools on the left, send on the right. */}
        <div className="flex items-center gap-1 px-2 pb-2.5">
          <ToolButton label="Attach images (or paste one)" disabled={images.full} onClick={images.pick}>
            <ImagePlus className="size-3.5" strokeWidth={1.5} />
          </ToolButton>
          {images.input}
          <div className="composer-toolbar flex min-w-0 flex-1 items-center" />
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              title={mentioned.length ? 'Post and start' : 'Post'}
              aria-label={mentioned.length ? 'Post and start' : 'Post'}
              disabled={!hasContent || images.uploading || sending}
              onClick={() => void send()}
              className="composer-send primary-action grid size-6.5 place-items-center rounded-md transition-[background-color,transform] duration-150 active:scale-[0.94] disabled:cursor-default disabled:active:scale-100"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.25} />
            </button>
          </div>
        </div>
      </div>
      {/* Under the box, where the agent Composer shows its folder: who this post starts. */}
      <div className={`flex min-w-0 items-center gap-2.5 overflow-hidden px-[15px] pt-1.5 font-sans text-[12px] ${confirming ? 'text-warning' : 'text-content/50'}`}>
        <span className="min-w-0 truncate" title={hint}>{hint}</span>
        {outsiders.length ? (
          <span className="flex shrink-0 items-center gap-1 text-content/50">
            <span>{someNames(outsiders.map(a => a.name))} {outsiders.length > 1 ? 'are' : 'is'} not in #{channel.name}.</span>
            <TextButton onClick={() => { for (const agent of outsiders) invite(agent); }}>Add to #{channel.name}</TextButton>
          </span>
        ) : null}
      </div>
      {open ? (
        <div className="absolute inset-x-1.5 bottom-full z-30 mb-1">
          <MentionPicker
            picks={options}
            query={query?.query ?? ''}
            active={active}
            loading={projectFiles.loading}
            truncated={projectFiles.value?.truncated}
            label="Mention"
            onActive={setHighlight}
            onPick={choice => { pick(choice); field.current?.focus(); }}
          />
        </div>
      ) : null}
    </div>
  );
}
