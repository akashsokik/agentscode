import { useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { findRefIds } from '../../shared/refs.ts';
import { open, showNotesPanel } from '../layout.ts';
import { HoverCard, useHoverCard } from '../ui/HoverCard.tsx';
import { GitBranch, GitPullRequest } from '../mono/icons.tsx';
import { DecisionGlyph, KindGlyph, kindWord, NoteGlyph, shortDate, StatusPill, WhoAvatar } from './parts.tsx';
import { getNotes, openNote, useNotes } from './refsState.ts';


/** The one reference surface (ACH-58, ACH-D74/D76). Variants supply content, not styles. */
export function ReferenceChip({ label, kind, glyph, cardContent, onOpen, inert = false, static: displayOnly = false, replaced = false, fade = false }: {
  label: string;
  kind: string;
  glyph?: ReactNode;
  cardContent?: ReactNode;
  onOpen?: () => void;
  inert?: boolean;
  static?: boolean;
  replaced?: boolean;
  fade?: boolean;
}) {
  const anchor = useRef<HTMLElement>(null);
  const card = useHoverCard();
  const activate = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); card.close(); onOpen?.(); };
  const content = <>{glyph ? <span className="ref-chip-glyph" aria-hidden>{glyph}</span> : null}<span className="ref-chip-label">{label}</span></>;
  const className = `ref-chip shrink-0${replaced ? ' ref-old' : ''}`;
  return <>
    {displayOnly ? <span className={className}>{content}</span> : inert ? (
      <span ref={anchor} className={className} data-ref-inert onMouseEnter={cardContent ? card.chipEvents.onMouseEnter : undefined} onMouseLeave={card.chipEvents.onMouseLeave} onClick={onOpen ? activate : undefined}>{content}</span>
    ) : (
      <button ref={anchor as RefObject<HTMLButtonElement>} type="button" className={className} data-ref-kind={kind}
        {...(fade ? { 'data-word-fade': '' } : {})} aria-label={`${kind} ${label}`}
        aria-expanded={cardContent ? card.open : undefined} aria-describedby={card.open ? card.cardId : undefined}
        {...(cardContent ? card.chipEvents : {})}
        onKeyDown={event => { if (event.key === 'Escape' && card.open) { event.stopPropagation(); card.close(); } }}
        onClick={onOpen ? activate : undefined}>{content}</button>
    )}
    {!displayOnly && card.open && cardContent ? <HoverCard id={card.cardId} anchor={anchor.current} onEnter={card.onCardEnter} onLeave={card.onCardLeave} onClose={card.close} deps={cardContent}>
      {cardContent}
      {onOpen ? <button type="button" tabIndex={-1} onClick={activate} className="mt-2.5 text-[11px] text-[var(--link-color)] hover:underline">Open {kind.toLowerCase()}</button> : null}
    </HoverCard> : null}
  </>;
}

/** Explicit, resolved git/PR references only; never a general hash or branch-name parser. */
export function PullRequestChip({ id, number, title, state, inert = false }: { id: string; number: number; title: string; state: string; inert?: boolean }) {
  return <ReferenceChip kind="Pull request" label={`#${number}`} inert={inert} glyph={<GitPullRequest className="text-[var(--link-color)]" />} onOpen={() => open({ kind: 'pullRequests', prId: id })}
    cardContent={<><div className="text-[11px] text-content/55">Pull request · #{number} · {state}</div><h3 className="mt-2 text-[13px] font-semibold">{title}</h3><p className="mt-1 text-[12px] text-content/55">{id}</p></>} />;
}

export function CommitChip({ sha, title, author }: { sha: string; title?: string; author?: string }) {
  return <ReferenceChip kind="Commit" label={sha.slice(0, 7)} glyph={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="text-content/55"><path d="M2 12h6m8 0h6" /><circle cx="12" cy="12" r="4" /></svg>}
    cardContent={<><div className="text-[11px] text-content/55">Commit</div><h3 className="mt-2 break-all font-mono text-[12px]">{sha}</h3>{title ? <p className="mt-1 text-[13px]">{title}</p> : null}{author ? <p className="mt-1 text-[12px] text-content/55">{author}</p> : null}</>} />;
}

export function BranchChip({ name, base }: { name: string; base?: string }) {
  return <ReferenceChip kind="Branch" label={name} glyph={<GitBranch className="text-[var(--link-color)]" />} onOpen={() => open({ kind: 'work' })}
    cardContent={<><div className="text-[11px] text-content/55">Branch</div><h3 className="mt-2 break-all font-mono text-[12px]">{name}</h3>{base ? <p className="mt-1 text-[12px] text-content/55">From {base}</p> : null}</>} />;
}

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
  /** Hide only when an identical glyph already appears beside this chip. */
  glyph?: boolean;
  /** Inside another control (a row that is itself a button): a span that still shows its card on hover and opens on click, without being a second tab stop. */
  inert?: boolean;
}) {
  const summary = useNotes(s => s.byId.get(id));
  if (!summary) return <>{id}</>;
  return <ReferenceChip kind={kindWord(summary.kind)} label={id} inert={inert} fade={fade} replaced={summary.state === 'replaced'}
    glyph={glyph ? <span className={summary.kind === 'N' ? 'text-warning' : 'text-[var(--link-color)]'}><KindGlyph kind={summary.kind} /></span> : undefined}
    onOpen={notesHere ? () => openInNotes(id) : undefined} cardContent={<RefCard refId={id} />} />;
}

function RefCard({ refId }: { refId: string }) {
  const summary = useNotes(s => s.byId.get(refId));
  if (!summary) return null;
  const mentions = summary.mentions === 1 ? 'mentioned once' : summary.mentions ? `mentioned ${summary.mentions} times` : 'not mentioned yet';
  return <>
    <div className="flex items-center gap-1.5 text-[11px] text-content/55">
      <span className={summary.kind === 'D' ? 'text-[var(--link-color)]' : 'text-warning'}>{summary.kind === 'D' ? <DecisionGlyph className="size-3" /> : <NoteGlyph className="size-3" />}</span>
      <span>{kindWord(summary.kind)}</span><span className="text-content/35">·</span><span className="font-mono">{summary.id}</span><StatusPill summary={summary} className="ml-auto" />
    </div>
    <h3 className="mt-2 text-[13px] font-semibold leading-5">{summary.title}</h3>
    {summary.gist ? <p className="mt-1 text-[12px] leading-[1.45] text-content/55">{summary.gist}</p> : null}
    {summary.replacedBy ? <p className="mt-1 text-[12px] text-content/55">{summary.kind === 'N' ? 'Outdated by' : 'Replaced by'} <span className="font-mono">{summary.replacedBy}</span></p> : null}
    <div className="mt-2.5 flex min-w-0 items-center gap-1.5 text-[11px] text-content/45"><WhoAvatar name={summary.by} className="size-3.5" /><span className="truncate">{summary.by}{summary.date ? `, ${shortDate(summary.date)}` : ''}</span><span className="text-content/35">·</span><span className="shrink-0">{mentions}</span></div>
  </>;
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
