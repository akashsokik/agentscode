// The app's theme setting, as a value: no DOM, so it is tested directly (web/theme.ts applies it).

export type ThemePreference = 'dark' | 'light' | 'system';

/** The stored preference, as the setting saves it: anything unknown is dark. Pure, tested. */
export function parsePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'system' ? value : 'dark';
}

/** Whether the light theme shows: chosen outright, or following a light system appearance. Pure, tested. */
export function isLight(preference: ThemePreference, systemLight: boolean): boolean {
  return preference === 'light' || (preference === 'system' && systemLight);
}
