/**
 * The composer's pickers, from MonoCode: SkillPicker (src/features/skills/ui/SkillPicker.tsx) for
 * `/` and FileMentionPicker (src/features/sessions/ui/FileMentionPicker.tsx) for `@`, with
 * MatchText (src/shared/ui/MatchText.tsx). The rows, sizes and pointer handling are MonoCode's;
 * the skill creation form and notes are left out.
 */
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { ComposerCommand } from '../../shared/composer.ts';
import { File, Folder } from '../mono/icons.tsx';
import { useLockOverscroll } from '../mono/useLockOverscroll.ts';
import type { RankedFile } from './tokens.ts';

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

/** MonoCode's FileMentionPicker: files and folders, the name first and the folder it sits in after. */
export function FileMentionPicker({ files, query, active, loading, truncated, onActive, onPick }: {
  files: RankedFile[];
  query: string;
  active: number;
  loading?: boolean;
  truncated?: boolean;
  onActive: (index: number) => void;
  onPick: (file: RankedFile) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const { activeRef, onListMouseMove, onRowEnter } = usePickerPointer(files, active, onActive);
  const searching = Boolean(query.trim());
  return (
    <div data-mention-picker className="popover-open overflow-hidden rounded-lg border border-content/10 bg-content/5 backdrop-blur-xl" data-popover-side="top">
      {files.length === 0 ? (
        <p className="px-3 py-2.5 text-[12px] text-content/50">
          {loading ? 'Indexing files…' : searching ? 'No matching files or folders' : 'No files or folders found'}
        </p>
      ) : (
        <div
          ref={lockOverscroll}
          role="listbox"
          aria-label="Files and folders"
          onMouseMove={onListMouseMove}
          className="max-h-[min(240px,40vh)] overflow-y-auto overscroll-none px-1 py-1"
        >
          {files.map((file, index) => {
            const highlighted = index === active;
            const slash = file.relative.lastIndexOf('/');
            const dir = slash === -1 ? '' : file.relative.slice(0, slash);
            const nameOffset = slash + 1;
            const namePositions = file.positions.filter(pos => pos >= nameOffset).map(pos => pos - nameOffset);
            const Icon = file.isDir ? Folder : File;
            return (
              <button
                key={`${file.isDir ? 'd' : 'f'}:${file.relative}`}
                ref={highlighted ? activeRef : undefined}
                type="button"
                role="option"
                aria-selected={highlighted}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onRowEnter(index)}
                onClick={() => onPick(file)}
                className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none ${highlighted ? 'bg-selection text-content' : 'text-content'}`}
              >
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
              </button>
            );
          })}
          {truncated ? <p className="px-2 py-1.5 text-[11px] text-content/40">Large project: only part of it is indexed.</p> : null}
        </div>
      )}
    </div>
  );
}
