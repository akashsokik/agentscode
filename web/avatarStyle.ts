import { useSyncExternalStore } from 'react';
import { parseAvatarStyle, type AvatarStyle } from './avatarStylePreference.ts';

// The Avatars setting (ACH-46), kept like the theme (web/theme.ts): in this browser's storage,
// shared by every window of the app and followed live when another window changes it.

export type { AvatarStyle };
const KEY = 'podcode:avatars';

function read(): AvatarStyle {
  try {
    return parseAvatarStyle(localStorage.getItem(KEY));
  } catch {
    return 'colour';
  }
}

let style = read();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

function refresh(): void {
  const next = read();
  if (next === style) return;
  style = next;
  notify();
}

window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) refresh();
});
window.addEventListener('focus', refresh);

export function setAvatarStyle(next: AvatarStyle): void {
  style = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not remembered in private mode
  }
  notify();
}

export function useAvatarStyle(): AvatarStyle {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => style);
}
