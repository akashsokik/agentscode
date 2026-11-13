// Which key presses the issue lists (the Issues page and the right panel's tab) take for their own
// shortcuts. No DOM types, so it is tested on its own (tests/issuesPage.test.ts).

/** What isPageKey needs of the element a key was pressed on. */
interface KeyTarget {
  isContentEditable?: boolean;
  closest(selector: string): unknown;
}

/** The bits of a key event isPageKey reads: a React KeyboardEvent fits. */
interface PageKeyEvent {
  target: unknown;
  currentTarget: { contains(node: never): boolean };
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** A key pressed on the list itself, not typed into a field or a menu: the list's own shortcuts (F, J, K) may take it. */
export function isPageKey(e: PageKeyEvent): boolean {
  const target = e.target as KeyTarget | null;
  if (!target || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return false;
  // React passes key presses up from portals (menus, popovers); only the list's own DOM counts.
  return e.currentTarget.contains(target as never);
}
