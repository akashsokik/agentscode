import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Popover } from '../mono/Popover.tsx';
import { MenuRowRole } from './common.tsx';
import { focusFirstOnOpen, menuKeyTarget } from './menuFocus.ts';

/**
 * The app's right-click menu (ACH-D27), one for every item that has actions: tabs today, and the
 * sidebar's agents, channels and projects. The Popover frame (a hairline, no shadow) holding
 * MenuRow rows with role="menuitem" and MenuDivider groups. It closes on Escape or a click
 * outside; the arrow keys, Home and End move between the rows that are not disabled, and Enter
 * or Space runs one. Disabled rows stay in the menu, greyed.
 */
export function ContextMenu({ anchor, onClose, label, width = 232, children }: {
  anchor: MenuAnchor;
  onClose: () => void;
  /** What the menu is for, for screen readers ("Tab Fen"). */
  label: string;
  width?: number;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  const items = () => [...(surface.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  // The first row takes focus however the menu opened, so the arrows work at once (menuFocus.ts).
  useEffect(() => {
    if (!focusFirstOnOpen(anchor)) return;
    const frame = requestAnimationFrame(() => items()[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const target = menuKeyTarget(list.length, list.indexOf(document.activeElement as HTMLButtonElement), e.key);
    if (target === null) return;
    e.preventDefault();
    // Keys stay in the menu: nothing under it (a terminal's shell) sees them.
    e.stopPropagation();
    list[target].focus();
  };

  return (
    <Popover
      ref={surface}
      anchor={anchor}
      side="bottom"
      align="start"
      width={width}
      constrainHeight={false}
      onDismiss={onClose}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="p-1.5"
    >
      <MenuRowRole.Provider value="menuitem">{children}</MenuRowRole.Provider>
    </Popover>
  );
}

/** A context menu opens at the pointer, or at its trigger when opened from a button or the keyboard. */
export type MenuAnchor = HTMLElement | { x: number; y: number };
export type SetMenu = (update: MenuAnchor | null | ((m: MenuAnchor | null) => MenuAnchor | null)) => void;

/** Right-click handler: replaces the browser menu with ours. */
export function openContextMenu(e: MouseEvent<HTMLElement>, setMenu: SetMenu): void {
  e.preventDefault();
  // React bubbles events out of portals: a right-click inside the open menu is not a new one.
  if (!e.currentTarget.contains(e.target as Node)) return;
  // The context-menu key fires with no pointer position; anchor to the element instead.
  setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : e.currentTarget);
}

/** Click handler for a ... button: toggles a menu anchored to the button. */
export function toggleMenu(e: MouseEvent<HTMLElement>, setMenu: SetMenu): void {
  const el = e.currentTarget;
  setMenu(m => (m ? null : el));
}
