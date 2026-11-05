import { useSyncExternalStore } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';
const KEY = 'agentscode:theme';

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'system' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

let preference = read();
const listeners = new Set<() => void>();
const media = window.matchMedia('(prefers-color-scheme: light)');

function apply(): void {
  const light = preference === 'light' || (preference === 'system' && media.matches);
  document.documentElement.classList.toggle('theme-light', light);
}

media.addEventListener('change', apply);
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
