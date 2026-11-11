/**
 * The message box, following MonoCode's Composer (inset layout): QuestionForm above
 * the box, the textarea, a toolbar with ToolButton, the ModelPicker trigger pill,
 * AccessPicker and ComposerAction, and the workspace bar under the box. As in MonoCode, `/` opens
 * the commands and skills picker and `@` the project files picker, right above the box.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import type { ComposerCommand } from '../../shared/composer.ts';
import { noProjectFolder, type Agent, type Approval, type AgentPatch, type Project } from '../../shared/types.ts';
import { useAgentCommands, useAgentFiles } from '../composer/catalog.ts';
import { mentionNames, useMentionHints } from '../composer/mentionHints.ts';
import { ModelPicker } from '../composer/ModelPicker.tsx';
import { CommandPicker, MentionPicker } from '../composer/Pickers.tsx';
import {
  BUILTIN_COMMANDS,
  builtinCommand,
  isLeading,
  mentionTokenAt,
  pickValue,
  rankCommands,
  rankMentions,
  replaceToken,
  slashTokenAt,
  withFolders,
  type MentionPick,
  type Token,
} from '../composer/tokens.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { attempt, useApp } from '../store.ts';
import { MenuLabel, MenuRow } from '../ui/common.tsx';
import { AccessPicker } from '../mono/AccessPicker.tsx';
import { ContextMeter } from '../mono/ContextMeter.tsx';
import { contextPercent } from '../../shared/contextUsage.ts';
import { APPROVAL_KEY_GUARD_MS } from '../approvalText.ts';
import { ArrowUp, Folder, GitBranch, ImagePlus, MoreHorizontal, RotateCcw, Settings, Square } from '../mono/icons.tsx';
import { Popover } from '../mono/Popover.tsx';
import { QuestionForm } from '../mono/QuestionForm.tsx';
import { questionsFromUnknown, selectedAnswerLabels, type UserQuestionReply } from '../mono/userQuestion.ts';
import { imageFiles, MAX_IMAGES, pastedImages } from '../attachments.ts';
import { AttachmentChip } from './ImageViews.tsx';
import { useComposerImages } from './useComposerImages.ts';

const drafts = new Map<string, string>();

function patch(agent: Agent, change: AgentPatch) {
  return attempt(() => api.updateAgent(agent.id, change));
}

/** MonoCode's ToolButton, as a ghost: no plate until it is pointed at or on. */
export function ToolButton({ active, disabled, label, onClick, children }: { active?: boolean; disabled?: boolean; label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-6.5 shrink-0 place-items-center rounded-md transition-colors duration-150 ${
        active ? 'bg-selection-emphasis text-content' : 'text-content/55 hover:bg-selection-hover hover:text-content'
      } disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-content/55`}
    >
      {children}
    </button>
  );
}

/** A key name in the composer's hints. */
function KeyHint({ children }: { children: ReactNode }) {
  return <kbd className="mr-1 rounded bg-content/[0.07] px-1 py-px font-sans text-content/50">{children}</kbd>;
}

/** MonoCode's ComposerAction: send, or stop while the agent works. */
function ComposerAction({ busy, hasValue, onSend, onStop }: { busy: boolean; hasValue: boolean; onSend: () => void; onStop: () => void }) {
  if (busy && !hasValue) {
    return (
      <button type="button" title="Stop" aria-label="Stop" onClick={onStop} className="primary-action grid size-6.5 place-items-center rounded-lg transition-[background-color,transform] duration-150 active:scale-[0.94]">
        <Square className="size-2.5 fill-current" strokeWidth={0} />
      </button>
    );
  }
  return (
    <button type="button" title={busy ? 'Queue message' : 'Send'} aria-label={busy ? 'Queue message' : 'Send'} disabled={!hasValue} onClick={onSend} className="composer-send primary-action grid size-6.5 place-items-center rounded-lg transition-[background-color,transform] duration-150 active:scale-[0.94] disabled:cursor-default disabled:active:scale-100">
      <ArrowUp className="size-3.5" strokeWidth={2.25} />
    </button>
  );
}

/** Answers a Claude AskUserQuestion through MonoCode's QuestionForm. */
function QuestionPrompt({ approval }: { approval: Approval }) {
  const questions = useMemo(() => questionsFromUnknown({ questions: approval.questions ?? [] }), [approval.questions]);
  const prompt = useMemo(() => ({ requestId: 0, title: approval.title, questions }), [approval.title, questions]);
  const onReply = (_requestId: number, reply: UserQuestionReply) => {
    if (reply.kind === 'skipped') {
      void attempt(() => api.resolveApproval(approval.id, { allow: false, message: 'The user skipped the question.' }));
      return;
    }
    // Claude expects answers keyed by question text, with labels joined.
    const answers: Record<string, string> = {};
    for (const question of questions) {
      answers[question.prompt] = selectedAnswerLabels(question, reply).join(', ');
    }
    void attempt(() => api.resolveApproval(approval.id, { allow: true, answers }));
  };
  return <QuestionForm prompt={prompt} onReply={onReply} />;
}

export function Composer({ agent, project, question, onSettings }: { agent: Agent; project: Project | undefined; question?: Approval; onSettings: () => void }) {
  const models = useApp(s => s.snapshot?.models[agent.engine]);
  const home = useApp(s => s.snapshot?.home);
  const [text, setText] = useState(() => drafts.get(agent.id) ?? '');
  const [sending, setSending] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const images = useComposerImages(agent.id);
  const [dragging, setDragging] = useState(false);
  const busy = agent.status === 'working' || agent.status === 'waiting';
  const canSend = (Boolean(text.trim()) || images.ready.length > 0) && !images.uploading && !sending;

  useEffect(() => { drafts.set(agent.id, text); }, [agent.id, text]);
  // Idle once it has held neither text nor images for a moment. The Enter that sends a message
  // empties it, so a second Enter right after is still the composer's and answers no approval.
  const blank = !text.trim() && !images.images.length;
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!blank) {
      setIdle(false);
      return;
    }
    const timer = window.setTimeout(() => setIdle(true), APPROVAL_KEY_GUARD_MS);
    return () => window.clearTimeout(timer);
  }, [blank]);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // ---- the `/` and `@` pickers (MonoCode's SkillPicker and FileMentionPicker) ----
  const [slash, setSlash] = useState<Token | null>(null);
  const [mention, setMention] = useState<Token | null>(null);
  const [active, setActive] = useState(0);
  const caretAfter = useRef<number | null>(null);
  const leading = slash ? isLeading(text, slash) : false;
  // Claude Code runs a command only when it starts the message; Codex gets the skill's
  // instructions wherever it is named (server/manager.ts).
  const slashOpen = Boolean(slash) && (leading || agent.engine !== 'claude');
  const mentionOpen = Boolean(mention) && !slashOpen;
  const agentCommands = useAgentCommands(agent.id, slashOpen);
  const agentFiles = useAgentFiles(agent.id, mentionOpen);
  const commands = useMemo(
    () => (slashOpen ? rankCommands([...(leading ? BUILTIN_COMMANDS : []), ...(agentCommands.value ?? [])], slash?.query ?? '') : []),
    [slashOpen, leading, agentCommands.value, slash?.query],
  );
  const folders = useMemo(() => withFolders(agentFiles.value?.files ?? []), [agentFiles.value]);
  // One @ picker: other agents and projects (references the agent is told about), then files.
  const allAgents = useApp(s => s.snapshot?.agents);
  const allProjects = useApp(s => s.snapshot?.projects);
  const hints = useMentionHints();
  const picks = useMemo(() => (mentionOpen
    ? rankMentions({
      agents: (allAgents ?? []).filter(a => a.id !== agent.id),
      projects: allProjects ?? [],
      files: folders,
      query: mention?.query ?? '',
    })
    : []), [mentionOpen, allAgents, allProjects, agent.id, folders, mention?.query]);
  const pickerLength = slashOpen ? commands.length : mentionOpen ? picks.length : 0;

  // A new query starts the highlight from the top.
  useEffect(() => { setActive(0); }, [slash?.query, mention?.query, slashOpen, mentionOpen]);

  const syncTokens = (el: HTMLTextAreaElement) => {
    const cursor = el.selectionStart ?? el.value.length;
    // Only a plain caret, not a selection, is typing a token.
    if (cursor !== el.selectionEnd) {
      setSlash(null);
      setMention(null);
      return;
    }
    const nextSlash = slashTokenAt(el.value, cursor);
    setSlash(nextSlash);
    setMention(nextSlash ? null : mentionTokenAt(el.value, cursor, mentionNames(allAgents, allProjects)));
  };

  // A pick moves the caret past what it wrote, once the new text is in the field.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || caretAfter.current == null) return;
    el.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text]);

  const closePickers = () => {
    setSlash(null);
    setMention(null);
  };

  const runBuiltin = async (command: ComposerCommand) => {
    if (command.name !== 'clear') return;
    setSending(true);
    const ok = await attempt(() => api.newSession(agent.id));
    setSending(false);
    if (ok) {
      setText('');
      drafts.delete(agent.id);
    }
  };

  const pickCommand = (command: ComposerCommand) => {
    if (!slash) return;
    closePickers();
    // Podcode's own commands run as the whole message, the moment you pick one.
    if (command.scope === 'agentscode' && text.trim() === text.slice(slash.start, slash.end) && !images.images.length) {
      void runBuiltin(command);
      return;
    }
    const next = replaceToken(text, slash, '/', command.name);
    caretAfter.current = next.caret;
    setText(next.text);
  };

  const pickMention = (pick: MentionPick) => {
    if (!mention) return;
    closePickers();
    hints.add(pick, mention.start);
    const next = replaceToken(text, mention, '@', pickValue(pick));
    caretAfter.current = next.caret;
    setText(next.text);
  };

  /** Arrow keys move through an open picker, Tab and Enter pick, Escape closes it. True when it took the key. */
  const pickerKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slashOpen && !mentionOpen) return false;
    const move = (step: number) => {
      e.preventDefault();
      if (pickerLength) setActive(index => (index + step + pickerLength) % pickerLength);
      return true;
    };
    const pick = () => {
      if (slashOpen && commands[active]) pickCommand(commands[active]);
      else if (mentionOpen && picks[active]) pickMention(picks[active]);
      else return false;
      e.preventDefault();
      return true;
    };
    if (e.key === 'ArrowDown') return move(1);
    if (e.key === 'ArrowUp') return move(-1);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePickers();
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      pick();
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (pick()) return true;
      closePickers();
    }
    return false;
  };

  const send = async () => {
    const value = text.trim();
    const builtin = images.images.length ? undefined : builtinCommand(value);
    if (builtin) {
      if (!sending) void runBuiltin(builtin);
      return;
    }
    // Images still uploading would be left behind, so Send waits for them.
    if (!canSend) return;
    setSending(true);
    const ok = await attempt(() => api.send(agent.id, value, images.ready, hints.for(value)));
    setSending(false);
    if (ok) {
      setText('');
      drafts.delete(agent.id);
      images.clear();
      hints.clear();
    }
  };

  // Drops: only images attach; anything else gets a note instead of silently vanishing.
  const dragHasFiles = (data: DataTransfer | null) => Array.from(data?.types ?? []).includes('Files');
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(false);
    const files = imageFiles(e.dataTransfer);
    if (files.length) images.add(files);
    else images.setNotice('Only images can be attached: PNG, JPEG, GIF or WebP.');
    field.current?.focus();
  };

  const contextShare = contextPercent(agent.context);
  const where = agent.worktree?.cwd ?? project?.path ?? (agent.projectIds === null ? noProjectFolder(agent.home) : '');
  // An agent on several projects starts here and also works on these, in place.
  const also = (agent.projectIds ?? []).slice(1).flatMap(id => (allProjects ?? []).filter(p => p.id === id).map(p => p.name));
  return (
    <div data-composer className="@container/composer relative mx-auto w-full max-w-3xl shrink-0 p-1.5 pt-0">
      {question ? <div className="px-1.5 pb-1.5"><QuestionPrompt approval={question} /></div> : null}
      <div
        data-composer-box
        className="relative z-10 rounded-[14px] border border-content/10"
        onDragOver={(e) => {
          if (!dragHasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {slashOpen ? (
          <div className="absolute inset-x-0 bottom-full z-30 mb-1">
            <CommandPicker commands={commands} query={slash?.query ?? ''} active={active} loading={agentCommands.loading} onActive={setActive} onPick={pickCommand} />
          </div>
        ) : mentionOpen ? (
          <div className="absolute inset-x-0 bottom-full z-30 mb-1">
            <MentionPicker
              picks={picks}
              query={mention?.query ?? ''}
              active={active}
              loading={agentFiles.loading}
              truncated={agentFiles.value?.truncated}
              onActive={setActive}
              onPick={pickMention}
            />
          </div>
        ) : null}
        {dragging ? (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-[inherit] bg-accent/8 font-sans text-[12px] text-content/70">
            Drop images to attach
          </div>
        ) : null}
        {images.images.length ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {images.images.map(image => (
              <AttachmentChip
                key={image.key}
                name={image.name}
                preview={image.preview}
                uploading={!image.attachment && !image.error}
                error={image.error}
                onRemove={() => { images.remove(image.key); field.current?.focus(); }}
              />
            ))}
          </div>
        ) : null}
        {images.error ? <p role="alert" className="px-3 pt-2 font-sans text-xs text-danger">{images.error}</p> : null}
        <textarea
          ref={field}
          value={text}
          rows={2}
          aria-label={`Message ${agent.name}`}
          // Nothing to send, and not just now: Enter here may answer a waiting approval instead (Transcript's ApprovalRow).
          data-idle={idle ? '' : undefined}
          aria-autocomplete="list"
          aria-expanded={slashOpen || mentionOpen}
          onChange={(e) => {
            setText(e.target.value);
            syncTokens(e.target);
          }}
          onSelect={(e) => syncTokens(e.currentTarget)}
          onBlur={closePickers}
          onPaste={(e) => {
            // Plain text pastes as usual; a screenshot or copied image becomes an attachment.
            const files = pastedImages(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            images.add(files);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (pickerKey(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={busy ? `Queue a message for ${agent.name}…` : `Ask ${agent.name}… @ for files, / for commands`}
          className="scrollbar-none relative min-h-16 max-h-40 w-full resize-none overflow-x-hidden whitespace-pre-wrap wrap-break-word bg-transparent px-3 pb-1.5 pt-3.5 font-sans text-sm leading-5.5 text-content outline-none placeholder:text-content/40"
        />
        <div className="flex items-center gap-1 px-2 pb-2.5">
          <ToolButton label="Attach images (or paste one)" disabled={images.images.length >= MAX_IMAGES} onClick={() => picker.current?.click()}>
            <ImagePlus className="size-3.5" strokeWidth={1.5} />
          </ToolButton>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              images.add(Array.from(e.target.files ?? []));
              // Cleared so choosing the same file again still fires a change.
              e.target.value = '';
              field.current?.focus();
            }}
          />
          <div ref={moreRef} className="relative shrink-0">
            <ToolButton label="Session actions" active={moreOpen} onClick={() => setMoreOpen(v => !v)}>
              <MoreHorizontal className="size-3.5" strokeWidth={1.5} />
            </ToolButton>
            {moreOpen ? (
              <Popover anchor={moreRef} side="top" align="start" width={250} onDismiss={() => setMoreOpen(false)} className="p-1.5">
                <MenuLabel>Session</MenuLabel>
                <MenuRow icon={RotateCcw} title="New session" hint="Clear the conversation context. Or type /clear." disabled={busy} onSelect={() => { setMoreOpen(false); void attempt(() => api.newSession(agent.id)); }} />
                <MenuRow icon={Settings} title="Agent settings" hint="Name, role and instructions." onSelect={() => { setMoreOpen(false); onSettings(); }} />
              </Popover>
            ) : null}
          </div>
          <div className="composer-toolbar flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 items-center gap-1">
              <ModelPicker agent={agent} models={models} onChange={(change) => void patch(agent, change)} onClose={() => field.current?.focus()} />
              {/* The SuperAgent never edits, so its access is fixed at read-only. */}
              {agent.role === 'super' ? null : <AccessPicker value={agent.autonomy} busy={busy} onChange={(autonomy) => void patch(agent, { autonomy })} onClose={() => field.current?.focus()} />}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {/* The quick composer's key hints, while there is something to send and room to say it. */}
            {text.trim() ? (
              <span aria-hidden className="flex items-center gap-2.5 font-sans text-[11px] text-content/35 @max-xl/composer:hidden">
                <span><KeyHint>Enter</KeyHint>{busy ? 'queue' : 'send'}</span>
                <span><KeyHint>Shift Enter</KeyHint>new line</span>
              </span>
            ) : null}
            <ComposerAction busy={busy} hasValue={canSend} onSend={() => void send()} onStop={() => void attempt(() => api.stop(agent.id))} />
          </div>
        </div>
      </div>
      <div data-composer-workspace-bar className="flex min-w-0 items-center gap-2.5 overflow-hidden pl-[15px] pr-[15px] pt-2 font-sans text-[11.5px] text-content/40">
        <span className="flex min-w-0 items-center gap-1.5" title={where}>
          <Folder className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{shortPath(where, home)}{also.length ? <span className="text-content/35"> · also {also.join(', ')}</span> : null}</span>
        </span>
        {agent.worktree ? (
          <span className="flex min-w-0 items-center gap-1.5" title={`From ${agent.worktree.base}`}>
            <GitBranch className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 truncate">{agent.worktree.branch}</span>
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {agent.queued > 0 ? <span className="shrink-0">{agent.queued} queued</span> : null}
          {contextShare !== null ? <span className="shrink-0 tabular-nums">{contextShare}% context</span> : null}
          {/* Only Claude reports its context; a fresh Claude session shows a bare ring. */}
          <ContextMeter usage={agent.context} empty={agent.engine === 'claude' && !agent.sessionId && !agent.context} />
        </span>
      </div>
    </div>
  );
}
