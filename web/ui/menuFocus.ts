// Where focus goes in a ContextMenu (web/ui/ContextMenu.tsx). Pure, so it is tested directly.

/**
 * A menu always takes focus when it opens, at its first row, whether it was opened by a
 * right-click (a pointer position) or from the keyboard or a button (an element). Then the arrow
 * keys work at once, and a terminal under it no longer gets them for its shell.
 */
export function focusFirstOnOpen(_anchor: HTMLElement | { x: number; y: number }): boolean {
  return true;
}

/**
 * The row a key moves to among `count` enabled rows, from `current` (-1 when none has focus yet),
 * or null when the key is not the menu's. The arrows wrap; Home and End jump.
 */
export function menuKeyTarget(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp': return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
