/**
 * The SuperAgent, as the page reaches it: opening (or setting up) its tab, notifications when it
 * asks something, and the desktop app's menu bar and system-wide shortcut.
 */
import { useEffect, useRef } from 'react';
import { inQuietHours, type DesktopSuper, type SuperCommand } from '../shared/superAgent.ts';
import type { Agent } from '../shared/types.ts';
import { api } from './api.ts';
import { open, showPanelForSuperOnce } from './layout.ts';
import { attempt, getState, useApp } from './store.ts';
import { openAsks, superLabel } from './superText.ts';

export { openAsks, superLabel };

/** The desktop app's bridge; absent in a browser tab. */
const desktop = typeof window === 'undefined' ? null : (window as unknown as { agentscodeDesktop?: { super?: DesktopSuper } }).agentscodeDesktop?.super ?? null;

export function useSuperAgent(): Agent | undefined {
  return useApp(s => s.snapshot?.agents.find(a => a.role === 'super'));
}

/**
 * Open the SuperAgent's tab, setting it up first if there is none. The first time, the right panel
 * opens too (its Decisions, Goals and Routines live there); after that it stays as you left it.
 */
export async function openSuper(): Promise<void> {
  const id = getState().snapshot?.super.agentId ?? (await attempt(() => api.createSuper()))?.id;
  if (!id) return;
  open({ kind: 'agent', agentId: id });
  showPanelForSuperOnce();
}

/** Open an agent's tab; the SuperAgent's opens as openSuper does. */
export function openAgent(agentId: string): void {
  if (agentId === getState().snapshot?.super.agentId) void openSuper();
  else open({ kind: 'agent', agentId });
}

/**
 * New questions from the SuperAgent: a desktop notification when you are elsewhere (outside quiet
 * hours, with notifications on), the menu bar kept current, and the menu bar's and the system-wide
 * shortcut's commands handled. Mounted once, in App.
 */
export function useSuperBridge(onQuick: () => void): void {
  const agent = useSuperAgent();
  const asks = useApp(s => s.snapshot?.super.asks);
  const settings = useApp(s => s.snapshot?.settings);
  const known = useRef<Set<string> | null>(null);
  const waiting = openAsks(asks);

  useEffect(() => {
    // Not before the first snapshot: what is there then is not news.
    if (asks === undefined) return;
    const ids = new Set(waiting.map(a => a.id));
    const before = known.current;
    known.current = ids;
    // The first look is what was already there, not news.
    if (!before || !settings?.superNotify || inQuietHours(settings, new Date())) return;
    const fresh = waiting.filter(a => !before.has(a.id));
    if (!fresh.length || typeof Notification === 'undefined') return;
    if (document.hasFocus() && !document.hidden) return;
    const show = () => {
      for (const ask of fresh) {
        const note = new Notification('SuperAgent asks', { body: ask.question, tag: `super-ask-${ask.id}` });
        note.onclick = () => { desktop?.focus(); window.focus(); void openSuper(); note.close(); };
      }
    };
    if (Notification.permission === 'granted') show();
    else if (Notification.permission === 'default') void Notification.requestPermission().then((p: string) => { if (p === 'granted') show(); });
  }, [waiting.map(a => a.id).join(','), settings?.superNotify, settings?.superQuietFrom, settings?.superQuietTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = superLabel(agent, waiting.length);
  useEffect(() => {
    desktop?.status(agent ? { label, asks: waiting.map(a => ({ id: a.id, question: a.question })) } : null);
  }, [agent?.id, label, waiting.map(a => a.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const quick = useRef(onQuick);
  quick.current = onQuick;
  useEffect(() => desktop?.onCommand((command: SuperCommand) => {
    if (command.type === 'quick') quick.current();
    else if (command.type === 'openAgent') openAgent(command.agentId);
    else if (command.type === 'openChannel') open({ kind: 'channel', channelId: command.channelId });
    else void openSuper();
  }), []);
}
