/**
 * The composer's pickers, from MonoCode: SkillPicker (src/features/skills/ui/SkillPicker.tsx) for
 * `/` and FileMentionPicker (src/features/sessions/ui/FileMentionPicker.tsx) for `@` (now MentionPicker, for agents and projects too), with
 * MatchText (src/shared/ui/MatchText.tsx). The rows, sizes and pointer handling are MonoCode's;
 * the skill creation form and notes are left out.
 */
import { Fragment, useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Agent, Project } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { shortPath } from '../format.ts';
import { projectLabel } from '../projects.ts';
import { useApp } from '../store.ts';
import { EngineIcon } from '../ui/EngineIcon.tsx';
import type { ComposerCommand } from '../../shared/composer.ts';
import { Bot, File, Folder } from '../mono/icons.tsx';
import { useLockOverscroll } from '../mono/useLockOverscroll.ts';
import { pickGroup, type MentionPick } from './tokens.ts';

/** Fuzzy-matched text with the matched characters accented. */
export function MatchText({ text, positions, active }: { text: string; positions: number[]; active: boolean }): ReactNode {
  if (!active || positions.length === 0) return text;
  const marked = new Set(positions);
  const runs: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = marked.has(i);
    const last = runs[runs.length - 1];
    if (last && last.match === match) last.text += text[i];
    else runs.push({ text: text[i], match });
  }
  return runs.map((run, index) => (run.match ? <span key={index} className="text-accent">{run.text}</span> : <span key={index}>{run.text}</span>));
}

/**
 * Keyboard moves the highlight and scrolls it into view; the pointer moves it only once it really
 * moves, so a list opening under a resting cursor does not steal the highlight.
 */
function usePickerPointer(items: unknown, active: number, onActive: (index: number) => void) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const pointer = useRef({ x: Number.NaN, y: Number.NaN, allow: false });
  const fromPointer = useRef(false);

  useEffect(() => {
    pointer.current.allow = false;
  }, [items]);

  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    pointer.current.allow = false;
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onListMouseMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.clientX === pointer.current.x && e.clientY === pointer.current.y) return;
    pointer.current = { x: e.clientX, y: e.clientY, allow: true };
  };
  const onRowEnter = (index: number) => {
    if (!pointer.current.allow) return;
    fromPointer.current = true;
    onActive(index);
  };
  return { activeRef, onListMouseMove, onRowEnter };
}

function scopeLabel(command: ComposerCommand): string {
  if (command.scope === 'agentscode') return 'agentscode';
  if (command.scope === 'plugin') return command.source;
  if (command.scope === 'user') return 'personal';
  return 'project';
}

