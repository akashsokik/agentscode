/**
 * The SuperAgent's pieces shared by the server, the page and the desktop app: quiet hours, and the
 * desktop bridge (`window.agentscodeDesktop.super`) for the menu bar, the system-wide shortcut and
 * bringing the window forward.
 */
import type { Settings } from './types.ts';

/** The system-wide shortcut for the quick bar, in Electron's accelerator form, and as the page shows it. */
export const SUPER_GLOBAL_ACCELERATOR = 'CommandOrControl+Shift+Space';

/** "HH:MM" as minutes past midnight, or null when it is not a time. */
function minutes(text: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function validQuietTime(text: unknown): boolean {
  return typeof text === 'string' && minutes(text) !== null;
}

/** Whether `now` (local time) falls in quiet hours. From after To spans midnight; equal times mean none. */
export function inQuietHours(settings: Pick<Settings, 'superQuietFrom' | 'superQuietTo'>, now: Date): boolean {
  const from = minutes(settings.superQuietFrom);
  const to = minutes(settings.superQuietTo);
  if (from === null || to === null || from === to) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** What the menu bar shows: the questions waiting and a line on what the SuperAgent is doing. */
export interface SuperTrayState {
  label: string;
  asks: { id: string; question: string }[];
}

export type SuperCommand = { type: 'quick' } | { type: 'open' };

export interface DesktopSuper {
  /** Keep the menu bar up to date; an empty state with no SuperAgent hides it. */
  status(state: SuperTrayState | null): void;
  /** Bring the window forward, as a notification click does. */
  focus(): void;
  /** The system-wide shortcut or the menu bar wants the quick bar, or the SuperAgent's tab. */
  onCommand(callback: (command: SuperCommand) => void): () => void;
}
