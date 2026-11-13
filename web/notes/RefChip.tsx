import { useRef, type ReactNode, type RefObject } from 'react';
import { findRefIds } from '../../shared/refs.ts';
import { showNotesPanel } from '../layout.ts';
import { HoverCard, useHoverCard } from '../ui/HoverCard.tsx';
import { chipClass, DecisionGlyph, KindGlyph, kindWord, NoteGlyph, shortDate, StatusPill, WhoAvatar } from './parts.tsx';
import { getNotes, openNote, useNotes } from './refsState.ts';


/** Whether this window has a Notes tab to open entries in (the Quick window has none). */
let notesHere = true;

/** For a window without the right panel: chips still show their card, but do not open anything. */
export function chipsWithoutNotes(): void {
  notesHere = false;
}

/** Open an entry in the Notes tab. */
export function openInNotes(id: string): void {
  if (!notesHere) return;
  openNote(id);
  showNotesPanel();
}

/**
 * A note or decision id in text, as a chip. Hovering it (or focusing it) shows a flat card under it
 * with the kind, id, status, title, the gist, who and when, and how often it is cited; clicking it,
 * or Enter, opens the entry in the Notes tab. Escape closes the card.
 */
export function RefChip({ id, fade, inert = false, glyph = true }: {
  id: string;
  fade?: boolean;
  /** false inside a section that already names the kind, such as a "Decisions" list (ACH-D37, ACH-D48). */
  glyph?: boolean;
  /** Inside another control (a row that is itself a button): a span that still shows its card on hover and opens on click, without being a second tab stop. */
  inert?: boolean;
}) {
  const summary = useNotes(s => s.byId.get(id));
  const chip = useRef<HTMLElement>(null);
  const card = useHoverCard();
  if (!summary) return <>{id}</>;
  const words = `${kindWord(summary.kind)} ${id}: ${summary.title}`;
  return (
    <>
      {inert ? (
        <span
          ref={chip}
          className={`${chipClass(summary, id)}${notesHere ? ' cursor-pointer' : ''}`}
          onMouseEnter={card.chipEvents.onMouseEnter}
          onMouseLeave={card.chipEvents.onMouseLeave}
          onClick={(event) => { event.stopPropagation(); event.preventDefault(); card.close(); openInNotes(id); }}
        >
          <KindGlyph kind={summary.kind} show={glyph} />
          {id}
        </span>
      ) : (
        <button
          ref={chip as RefObject<HTMLButtonElement>}
          type="button"
          className={chipClass(summary, id)}
          {...(fade ? { 'data-word-fade': '' } : {})}
          aria-label={words}
          aria-expanded={card.open}
          aria-describedby={card.open ? card.cardId : undefined}
          {...card.chipEvents}
          onKeyDown={(event) => { if (event.key === 'Escape' && card.open) { event.stopPropagation(); card.close(); } }}
          onClick={(event) => { event.stopPropagation(); card.close(); openInNotes(id); }}
        >
          <KindGlyph kind={summary.kind} show={glyph} />
          {id}
        </button>
      )}
      {card.open ? <RefCard id={card.cardId} anchor={chip.current} refId={id} onEnter={card.onCardEnter} onLeave={card.onCardLeave} onClose={card.close} /> : null}
    </>
  );
}

function RefCard({ id, anchor, refId, onEnter, onLeave, onClose }: {
  id: string;
  anchor: HTMLElement | null;
  refId: string;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const summary = useNotes(s => s.byId.get(refId));
  if (!summary) return null;
  const mentions = summary.mentions === 1 ? 'mentioned once' : summary.mentions ? `mentioned ${summary.mentions} times` : 'not mentioned yet';
  return (
    <HoverCard id={id} anchor={anchor} onEnter={onEnter} onLeave={onLeave} onClose={onClose} deps={summary}>
      <div className="flex items-center gap-1.5 text-[11px] text-content/55">
        <span className={summary.kind === 'D' ? 'text-[var(--link-color)]' : 'text-warning'}>
          {summary.kind === 'D' ? <DecisionGlyph className="size-3" /> : <NoteGlyph className="size-3" />}
        </span>
        <span>{kindWord(summary.kind)}</span>
        <span className="text-content/35">·</span>
        <span className="font-mono">{summary.id}</span>
        <StatusPill summary={summary} className="ml-auto" />
      </div>
      <h3 className="mt-2 text-[13px] font-semibold leading-5">{summary.title}</h3>
      {summary.gist ? <p className="mt-1 text-[12px] leading-[1.45] text-content/55">{summary.gist}</p> : null}
      {summary.replacedBy ? <p className="mt-1 text-[12px] text-content/55">{summary.kind === 'N' ? 'Outdated by' : 'Replaced by'} <span className="font-mono">{summary.replacedBy}</span></p> : null}
      <div className="mt-2.5 flex min-w-0 items-center gap-1.5 text-[11px] text-content/45">
        <WhoAvatar name={summary.by} className="size-3.5" />
        <span className="truncate">{summary.by}{summary.date ? `, ${shortDate(summary.date)}` : ''}</span>
        <span className="text-content/35">·</span>
        <span className="shrink-0">{mentions}</span>
        {notesHere ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => { onClose(); openInNotes(summary.id); }}
            className="ml-auto shrink-0 text-[var(--link-color)] hover:underline"
          >
            Open in Notes
          </button>
        ) : null}
      </div>
    </HoverCard>
  );
}

/**
 * Plain text with the note and decision ids it cites as chips. Only ids the app knows become chips;
 * code, URLs and paths are left as they are (shared/refs.ts).
 */
export function withRefChips(text: string, keyPrefix = '', inert = false): ReactNode[] {
  const { byId } = getNotes();
  if (!byId.size) return [text];
  const found = findRefIds(text, id => byId.has(id));
  if (!found.length) return [text];
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of found) {
    if (match.start > last) parts.push(text.slice(last, match.start));
    parts.push(<RefChip key={`${keyPrefix}${match.start}`} id={match.id} inert={inert} />);
    last = match.end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** withRefChips as a component, so it renders again when the known ids load. */
export function RefText({ text, inert = false }: { text: string; inert?: boolean }) {
  useNotes(s => s.idsKey);
  return <>{withRefChips(text, '', inert)}</>;
}
