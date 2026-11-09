/**
 * MonoCode's activity tile: the small raised tile a work phase ("Ran 3 commands") or a turn's
 * "worked for" line leads with, coloured like an app icon by the kind of work (commands on a dark
 * terminal tile, edits amber, reading and searching blue, subagents violet) or by the provider that
 * did it. Pointing at a tile that folds something pushes its mark out to the right as a chevron
 * slides in from the left; an open fold keeps the chevron, turned down. A running phase shows the
 * dot spinner instead of its mark. The geometry and colours are MonoCode's tab_tile.rs and
 * phase_tile.rs; the motion lives in styles.css (.activity-tile).
 */
import type { CSSProperties, ReactNode } from 'react';
import type { EngineKind } from '../../shared/types.ts';
import type { PhaseKind } from '../activity.ts';
import claudeMark from '../assets/claude.svg';
import codexMark from '../assets/codex-glyph.svg';
import { Bot, ChevronRight, MessageSquare, PenLine, Search, Wrench } from './icons.tsx';

export type TileFace = 'run' | 'edit' | 'research' | 'agent' | 'neutral' | 'bare' | EngineKind;

const MARKS: Partial<Record<string, string>> = { claude: claudeMark, codex: codexMark };

/** A terminal prompt, MonoCode's prompt.svg. */
function PromptGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-3" aria-hidden>
      <path d="M5 7L10 12L5 17" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 17H19" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />
    </svg>
  );
}

/** The provider's mark in the tile's ink, cut from its logo. */
function ProviderGlyph({ engine }: { engine: string }) {
  const url = MARKS[engine];
  if (!url) return <Bot className="size-3" strokeWidth={2} />;
  const mask = `url("${url}") center / contain no-repeat`;
  return <span aria-hidden className="block size-3 bg-current" style={{ mask, WebkitMask: mask } as CSSProperties} />;
}

/** MonoCode's three-row dot spinner, each dot riding a wave across the grid. */
export function DotSpinner() {
  return (
    <span aria-hidden className="tile-spinner">
      {Array.from({ length: 9 }, (_, index) => {
        const row = Math.floor(index / 3);
        const col = index % 3;
        const peak = 0.93 * (1 - (0.65 * Math.abs(col - row)) / 2);
        return <span key={index} data-row={row} style={{ '--k': col + row, '--peak': peak } as CSSProperties} />;
      })}
    </span>
  );
}

export function phaseFace(kind: PhaseKind): TileFace {
  return kind === 'run' || kind === 'edit' || kind === 'research' || kind === 'agent' ? kind : 'neutral';
}

function phaseMark(kind: PhaseKind): ReactNode {
  const props = { className: 'size-3', strokeWidth: 2 };
  if (kind === 'run') return <PromptGlyph />;
  if (kind === 'edit') return <PenLine {...props} />;
  if (kind === 'research') return <Search {...props} />;
  if (kind === 'agent') return <Bot {...props} />;
  if (kind === 'note') return <MessageSquare {...props} />;
  return <Wrench {...props} />;
}

/**
 * One tile. `folds` lets the host's hover bring the chevron in (the host carries `tile-host`);
 * `open` keeps it there, turned down.
 */
function Tile({ face, mark, folds, open, spinning }: { face: TileFace; mark: ReactNode; folds: boolean; open: boolean; spinning: boolean }) {
  return (
    <span aria-hidden className="activity-tile" data-face={spinning ? 'neutral' : face} data-folds={folds || undefined} data-open={(folds && open) || undefined}>
      <span className="activity-tile-mark">{spinning ? <DotSpinner /> : mark}</span>
      {folds ? (
        <span className="activity-tile-chevron">
          <ChevronRight className="size-3.5" strokeWidth={2} />
        </span>
      ) : null}
    </span>
  );
}

/** A work phase's tile: its kind's colour and glyph, or the spinner while it runs. */
export function PhaseTile({ kind, folds = true, open = false, spinning = false }: { kind: PhaseKind; folds?: boolean; open?: boolean; spinning?: boolean }) {
  return <Tile face={phaseFace(kind)} mark={phaseMark(kind)} folds={folds} open={open} spinning={spinning} />;
}

/** A turn's tile: the provider that did the work, on its brand colour. */
export function ProviderTile({ engine, folds, open }: { engine: EngineKind; folds: boolean; open: boolean }) {
  const face: TileFace = MARKS[engine] ? engine : 'neutral';
  return <Tile face={face} mark={<ProviderGlyph engine={engine} />} folds={folds} open={open} spinning={false} />;
}

/** A turn's tile as the agent's own avatar (`mark`), with no tile behind it; folds like the others. */
export function MarkTile({ mark, folds, open }: { mark: ReactNode; folds: boolean; open: boolean }) {
  return <Tile face="bare" mark={mark} folds={folds} open={open} spinning={false} />;
}
