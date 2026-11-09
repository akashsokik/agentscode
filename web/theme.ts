import { useSyncExternalStore } from 'react';
import { isLight, parsePreference, type ThemePreference } from './themePreference.ts';

export type { ThemePreference };
const KEY = 'agentscode:theme';

function read(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(KEY));
  } catch {
    return 'dark';
  }
}

let preference = read();
const listeners = new Set<() => void>();
const media = window.matchMedia('(prefers-color-scheme: light)');

function apply(): void {
  document.documentElement.classList.toggle('theme-light', isLight(preference, media.matches));
}

/** Take the stored preference again, as another window may have changed it. */
function refresh(): void {
  const next = read();
  if (next === preference) return;
  preference = next;
  apply();
  for (const listener of listeners) listener();
}

media.addEventListener('change', apply);
// Every window of the app (the main window, the SuperAgent's quick window) shares one stored
// preference. A change made in one reaches the others live: the storage event fires in every other
// window of the same origin, and a window coming to the front reads it again in case it missed one.
window.addEventListener('storage', event => {
  if (event.key === KEY || event.key === null) refresh();
});
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
apply();

export function setTheme(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // not remembered in private mode
  }
  apply();
  for (const listener of listeners) listener();
}

export function useTheme(): ThemePreference {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => preference);
}
