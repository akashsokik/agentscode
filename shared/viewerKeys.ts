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

/** What the preload script puts on `window.podcodeDesktop.viewer` (electron/preload.cts). */
export interface DesktopViewer {
  /** While true, Cmd+Plus, Cmd+Minus and Cmd+0 go to the page instead of the View menu. */
  captureZoomKeys(on: boolean): void;
}
