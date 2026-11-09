/**
 * The SuperAgent's own parts of its pane: the questions it waits on you for, as cards with the
 * choices to click, and its decision log, where anything it did on its own can be undone.
 */
import { useState } from 'react';
import type { SuperAction, SuperAsk } from '../../shared/types.ts';
import { api } from '../api.ts';
import { memoryDate } from '../memory.ts';
import { openAsks } from '../super.ts';
import { attempt, useApp } from '../store.ts';
import { PRIMARY, TextButton } from '../ui/common.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group } from '../mono/settings.tsx';

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

/** Everything the SuperAgent did on its own, newest first, and what it asked you. */
export function SuperLogDialog({ onClose }: { onClose: () => void }) {
  const log = useApp(s => s.snapshot?.super.log) ?? [];
  const asks = useApp(s => s.snapshot?.super.asks) ?? [];
  const answered = asks.filter(a => a.answeredAt !== undefined);
  return (
    <Modal title="What the SuperAgent did" size="md" fitViewport onClose={onClose}>
      <div className="px-4 pb-4 pt-4">
        <Group title="Decisions" description="What it did on its own, and why. Undo puts it back, and the SuperAgent hears that you undid it.">
          {log.length ? log.map(action => <ActionRow key={action.id} action={action} />) : (
            <p className="px-4 py-3.5 text-[12px] text-content/45">Nothing yet. Its decisions show here as it makes them.</p>
          )}
        </Group>
        {answered.length ? (
          <Group title="Your answers">
            {answered.map(ask => (
              <div key={ask.id} className="border-b border-content/5 px-4 py-3 last:border-b-0">
                <p className="text-[13px] leading-5 text-content">{ask.question}</p>
                <p className="mt-0.5 text-[12px] text-content/55">{ask.dismissed ? 'Put aside' : `You answered: ${ask.answer}`}</p>
                <p className="mt-0.5 text-[11px] text-content/35">{time(ask.answeredAt!)}</p>
              </div>
            ))}
          </Group>
        ) : null}
      </div>
    </Modal>
  );
}

function ActionRow({ action }: { action: SuperAction }) {
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    await attempt(() => api.undoSuper(action.id));
    setBusy(false);
  };
  return (
    <div data-super-action={action.id} className="flex items-start gap-3 border-b border-content/5 px-4 py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] leading-5 ${action.undoneAt ? 'text-content/45 line-through decoration-content/25' : 'text-content'}`}>{action.summary}</p>
        {action.why ? <p className="mt-0.5 text-[12px] leading-relaxed text-content/45">Why: {action.why}</p> : null}
        <p className="mt-0.5 text-[11px] text-content/35">{time(action.at)}{action.undoneAt ? ` · undone ${time(action.undoneAt)}` : ''}</p>
      </div>
      {action.undo && !action.undoneAt ? <SecondaryButton disabled={busy} onClick={() => void undo()}>Undo</SecondaryButton> : null}
    </div>
  );
}
