/**
 * What a key press in the terminal should do before ghostty-web sees it. Left alone, ghostty-web
 * encodes every modifier combination for the shell and stops it there, so Cmd shortcuts would
 * never reach the app or the desktop app's menu (Cmd+Q, Cmd+R, zoom). On macOS this follows
 * Ghostty's own defaults: Cmd belongs to the app, Option types the character it makes (# on a
 * British keyboard), and the familiar line-editing chords send what Ghostty sends.
 */

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type KeyAction =
  /** ghostty-web handles it: ordinary typing, Ctrl chords, Cmd+C and Cmd+V. */
  | { kind: 'terminal' }
  /** An app shortcut or a menu command: kept from the shell, offered to the app. */
  | { kind: 'app' }
  /** Bytes for the shell instead of what ghostty-web would encode. */
  | { kind: 'send'; data: string }
  | { kind: 'selectAll' }
  /** Cmd+T, as in Ghostty: another shell in the same project. */
  | { kind: 'newTerminal' }
  /** Ghostty's split keys: Cmd+D right, Cmd+Shift+D down, Cmd+W closes the one in focus. */
  | { kind: 'split'; dir: 'right' | 'down' }
  | { kind: 'closeSplit' }
  /** Cmd+[ and Cmd+] in order, Cmd+Option+arrows by direction. */
  | { kind: 'focusSplit'; to: 'previous' | 'next' | 'left' | 'right' | 'up' | 'down' }
  /** Cmd+Shift+Enter: one split fills the tab, and back. */
  | { kind: 'zoomSplit' }
  /** Cmd+Ctrl+=: every split the same size. */
  | { kind: 'equalizeSplits' };

const ARROWS: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const TERMINAL: KeyAction = { kind: 'terminal' };
const APP: KeyAction = { kind: 'app' };
const send = (data: string): KeyAction => ({ kind: 'send', data });

/** Ctrl+` shows and hides the terminal panel, as in VS Code. */
export function isTerminalToggle(e: KeyPress): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === 'Backquote' || e.key === '`');
}

export function classifyKey(e: KeyPress, mac: boolean): KeyAction {
  // Tab cycling and the panel toggle work from inside the terminal too.
  if (isTerminalToggle(e)) return APP;
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') return APP;
  // Elsewhere Ctrl is the shell's (Ctrl+C, Ctrl+W, Ctrl+R), so only macOS has more to sort out.
  if (!mac) return TERMINAL;

  if (e.metaKey) {
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const to = ARROWS[e.key];
      if (to) return { kind: 'focusSplit', to };
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'Equal') return { kind: 'equalizeSplits' };
    if (e.ctrlKey || e.altKey) return APP;
    if (e.code === 'KeyD') return { kind: 'split', dir: e.shiftKey ? 'down' : 'right' };
    if (e.shiftKey && e.key === 'Enter') return { kind: 'zoomSplit' };
    // With Shift these cycle the app's tabs; without, the splits.
    if (!e.shiftKey && e.code === 'BracketLeft') return { kind: 'focusSplit', to: 'previous' };
    if (!e.shiftKey && e.code === 'BracketRight') return { kind: 'focusSplit', to: 'next' };
    if (!e.shiftKey && e.code === 'KeyW') return { kind: 'closeSplit' };
    if (!e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyV')) return TERMINAL;
    if (!e.shiftKey && e.code === 'KeyA') return { kind: 'selectAll' };
    if (!e.shiftKey && e.code === 'KeyT') return { kind: 'newTerminal' };
    if (e.key === 'ArrowLeft') return send('\x01'); // start of line
    if (e.key === 'ArrowRight') return send('\x05'); // end of line
    if (e.key === 'Backspace') return send('\x15'); // delete to the start of the line
    return APP;
  }

  if (e.altKey && !e.ctrlKey) {
    if (e.key === 'ArrowLeft') return send('\x1bb'); // word back
    if (e.key === 'ArrowRight') return send('\x1bf'); // word forward
    if (e.key === 'Backspace') return send('\x1b\x7f'); // delete the word before
    // Option makes a character on macOS. A dead key ("Dead") composes, which ghostty-web handles.
    if (e.key.length === 1 || (e.key.length === 2 && e.key.codePointAt(0)! > 0xffff)) return send(e.key);
  }
  return TERMINAL;
}
