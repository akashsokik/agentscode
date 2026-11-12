// Keys for the full-window viewers (web/ui/ZoomViewer.tsx: diagrams and images). Pure, so they are
// tested directly. Zoom keys as in Preview, Quick Look and browsers: Cmd+Plus, Cmd+Minus, Cmd+0 to
// fit (Ctrl elsewhere), with the bare +, - and 0 kept from the diagram viewer; Escape closes.

export type ViewerAction = 'zoomIn' | 'zoomOut' | 'fit' | 'close';

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** The viewer action for a key press, or null when it is not the viewer's. */
export function viewerAction(event: KeyLike, mac: boolean): ViewerAction | null {
  if (event.altKey) return null;
  const mod = mac ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
  const other = mac ? Boolean(event.ctrlKey) : Boolean(event.metaKey);
  if (other) return null;
  if (event.key === 'Escape') return mod ? null : 'close';
  if (event.key === '+' || event.key === '=') return 'zoomIn';
  if (event.key === '-' || event.key === '_') return 'zoomOut';
  if (event.key === '0') return 'fit';
  return null;
}

/**
 * Whether the desktop app's View menu would take this key as its own Zoom In, Zoom Out or Actual
 * Size (Cmd/Ctrl with =, +, - or 0). While a viewer is open the menu lets these through to it, so
 * Cmd+Plus zooms the image rather than the whole app (electron/main.ts).
 */
export function isMenuZoomKey(input: { key: string; meta?: boolean; control?: boolean; alt?: boolean }, mac: boolean): boolean {
  const mod = mac ? Boolean(input.meta) : Boolean(input.control);
  return mod && !input.alt && ['=', '+', '-', '_', '0'].includes(input.key);
}

/**
 * Which pages have a viewer open, so the View menu lets their Cmd+Plus, Cmd+Minus and Cmd+0
 * through (electron/main.ts). A page's capture ends when its viewer closes and, whatever React did
 * or did not get to run, when the page itself goes: a reload, a navigation, a crashed renderer or
 * a closed window. Otherwise the app's own zoom keys would stay off with no viewer to take them.
 */
export class ZoomKeyCapture {
  private pages = new Set<number>();

  /** A page's viewer opened (true) or closed (false). */
  set(page: number, on: boolean): void {
    if (on) this.pages.add(page);
    else this.pages.delete(page);
  }

  /** The page was reloaded, navigated, crashed or closed: its viewer is gone with it. */
  pageGone(page: number): void {
    this.pages.delete(page);
  }

  /** Whether the menu should let this key through to the page. */
  menuSkips(page: number, input: { key: string; meta?: boolean; control?: boolean; alt?: boolean }, mac: boolean): boolean {
    return this.pages.has(page) && isMenuZoomKey(input, mac);
  }
}

/**
 * Tab and Shift+Tab inside an open viewer go round its own controls, never to the page behind it
 * (it is modal). From `current` (-1 when focus is not on one of them) among `count` controls.
 */
export function trapFocusIndex(count: number, current: number, back: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return back ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * Put focus back where it was before a viewer opened (the image, the diagram's expand button), if
 * that element is still on the page. Returns whether it did. Without this, closing a viewer that
 * took focus would leave it on the page body.
 */
export function refocus(target: { isConnected: boolean; focus(): void } | null | undefined): boolean {
  if (!target || !target.isConnected) return false;
  target.focus();
  return true;
}

/** What the preload script puts on `window.podcodeDesktop.viewer` (electron/preload.cts). */
export interface DesktopViewer {
  /** While true, Cmd+Plus, Cmd+Minus and Cmd+0 go to the page instead of the View menu. */
  captureZoomKeys(on: boolean): void;
}
