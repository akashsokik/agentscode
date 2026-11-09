/**
 * The SuperAgent's own parts of its pane: the questions it waits on you for, as cards with the
 * choices to click, and its decision log on the right of the pane, where anything it did on its own
 * can be undone.
 */
import { useEffect, useRef, useState } from 'react';
import type { SuperAsk } from '../../shared/types.ts';
import { api } from '../api.ts';
import { memoryDate } from '../memory.ts';
import { openAsks } from '../super.ts';
import { decisionRows, superLogWidth, type DecisionRow } from '../superText.ts';
import { attempt, useApp } from '../store.ts';
import { cx, HeaderButton, PRIMARY, TextButton } from '../ui/common.tsx';
import { ResizeHandle, useColumnWidth } from '../ui/ResizeHandle.tsx';
import { ListBullet, PanelRight } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';

/** Open questions above the composer; empty, it takes no room. */
export function SuperInbox() {
  const asks = useApp(s => s.snapshot?.super.asks);
  const waiting = openAsks(asks);
  if (!waiting.length) return null;
  return (
    <div data-super-inbox className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 pb-2">
      {waiting.map(ask => <AskCard key={ask.id} ask={ask} />)}
    </div>
  );
}

function AskCard({ ask }: { ask: SuperAsk }) {
  const [busy, setBusy] = useState(false);
  const send = async (body: { answer: string } | { dismiss: true }) => {
    setBusy(true);
    await attempt(() => api.answerSuper(ask.id, body));
    setBusy(false);
  };
  return (
    <div data-super-ask={ask.id} className="rounded-lg border border-content/10 bg-content/3 px-3 py-2.5 font-sans">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-content">{ask.question}</p>
        <TextButton disabled={busy} onClick={() => void send({ dismiss: true })} className="shrink-0 text-[12px]">Not now</TextButton>
      </div>
      {ask.detail ? <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-content/55">{ask.detail}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {ask.options.map((option, i) => (
          i === 0
            ? <button key={option} type="button" className={PRIMARY} disabled={busy} onClick={() => void send({ answer: option })}>{option}</button>
            : <SecondaryButton key={option} disabled={busy} onClick={() => void send({ answer: option })}>{option}</SecondaryButton>
        ))}
      </div>
    </div>
  );
}

const time = (ts: number) => `${memoryDate(ts)} ${new Date(ts).toTimeString().slice(0, 5)}`;

/**
 * The SuperAgent's decision log, on the right of its pane: what it did on its own, newest first,
 * each with why and Undo, then what you answered it. Kept live by `super` events. `over` floats it
 * above the conversation in a narrow pane; otherwise it sits beside it, resizable from its left edge.
 */
export function SuperLogSidebar({ over, paneWidth, onClose }: { over: boolean; paneWidth: number; onClose: () => void }) {
  const log = useApp(s => s.snapshot?.super.log);
  const asks = useApp(s => s.snapshot?.super.asks);
  const rows = decisionRows(log);
  const answered = (asks ?? []).filter(a => a.answeredAt !== undefined);
  const column = useColumnWidth('superLog', 300, 240, 0.4);
  // The width you chose, cut to the pane it is in: the window-based cap alone lets it fill a split pane.
  const width = superLogWidth(column.width, column.min, paneWidth, over ? 'over' : 'beside');
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Over the conversation it is a popover: Escape or a click outside it closes it. Escape is heard
  // as it bubbles, after anything inside: a field or control that handles it (an edit box cancelling)
  // keeps it, and Escape typed in any field of the panel is that field's.
  useEffect(() => {
    if (!over) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && root.current?.contains(target) && target.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      close.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The header's toggle does its own closing; closing here too would reopen it on its click.
      if (!target || root.current?.contains(target) || target.closest('[data-super-log-toggle]')) return;
      close.current();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [over]);
  const undoable = rows.filter(r => r.undoable).length;
  return (
    <aside
      aria-label="Decision log"
      data-super-log
      ref={root}
      style={{ width }}
      // One position utility only: with both, .relative (later in the CSS) wins and it never floats.
      className={cx('flex shrink-0 flex-col border-l border-stroke font-sans', over ? 'body-glass absolute inset-y-0 right-0 z-20 shadow-2xl' : 'relative')}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke pl-3.5 pr-1.5">
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium text-content/80">
          Decisions
          {rows.length ? <span className="ml-1.5 font-normal tabular-nums text-content/40">{rows.length}</span> : null}
        </h2>
        <HeaderButton icon={PanelRight} label="Hide the decision log" active onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {rows.length ? (
          <>
            <p className="px-3.5 pb-1 pt-2.5 text-[11px] leading-relaxed text-content/40">
              What it did on its own.{undoable ? ' Undo puts it back, and the SuperAgent hears that you did.' : ''}
            </p>
            <ol>{rows.map(row => <DecisionItem key={row.id} row={row} />)}</ol>
          </>
        ) : (
          <div className="flex flex-col items-center px-6 pb-6 pt-10 text-center">
            <ListBullet className="size-5 text-content/25" strokeWidth={1.5} />
            <p className="mt-2.5 text-[13px] text-content/60">No decisions yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-content/40">When the SuperAgent creates agents or channels, delegates or nudges, it shows here with why, and you can undo it.</p>
          </div>
        )}
        {answered.length ? (
          <section aria-label="Your answers" className="mt-2 border-t border-stroke">
            <h3 className="px-3.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-content/40">Your answers</h3>
            <ol>
              {answered.map(ask => (
                <li key={ask.id} className="px-3.5 py-2">
                  <p className="text-[12px] leading-5 text-content/75">{ask.question}</p>
                  <p className="text-[12px] leading-5 text-content/45">{ask.dismissed ? 'Put aside' : ask.answer}</p>
                  <p className="text-[11px] text-content/30">{time(ask.answeredAt!)}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
      {/* From the width on screen, so a drag never jumps from a wider saved width. */}
      <ResizeHandle column={{ ...column, width }} edge="left" label="Resize the decision log" />
    </aside>
  );
}

function DecisionItem({ row }: { row: DecisionRow }) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    await attempt(() => api.undoSuper(row.id));
    setBusy(false);
  };
  const undone = row.undoneAt !== undefined;
  return (
    <li data-super-action={row.id} className="group/decision border-b border-content/5 px-3.5 py-2.5 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <time dateTime={new Date(row.at).toISOString()} title={new Date(row.at).toLocaleString()} className="min-w-0 flex-1 truncate text-[11px] tabular-nums text-content/35">
          {time(row.at)}{undone ? ' · undone' : ''}
        </time>
        {row.undoable ? (
          <TextButton disabled={busy} onClick={() => void undo()} className="shrink-0 opacity-70 transition-opacity group-hover/decision:opacity-100 focus-visible:opacity-100">
            {busy ? 'Undoing…' : 'Undo'}
          </TextButton>
        ) : null}
      </div>
      <p className={cx('mt-0.5 text-[13px] leading-5', undone ? 'text-content/40 line-through decoration-content/25' : 'text-content/85')}>{row.summary}</p>
      {row.why ? <p className="mt-0.5 text-[12px] leading-relaxed text-content/45">{row.why}</p> : null}
    </li>
  );
}