/** MonoCode's SkillPicker: `/` commands and skills, each with where it comes from and what it does. */
export function CommandPicker({ commands, query, active, loading, onActive, onPick }: {
  commands: ComposerCommand[];
  query: string;
  active: number;
  loading?: boolean;
  onActive: (index: number) => void;
  onPick: (command: ComposerCommand) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const { activeRef, onListMouseMove, onRowEnter } = usePickerPointer(commands, active, onActive);
  return (
    <div data-skill-picker className="popover-open overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl" data-popover-side="top">
      {commands.length === 0 ? (
        <p className="px-3 py-2.5 text-[12px] text-content/50">
          {loading ? 'Finding commands and skills…' : query.trim() ? 'No matching commands or skills' : 'No commands yet'}
        </p>
      ) : (
        <div
          ref={lockOverscroll}
          role="listbox"
          aria-label="Commands and skills"
          onMouseMove={onListMouseMove}
          className="max-h-[min(240px,40vh)] overflow-y-auto overscroll-none px-1 py-1"
        >
          {commands.map((command, index) => {
            const highlighted = index === active;
            return (
              <button
                key={`${command.scope}:${command.source}:${command.name}`}
                ref={highlighted ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={highlighted}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onRowEnter(index)}
                onClick={() => onPick(command)}
                className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${highlighted ? 'bg-content/10 text-content' : 'text-content'}`}
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="truncate text-[13px]">/{command.name}</span>
                  {command.argumentHint ? <span className="min-w-0 truncate text-[11px] text-content/40">{command.argumentHint}</span> : null}
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-content/40">{scopeLabel(command)}</span>
                </span>
                {command.description ? <span className="line-clamp-2 text-[11px] leading-4 text-content/50">{command.description}</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The @ picker's rows in their groups, with a quiet header where a group starts. */
function groupHeader(picks: MentionPick[], index: number): string | null {
  const group = pickGroup(picks[index]);
  return index === 0 || pickGroup(picks[index - 1]) !== group ? group : null;
}

function agentHint(agent: Agent | undefined, projects: Project[] | undefined): string {
  if (!agent) return '';
  const status = agent.status === 'waiting' ? 'Needs you' : agent.status === 'working' ? (agent.activity || 'Working') : '';
  return [rolePreset(agent.role).name, projectLabel(agent.projectId, projects), status].filter(Boolean).join(', ');
}

/**
 * One @ picker for every composer, after MonoCode's FileMentionPicker: agents (engine mark, name,
 * role and what they are doing), projects (name and path) and files (name, then folder), in groups.
 */
export function MentionPicker({ picks, query, active, loading, truncated, label = 'Mention', onActive, onPick }: {
  picks: MentionPick[];
  query: string;
  active: number;
  loading?: boolean;
  truncated?: boolean;
  label?: string;
  onActive: (index: number) => void;
  onPick: (pick: MentionPick) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const { activeRef, onListMouseMove, onRowEnter } = usePickerPointer(picks, active, onActive);
  const agents = useApp(s => s.snapshot?.agents);
  const projects = useApp(s => s.snapshot?.projects);
  const home = useApp(s => s.snapshot?.home);
  const searching = Boolean(query.trim());
  return (
    <div data-mention-picker className="popover-open overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl" data-popover-side="top">
      {picks.length === 0 ? (
        <p className="px-3 py-2.5 text-[12px] text-content/50">
          {loading ? 'Indexing files…' : searching ? 'No matching agents, projects or files' : 'Nothing to mention yet'}
        </p>
      ) : (
        <div
          ref={lockOverscroll}
          role="listbox"
          aria-label={label}
          onMouseMove={onListMouseMove}
          className="max-h-[min(280px,45vh)] overflow-y-auto overscroll-none px-1 py-1"
        >
          {picks.map((pick, index) => {
            const highlighted = index === active;
            const header = groupHeader(picks, index);
            const row = `flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none ${highlighted ? 'bg-selection text-content' : 'text-content'}`;
            const common = {
              ref: highlighted ? activeRef : undefined,
              type: 'button' as const,
              role: 'option',
              'aria-selected': highlighted,
              onMouseDown: (e: ReactMouseEvent) => e.preventDefault(),
              onMouseEnter: () => onRowEnter(index),
              onClick: () => onPick(pick),
              className: row,
            };
            let body: ReactNode;
            if (pick.kind === 'agent') {
              const agent = agents?.find(a => a.id === pick.agent.id);
              body = (
                <>
                  {agent ? <EngineIcon engine={agent.engine} className="size-3.5" /> : <Bot className="size-3.5 shrink-0 text-content/55" strokeWidth={1.75} />}
                  <span className={`min-w-0 shrink truncate ${highlighted ? 'text-mention' : ''}`}><MatchText text={pick.agent.name} positions={pick.positions} active={searching} /></span>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-content/40">{agentHint(agent, projects)}</span>
                </>
              );
            } else if (pick.kind === 'everyone') {
              body = (
                <>
                  <Bot className="size-3.5 shrink-0 text-content/55" strokeWidth={1.75} />
                  <span className={highlighted ? 'text-mention' : ''}>all</span>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-content/40">Every member</span>
                </>
              );
            } else if (pick.kind === 'project') {
              body = (
                <>
                  <Folder className="size-3.5 shrink-0 text-content/55" strokeWidth={1.75} />
                  <span className={`min-w-0 shrink truncate ${highlighted ? 'text-mention' : ''}`}><MatchText text={pick.project.name} positions={pick.positions} active={searching} /></span>
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-content/40">{shortPath(pick.project.path, home)}</span>
                </>
              );
            } else {
              const file = pick.file;
              const slash = file.relative.lastIndexOf('/');
              const dir = slash === -1 ? '' : file.relative.slice(0, slash);
              const nameOffset = slash + 1;
              const namePositions = file.positions.filter(pos => pos >= nameOffset).map(pos => pos - nameOffset);
              const Icon = file.isDir ? Folder : File;
              body = (
                <>
                  <Icon className="size-3.5 shrink-0 text-content/55" strokeWidth={1.75} />
                  <span className={`min-w-0 flex-1 truncate ${highlighted ? 'text-mention' : ''}`}>
                    <MatchText text={file.name} positions={namePositions} active={searching} />
                    {file.isDir ? '/' : null}
                  </span>
                  {dir ? (
                    <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-content/40">
                      <MatchText text={dir} positions={file.positions.filter(pos => pos < slash)} active={searching} />
                    </span>
                  ) : null}
                </>
              );
            }
            const key = pick.kind === 'agent' ? `a:${pick.agent.id}` : pick.kind === 'project' ? `p:${pick.project.id}` : pick.kind === 'everyone' ? 'all' : `${pick.file.isDir ? 'd' : 'f'}:${pick.file.relative}`;
            return (
              <Fragment key={`${pick.best ? 'best:' : ''}${key}`}>
                {header ? <p role="presentation" className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-content/40 first:pt-0.5">{header}</p> : null}
                <button {...common}>{body}</button>
              </Fragment>
            );
          })}
          {truncated ? <p className="px-2 py-1.5 text-[11px] text-content/40">Large project: only part of it is indexed.</p> : null}
        </div>
      )}
    </div>
  );
}
