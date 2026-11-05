/**
 * The terminal panel under the panes. It follows the project in view, as the sidebar does: its
 * tabs are that project's shells, each tab a tree of splits as in Ghostty. Every terminal stays
 * mounted (placed over its split, or hidden), so splitting, switching tabs or switching projects
 * keeps each screen as it was.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { shortPath } from '../format.ts';
import { currentProjectId, setTerminalHeight, useLayout } from '../layout.ts';
import { IS_MAC } from '../platform.ts';
import { SHORTCUTS } from '../shortcuts.ts';
import { useApp } from '../store.ts';
import { cx, Empty, HeaderButton, PRIMARY } from '../ui/common.tsx';
import { ChevronDown, Maximize2, Minimize2, Plus, SplitColumns, SplitRows, Terminal as TerminalIcon, X } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import {
  answerClose, closeTerminals, frontOf, hideTerminal, newTerminal, pickTab, projectTabs, setSplitRatio, splitFront,
  toggleZoom, useCloseRequest, usePlacing, useTerminalTitles, type CloseRequest,
} from './actions.ts';
import { dividers, leaves, rects, setRatio, type Divider, type Rect, type SplitTree } from './splits.ts';
import { TerminalView } from './TerminalView.tsx';

const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 120;
/** The panel never takes more than this share of the window. */
const MAX_SHARE = 0.75;
/** The smallest a split can be dragged to: about 20 columns, or 3 rows. */
const MIN_SPLIT_WIDTH = 150;
const MIN_SPLIT_HEIGHT = 52;
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const SPLIT_HINT = IS_MAC ? { right: ' (⌘D)', down: ' (⇧⌘D)', zoom: ' (⇧⌘↩)' } : { right: '', down: '', zoom: '' };

const percent = (n: number) => `${(n * 100).toFixed(4)}%`;

function useWindowHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return height;
}

