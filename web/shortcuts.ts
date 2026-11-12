/**
 * App-wide keyboard shortcuts, after MonoCode's: they work in the desktop app and, where the
 * browser does not keep the key for itself, in a browser tab. Cmd on macOS, Ctrl elsewhere.
 */
import { useEffect } from 'react';
import { openBrowser } from './browser.ts';
import { formatClick, formatKeys, type KeySpec } from './keys.ts';
import { shortcutFor } from './shortcutMap.ts';
import { closeOtherTabs, closeTab, getLayout, open, setRightPanel, setSidebar, toggleMaximize } from './layout.ts';
import { IS_MAC } from './platform.ts';
import { isConfirmingClose, toggleTerminal } from './terminal/actions.ts';
import { isTerminalToggle } from './terminal/keys.ts';
/** A shortcut as this platform shows it (ACH-D26): '⇧⌘⏎' on a Mac, 'Ctrl+Shift+Enter' elsewhere. */
export function keys(spec: KeySpec): string {
  return formatKeys(spec, IS_MAC);
}

/** A modifier-click in a tooltip: '⌘-click' on a Mac, 'Ctrl+click' elsewhere. */
export const MOD_CLICK = formatClick(IS_MAC);

/** Every app shortcut, written once for every platform (web/keys.ts). Kbd chips take these. */
export const SHORTCUT_KEYS = {
  newAgent: 'Mod+N',
  closeTab: 'Mod+W',
  /** Close every unpinned tab but the current one (ACH-D27). */
  closeOthers: 'Alt+Mod+W',
  settings: 'Mod+,',
  palette: 'Mod+K',
  sidebar: 'Mod+B',
  panel: 'Alt+Mod+B',
  terminal: 'Mod+J',
  browser: 'Shift+Mod+B',
  maximize: 'Shift+Mod+Enter',
  /** The SuperAgent's quick bar; the desktop app also takes it system-wide. Never Cmd+J, the terminal's. */
  superQuick: 'Shift+Mod+Space',
} as const satisfies Record<string, KeySpec>;

/** The same shortcuts as text for tooltips and labels: symbols on a Mac ('⇧⌘B'), words elsewhere. */
export const SHORTCUTS = Object.fromEntries(
  Object.entries(SHORTCUT_KEYS).map(([name, spec]) => [name, keys(spec)]),
) as Record<keyof typeof SHORTCUT_KEYS, string>;

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
  superQuick: () => void;
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
  // Ctrl+Tab cycles tabs and Ctrl+` shows or hides the terminal (as Cmd+J does), on every platform.
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
    cycleTab(e.shiftKey ? -1 : 1);
    return true;
  }
  if (isTerminalToggle(e)) {
    toggleTerminal();
    return true;
  }
  const action = shortcutFor({ code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, altGraph: e.getModifierState?.('AltGraph') ?? false }, IS_MAC);
  if (!action) return false;
  const layout = getLayout();
  const pane = layout.panes.find(p => p.id === layout.focused);
  switch (action.kind) {
    case 'panel': setRightPanel(!layout.rightPanel); break;
    case 'closeOthers': if (pane?.tabId) closeOtherTabs(pane.tabId); break;
    case 'superQuick': handlers.superQuick(); break;
    case 'browser': openBrowser(); break;
    case 'maximize': toggleMaximize(layout.focused); break;
    case 'sidebar': setSidebar(!layout.sidebar); break;
    case 'newAgent': handlers.newAgent(); break;
    case 'palette': handlers.palette(); break;
    case 'terminal': toggleTerminal(); break;
    case 'settings': handlers.settings(); break;
    case 'closeTab': if (pane?.tabId) closeTab(pane.tabId); break;
    case 'cycle': cycleTab(action.step); break;
    case 'pickTab': {
      const tab = action.n === 9 ? layout.tabs.at(-1) : layout.tabs[action.n - 1];
      if (tab) open(tab.content);
      break;
    }
  }
  return true;
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
