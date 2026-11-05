/** Where the page runs, for the few things that differ by platform. */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The macOS desktop app (electron/main.ts). Its window has no title bar: the traffic lights sit
 * over the page's top-left corner, and the page's headers drag the window.
 */
export const IS_DESKTOP_APP = IS_MAC && /\bElectron\//.test(navigator.userAgent);
