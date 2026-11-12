// How a keyboard shortcut is shown (ACH-D26): key symbols on macOS, in Apple's modifier order
// Control, Option, Shift, Command (Human Interface Guidelines, Keyboards), with ⏎ for Return as on
// Apple's own shortcut pages; short words elsewhere (Ctrl+Shift+Enter). Pure, so it is tested
// directly; web/ui/Kbd.tsx draws the result and tooltips use it as plain text.

/** A shortcut written once for every platform, such as 'Mod+Shift+Enter' or 'Alt+Mod+W'. */
export type KeySpec = string;

type Modifier = 'Ctrl' | 'Alt' | 'Shift' | 'Mod';
const MODIFIERS: readonly Modifier[] = ['Ctrl', 'Alt', 'Shift', 'Mod'];

/** Apple's order: Control, Option, Shift, Command. Mod is Command on a Mac. */
const MAC_ORDER: Record<Modifier, number> = { Ctrl: 0, Alt: 1, Shift: 2, Mod: 3 };
/** Windows and Linux read Ctrl+Alt+Shift; Mod is Ctrl there and is listed first. */
const OTHER_ORDER: Record<Modifier, number> = { Mod: 0, Ctrl: 0, Alt: 1, Shift: 2 };

const MAC_MODIFIER: Record<Modifier, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const OTHER_MODIFIER: Record<Modifier, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Mod: 'Ctrl' };

const MAC_KEY: Record<string, string> = {
  Enter: '⏎', Return: '⏎', Escape: '⎋', Esc: '⎋', Backspace: '⌫', Delete: '⌫', Tab: '⇥', Space: 'Space',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
};
const OTHER_KEY: Record<string, string> = {
  Return: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Space: 'Space',
  Up: '↑', Down: '↓', Left: '←', Right: '→',
};

function parse(spec: KeySpec): { modifiers: Modifier[]; key: string } {
  const parts = spec.split('+').map(p => p.trim()).filter(Boolean);
  // A literal plus ('Mod++') leaves an empty last part; keep it as the key.
  const key = spec.endsWith('++') ? '+' : parts.pop() ?? '';
  const modifiers = parts.filter((p): p is Modifier => (MODIFIERS as readonly string[]).includes(p));
  return { modifiers: [...new Set(modifiers)], key };
}

/** The shortcut as it should read: '⇧⌘⏎' on a Mac, 'Ctrl+Shift+Enter' elsewhere. */
export function formatKeys(spec: KeySpec, mac: boolean): string {
  const { modifiers, key } = parse(spec);
  const order = mac ? MAC_ORDER : OTHER_ORDER;
  const sorted = [...modifiers].sort((a, b) => order[a] - order[b]);
  const shown = key.length === 1 ? key.toUpperCase() : (mac ? MAC_KEY : OTHER_KEY)[key] ?? key;
  if (mac) return sorted.map(m => MAC_MODIFIER[m]).join('') + shown;
  // Mod and Ctrl are the same key elsewhere: say it once.
  const words = [...new Set(sorted.map(m => OTHER_MODIFIER[m]))];
  return [...words, shown].join('+');
}

/** A modifier-click as words for a tooltip: '⌘-click' on a Mac, 'Ctrl+click' elsewhere. */
export function formatClick(mac: boolean): string {
  return mac ? '⌘-click' : 'Ctrl+click';
}
