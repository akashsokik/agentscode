/**
 * App-wide keyboard shortcuts, after MonoCode's: they work in the desktop app and, where the
 * browser does not keep the key for itself, in a browser tab. Cmd on macOS, Ctrl elsewhere.
 */
import { useEffect } from 'react';
import { openBrowser } from './browser.ts';
import { closeTab, getLayout, open, setRightPanel, setSidebar, toggleMaximize } from './layout.ts';
import { IS_MAC } from './platform.ts';
import { isConfirmingClose, toggleTerminal } from './terminal/actions.ts';
import { isTerminalToggle } from './terminal/keys.ts';
/** The key a shortcut hint shows: ⌘ on macOS, Ctrl+ elsewhere. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl+';

export const SHORTCUTS = {
  newAgent: `${MOD}N`,
  closeTab: `${MOD}W`,
  settings: `${MOD},`,
  palette: `${MOD}K`,
  sidebar: `${MOD}B`,
  panel: IS_MAC ? '⌥⌘B' : 'Ctrl+Alt+B',
  terminal: `${MOD}J`,
  browser: IS_MAC ? '⇧⌘B' : 'Ctrl+Shift+B',
  maximize: IS_MAC ? '⇧⌘↩' : 'Ctrl+Shift+Enter',
} as const;

function cycleTab(step: number): void {
  const layout = getLayout();
  if (!layout.tabs.length) return;
  const pane = layout.panes.find(p => p.id === layout.focused);
  const index = layout.tabs.findIndex(t => t.id === pane?.tabId);
  const next = layout.tabs[(index + step + layout.tabs.length) % layout.tabs.length];
  open(next.content);
}

interface Handlers {
  newAgent: () => void;
  settings: () => void;
  palette: () => void;
  /** Holds the shortcuts off while a dialog is open. */
  blocked: boolean;
}

let handlers: Handlers | null = null;

/**
 * Runs the app shortcut a key press stands for; true when one ran. The window listener calls
 * it, and so does the terminal, which keeps its key presses from reaching the window.
 */
export function runShortcut(e: KeyboardEvent): boolean {
  if (!handlers || handlers.blocked || isConfirmingClose()) return false;
  const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  // Ctrl+Tab cycles tabs and Ctrl+` shows or hides the terminal (as Cmd+J does), on every platform.
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
    cycleTab(e.shiftKey ? -1 : 1);
    return true;
  }
  if (isTerminalToggle(e)) {
    toggleTerminal();
    return true;
  }
  if (!mod) return false;
  const layout = getLayout();
  let handled = true;
  // e.code, not e.key: Option changes the character a key types on macOS.
  if (e.code === 'KeyB' && e.altKey && !e.shiftKey) setRightPanel(!layout.rightPanel);
  else if (e.altKey) handled = false;
  else if (e.code === 'KeyB' && e.shiftKey) openBrowser();
  else if ((e.code === 'Enter' || e.code === 'NumpadEnter') && e.shiftKey) toggleMaximize(layout.focused);
  else if (e.code === 'KeyB' && !e.shiftKey) setSidebar(!layout.sidebar);
  else if (e.code === 'KeyN' && !e.shiftKey) handlers.newAgent();
  else if (e.code === 'KeyK' && !e.shiftKey) handlers.palette();
  else if (e.code === 'KeyJ' && !e.shiftKey) toggleTerminal();
  else if (e.code === 'Comma' && !e.shiftKey) handlers.settings();
  else if (e.code === 'KeyW' && !e.shiftKey) {
    const pane = layout.panes.find(p => p.id === layout.focused);
    if (pane?.tabId) closeTab(pane.tabId);
  } else if (e.shiftKey && e.code === 'BracketLeft') cycleTab(-1);
  else if (e.shiftKey && e.code === 'BracketRight') cycleTab(1);
  else if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
    // Cmd+1 to Cmd+8 pick that tab; Cmd+9 is always the last, as in browsers.
    const n = Number(e.code.slice(5));
    const tab = n === 9 ? layout.tabs.at(-1) : layout.tabs[n - 1];
    if (tab) open(tab.content);
  } else handled = false;
  return handled;
}

/** Listens for the shortcuts while the app is mounted. `blocked` holds them off while a dialog is open. */
export function useShortcuts(next: Handlers): void {
  handlers = next;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (runShortcut(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
