/**
 * The SuperAgent's quick bar (Shift+Cmd+Space, in the app or, in the desktop app, from anywhere):
 * the command palette's shell with one line to talk to the SuperAgent, the questions it waits on
 * you for, and the latest of the conversation. Enter sends; Cmd+Enter opens the full conversation.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Entry } from '../../shared/types.ts';
import { api } from '../api.ts';
import { focusedAgentId, focusedChannelId, getLayout } from '../layout.ts';
import { IS_MAC } from '../platform.ts';
import { SHORTCUTS } from '../shortcuts.ts';
import { openSuper, superLabel, openAsks, useSuperAgent } from '../super.ts';
import { attempt, getState, loadEntries, useApp } from '../store.ts';
import { SuperInbox } from '../panes/SuperPanel.tsx';
import { Markdown } from './Markdown.tsx';
import { PRIMARY } from './common.tsx';
import { Sparkles } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { TerminalSpinner } from '../mono/TerminalSpinner.tsx';

/** The last few things said, oldest first: your messages and its replies. */
function tail(entries: Entry[] | undefined): Entry[] {
  return (entries ?? []).filter(e => e.kind === 'user' || e.kind === 'agent').slice(-4);
}

/** What you are looking at, so "this" in a quick message means something to the SuperAgent. */
function lookingAt(): string {
  const layout = getLayout();
  const snapshot = getState().snapshot;
  const agent = snapshot?.agents.find(a => a.id === focusedAgentId(layout));
  const channel = snapshot?.channels.find(c => c.id === focusedChannelId(layout));
  if (agent && agent.role !== 'super') return ` (The user is looking at ${agent.name}'s session.)`;
  if (channel) return ` (The user is looking at #${channel.name}.)`;
  return '';
}

export function SuperQuickBar({ onClose }: { onClose: () => void }) {
  const agent = useSuperAgent();
  const entries = useApp(s => (agent ? s.entries[agent.id] : undefined));
  const asks = useApp(s => s.snapshot?.super.asks);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // Read once when the bar opens; the context goes with the message, not into the box.
  const context = useMemo(lookingAt, []);
  const said = tail(entries);
  const waiting = openAsks(asks).length;

  useEffect(() => {
    if (agent) void loadEntries(agent.id);
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const message = text.trim();
    if (!message || !agent) return;
    setBusy(true);
    const ok = await attempt(() => api.send(agent.id, `${message}${context}`));
    setBusy(false);
    if (ok) setText('');
  };
  const openFull = () => { onClose(); void openSuper(); };

  return (
    <Modal title="SuperAgent" size="md" minimalHeader hideClose onClose={onClose}>
      <div className="flex flex-col font-sans">
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-content/7 px-4">
          <Sparkles aria-hidden className="size-4 shrink-0 text-content/45" strokeWidth={1.75} />
          <input
            autoFocus
            aria-label="Message the SuperAgent"
            value={text}
            disabled={!agent}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (IS_MAC ? e.metaKey : e.ctrlKey) openFull();
              else void send();
            }}
            placeholder={agent ? 'Ask the SuperAgent, or tell it what to do next…' : 'Set up the SuperAgent first'}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-content outline-none placeholder:text-content/35"
          />
          {busy || agent?.status === 'working' ? <TerminalSpinner className="shrink-0 text-content/45" /> : null}
          <kbd className="shrink-0 rounded border border-content/10 px-1.5 py-0.5 text-[10px] text-content/40">Esc</kbd>
        </label>
        {!agent ? (
          <div className="flex flex-col items-start gap-3 px-4 py-5">
            <p className="text-[13px] leading-relaxed text-content/60">The SuperAgent runs your team across every project: it watches your agents, decides next steps by your preferences and asks you when it needs to. It never edits code itself.</p>
            <button type="button" className={PRIMARY} onClick={openFull}>Set up the SuperAgent</button>
          </div>
        ) : (
          <div className="max-h-[min(460px,60vh)] overflow-y-auto overscroll-contain pt-3">
            <SuperInbox />
            {said.length ? (
              <div className="flex flex-col gap-3 px-4 pb-3">
                {said.map(entry => entry.kind === 'user' ? (
                  <p key={entry.id} className="self-end rounded-lg bg-content/6 px-3 py-1.5 text-[13px] text-content/80">{entry.text}</p>
                ) : (
                  <Markdown key={entry.id} text={entry.text} className="text-[13px]" />
                ))}
              </div>
            ) : (
              <p className="px-4 pb-4 text-[13px] text-content/45">{waiting ? '' : 'Nothing yet. Tell it what you want done, or ask what everyone is up to.'}</p>
            )}
          </div>
        )}
        <div className="flex h-8 shrink-0 items-center gap-4 border-t border-content/7 px-4 text-[11px] text-content/40">
          <span className="min-w-0 truncate">{superLabel(agent, waiting)}</span>
          <span className="ml-auto shrink-0">↵ send</span>
          <span className="shrink-0">{IS_MAC ? '⌘' : 'Ctrl+'}↵ open conversation</span>
          <span className="shrink-0">{SHORTCUTS.superQuick}</span>
        </div>
      </div>
    </Modal>
  );
}
