// Which app shortcut a key press stands for, apart from what it then does (web/shortcuts.ts runs
// it). Pure, so it is tested directly. Mod is Command on a Mac and Ctrl elsewhere; e.code, not
// e.key, since Option changes the character a key types on macOS.

export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type ShortcutAction =
  | { kind: 'panel' } | { kind: 'closeOthers' } | { kind: 'superQuick' } | { kind: 'browser' }
  | { kind: 'maximize' } | { kind: 'sidebar' } | { kind: 'newAgent' } | { kind: 'palette' }
  | { kind: 'terminal' } | { kind: 'settings' } | { kind: 'closeTab' }
  | { kind: 'cycle'; step: 1 | -1 } | { kind: 'pickTab'; n: number };

/** The app shortcut a Mod chord stands for, or null. Ctrl+Tab and the terminal toggle are handled before. */
export function shortcutFor(e: KeyPress, mac: boolean): ShortcutAction | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  if (e.altKey) {
    if (e.shiftKey) return null;
    if (e.code === 'KeyB') return { kind: 'panel' };
    // Close others (ACH-D27): every unpinned tab but the one in focus.
    if (e.code === 'KeyW') return { kind: 'closeOthers' };
    return null;
  }
  if (e.shiftKey) {
    if (e.code === 'Space') return { kind: 'superQuick' };
    if (e.code === 'KeyB') return { kind: 'browser' };
    if (e.code === 'Enter' || e.code === 'NumpadEnter') return { kind: 'maximize' };
    if (e.code === 'BracketLeft') return { kind: 'cycle', step: -1 };
    if (e.code === 'BracketRight') return { kind: 'cycle', step: 1 };
    return null;
  }
  switch (e.code) {
    case 'KeyB': return { kind: 'sidebar' };
    case 'KeyN': return { kind: 'newAgent' };
    case 'KeyK': return { kind: 'palette' };
    case 'KeyJ': return { kind: 'terminal' };
    case 'Comma': return { kind: 'settings' };
    case 'KeyW': return { kind: 'closeTab' };
  }
  // Cmd+1 to Cmd+8 pick that tab; Cmd+9 is always the last, as in browsers.
  if (/^Digit[1-9]$/.test(e.code)) return { kind: 'pickTab', n: Number(e.code.slice(5)) };
  return null;
}