/** The panel's top edge: drag or use the arrow keys to resize; double-click resets. */
function HeightHandle({ height, max, onPreview }: { height: number; max: number; onPreview: (value: number | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(MIN_HEIGHT, value)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startY = e.clientY;
    let latest = height;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    const move = (event: globalThis.PointerEvent) => {
      latest = clamp(height + startY - event.clientY);
      onPreview(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDragging(false);
      onPreview(null);
      setTerminalHeight(latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setTerminalHeight(clamp(height + (e.key === 'ArrowUp' ? step : -step)));
    } else if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault();
      setTerminalHeight(undefined);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Terminal height"
      aria-valuenow={height}
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={max}
      tabIndex={0}
      title="Terminal height. Drag to resize, double-click to reset."
      onPointerDown={onPointerDown}
      onDoubleClick={() => setTerminalHeight(undefined)}
      onKeyDown={onKeyDown}
      className={cx(
        'absolute inset-x-0 -top-[3px] z-20 h-1.5 cursor-row-resize touch-none transition-colors duration-150 hover:bg-content/10 focus-visible:bg-content/10',
        dragging && 'bg-content/15',
      )}
    />
  );
}

/** The line between two splits: drag it to share the space differently, double-click to halve it. */
function SplitDivider({ divider, body, onPreview, onCommit }: {
  divider: Divider;
  body: RefObject<HTMLDivElement | null>;
  onPreview: (ratio: number | null) => void;
  onCommit: (ratio: number) => void;
}) {
  const { dir, area, ratio } = divider;
  const row = dir === 'row';
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const box = body.current?.getBoundingClientRect();
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const start = row ? box.left + area.x * box.width : box.top + area.y * box.height;
    const size = row ? area.w * box.width : area.h * box.height;
    // Clamped in pixels, so a short panel cannot squeeze a split to a single row.
    const min = Math.min(0.5, (row ? MIN_SPLIT_WIDTH : MIN_SPLIT_HEIGHT) / Math.max(1, size));
    const clamp = (value: number) => Math.min(1 - min, Math.max(min, value));
    let latest = ratio;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = row ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const move = (event: globalThis.PointerEvent) => {
      latest = clamp(((row ? event.clientX : event.clientY) - start) / size);
      onPreview(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDragging(false);
      onPreview(null);
      onCommit(latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const style = row
    ? { left: percent(area.x + area.w * ratio), top: percent(area.y), height: percent(area.h) }
    : { top: percent(area.y + area.h * ratio), left: percent(area.x), width: percent(area.w) };
  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Split size"
      title="Drag to resize the splits, double-click to make them equal."
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(0.5)}
      style={style}
      className={cx('group absolute z-10 touch-none', row ? 'w-2 -translate-x-1/2 cursor-col-resize' : 'h-2 -translate-y-1/2 cursor-row-resize')}
    >
      <span
        aria-hidden
        className={cx(
          'absolute transition-colors duration-150',
          row ? 'inset-y-0 left-1/2 w-px -translate-x-1/2' : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
          dragging ? 'bg-content/35' : 'bg-content/12 group-hover:bg-content/30',
        )}
      />
    </div>
  );
}

function TerminalTab({ label, count, active, onPick, onClose }: { label: string; count: number; active: boolean; onPick: () => void; onClose: () => void }) {
  return (
    <div className="group relative flex h-full max-w-52 shrink-0 items-center">
      <button
        type="button"
        title={count > 1 ? `${label} · ${count} splits` : label}
        aria-current={active ? 'page' : undefined}
        onClick={onPick}
        onAuxClick={e => { if (e.button === 1) onClose(); }}
        className={cx(
          'flex h-6.5 min-w-0 items-center gap-1.5 rounded-md pl-2 pr-6 text-[12px] transition-colors duration-150',
          active ? 'bg-selection text-content' : 'text-content/50 hover:bg-content/5 hover:text-content',
        )}
      >
        <TerminalIcon className={cx('size-3.5 shrink-0', !active && 'opacity-60')} strokeWidth={1.75} />
        <span className="min-w-0 truncate">{label}</span>
        {count > 1 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums text-content/45">
            <SplitColumns className="size-3" strokeWidth={1.75} />
            {count}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={count > 1 ? `Close this tab and its ${count} splits` : 'Close terminal (ends its shell)'}
        onClick={onClose}
        className="absolute right-1 grid size-4.5 place-items-center rounded text-content/50 opacity-0 transition-opacity duration-150 hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="size-3" strokeWidth={1.8} />
      </button>
    </div>
  );
}

/** Asks before closing terminals that still run a program, as Ghostty does. */
function CloseDialog({ request }: { request: CloseRequest }) {
  const many = request.ids.length > 1;
  const programs = request.programs.join(', ');
  const one = request.programs.length === 1;
  const unknown = !request.programs.length;
  return (
    <Modal
      title={many ? `Close ${request.ids.length} terminals?` : 'Close terminal?'}
      size="sm"
      onClose={() => answerClose(false)}
      footer={
        <>
          <SecondaryButton onClick={() => answerClose(false)}>Cancel</SecondaryButton>
          <SecondaryButton danger autoFocus onClick={() => answerClose(true)}>{many ? 'Close all' : 'Close'}</SecondaryButton>
        </>
      }
    >
      <p className="px-4 pb-4 pt-2 font-sans text-[12px] leading-relaxed text-content/60">
        {unknown
          ? `AgentsCode could not check whether a program is still running in ${many ? 'them' : 'it'}. Closing stops anything that is.`
          : `${programs} ${one ? 'is' : 'are'} still running. Closing stops ${one ? 'it' : 'them'}.`}
      </p>
    </Modal>
  );
}

export function TerminalPanel() {
  const layout = useLayout();
  const projects = useApp(s => s.snapshot?.projects);
  const home = useApp(s => s.snapshot?.home ?? '');
  const terminals = useApp(s => s.terminals);
  const titles = useTerminalTitles();
  const placing = usePlacing();
  const closeRequest = useCloseRequest();
  const projectId = currentProjectId(layout, projects?.map(p => p.id) ?? []);
  const project = projects?.find(p => p.id === projectId);
  const mine = useMemo(() => terminals.filter(t => t.projectId === projectId), [terminals, projectId]);
  const tabs = useMemo(() => (projectId ? projectTabs(projectId, terminals, layout, placing) : []), [projectId, terminals, layout, placing]);
  const { id: frontId, tab: frontTab } = frontOf(projectId, tabs, layout);
  const open = Boolean(layout.terminal);
  const body = useRef<HTMLDivElement>(null);

  // The tab in front and where each split sits. A divider mid-drag moves on its own; the splits
  // follow when it is let go, so the shells are not resized (and redrawn) on every pointer move.
  const [drag, setDrag] = useState<{ path: string; ratio: number } | null>(null);
  const tree: SplitTree | undefined = tabs[frontTab];
  const shown = tree && drag ? setRatio(tree, drag.path, drag.ratio) : tree;
  const zoomId = projectId ? layout.terminalZoom?.[projectId] : undefined;
  const zoomed = shown && zoomId && leaves(shown).includes(zoomId) ? zoomId : undefined;
  const placed = !tree ? new Map<string, Rect>() : zoomed ? new Map([[zoomed, FULL]]) : rects(tree);
  const lines = shown && !zoomed ? dividers(shown) : [];
  const splits = shown ? leaves(shown).length : 0;
  const front = mine.find(t => t.id === frontId);

  const windowHeight = useWindowHeight();
  const max = Math.max(MIN_HEIGHT, Math.floor(windowHeight * MAX_SHARE));
  const [preview, setPreview] = useState<number | null>(null);
  const height = Math.min(max, Math.max(MIN_HEIGHT, preview ?? layout.terminalHeight ?? DEFAULT_HEIGHT));

  // When the project's last shell ends (`exit`, or its last tab closed), the panel goes too.
  const previous = useRef({ projectId, count: mine.length });
  useEffect(() => {
    const before = previous.current;
    previous.current = { projectId, count: mine.length };
    if (open && before.projectId === projectId && before.count > 0 && mine.length === 0) hideTerminal();
  }, [projectId, mine.length, open]);

  if (!open && !terminals.length) return null;

  const label = (tab: SplitTree, index: number) => {
    const ids = leaves(tab);
    const id = index === frontTab && frontId && ids.includes(frontId) ? frontId : ids[0];
    const title = titles[id]?.trim();
    if (title) return title;
    const shell = mine.find(t => t.id === id)?.shell ?? 'shell';
    return tabs.length > 1 ? `${shell} ${index + 1}` : shell;
  };

  return (
    <section
      data-terminal-panel
      aria-label="Terminal"
      className={cx('relative flex shrink-0 flex-col border-t border-stroke bg-background-base', !open && 'hidden')}
      style={{ height }}
    >
      <HeightHandle height={height} max={max} onPreview={setPreview} />
      <header className="flex h-8.5 shrink-0 items-center gap-2 pl-1.5 pr-1 font-sans">
        <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-none [scrollbar-width:none]">
          {tabs.map((tab, index) => (
            <TerminalTab
              key={leaves(tab)[0]}
              label={label(tab, index)}
              count={leaves(tab).length}
              active={index === frontTab}
              onPick={() => projectId && pickTab(projectId, tab)}
              onClose={() => void closeTerminals(leaves(tab))}
            />
          ))}
          <button
            type="button"
            title={project ? `New terminal in ${project.name}${IS_MAC ? ' (⌘T in a terminal)' : ''}` : 'New terminal'}
            aria-label="New terminal"
            disabled={!project}
            onClick={() => void newTerminal(projectId)}
            className="ml-0.5 grid size-6.5 shrink-0 place-items-center rounded-md text-content/50 transition-colors duration-150 hover:bg-content/7 hover:text-content disabled:opacity-40"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        {project ? (
          <span className="min-w-0 max-w-[30%] shrink truncate font-mono text-[11px] text-content/35" title={project.path}>
            {shortPath(project.path, home)}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center">
          <HeaderButton icon={SplitColumns} label="Split right" title={`Split right${SPLIT_HINT.right}`} disabled={!project} onClick={() => splitFront('right')} />
          <HeaderButton icon={SplitRows} label="Split down" title={`Split down${SPLIT_HINT.down}`} disabled={!project} onClick={() => splitFront('down')} />
          {splits > 1 && front ? (
            <HeaderButton
              icon={zoomed ? Minimize2 : Maximize2}
              label={zoomed ? 'Show all splits' : 'Zoom this split'}
              title={`${zoomed ? 'Show all splits' : 'Zoom the split in focus'}${SPLIT_HINT.zoom}`}
              active={Boolean(zoomed)}
              onClick={() => toggleZoom(front)}
            />
          ) : null}
          <HeaderButton icon={ChevronDown} label="Hide terminal" title={`Hide terminal (${SHORTCUTS.terminal})`} onClick={hideTerminal} />
        </div>
      </header>
      <div ref={body} className="relative min-h-0 flex-1 overflow-hidden">
        {terminals.map(info => {
          const rect = open ? placed.get(info.id) ?? null : null;
          return (
            <TerminalView
              key={info.id}
              info={info}
              rect={rect}
              dimmed={Boolean(rect) && splits > 1 && !zoomed && info.id !== frontId}
              split={splits > 1}
              zoomed={zoomed === info.id}
            />
          );
        })}
        {open ? lines.map(divider => (
          <SplitDivider
            key={divider.path}
            divider={divider}
            body={body}
            onPreview={ratio => setDrag(ratio === null ? null : { path: divider.path, ratio })}
            onCommit={ratio => projectId && setSplitRatio(projectId, frontTab, divider.path, ratio)}
          />
        )) : null}
        {open && !mine.length ? (
          <Empty
            icon={TerminalIcon}
            title={project ? `No terminal in ${project.name}` : 'No project yet'}
            action={project ? (
              <button type="button" className={PRIMARY} onClick={() => void newTerminal(project.id)}>
                <Plus className="size-3.5" strokeWidth={2} /> New terminal
              </button>
            ) : undefined}
          >
            {project ? `A new shell starts in ${shortPath(project.path, home)}.` : 'Add a project, and its terminals open in its folder.'}
          </Empty>
        ) : null}
      </div>
      {closeRequest ? <CloseDialog request={closeRequest} /> : null}
    </section>
  );
}
