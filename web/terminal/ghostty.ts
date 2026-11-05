/**
 * Ghostty's terminal emulator, compiled to WebAssembly by ghostty-web (Coder, MIT): the same
 * VT parser and screen model as the Ghostty app, drawn on a canvas. It is a chunk of its own,
 * with the WebAssembly inlined, loaded once when the first terminal opens.
 */
import type { ITheme } from 'ghostty-web';
import { useSyncExternalStore } from 'react';

export type Ghostty = typeof import('ghostty-web');
let loading: Promise<Ghostty> | null = null;

export function loadGhostty(): Promise<Ghostty> {
  loading ??= import('ghostty-web')
    .then(async ghostty => {
      await ghostty.init();
      return ghostty;
    })
    .catch((err: unknown) => {
      loading = null;
      throw err instanceof Error ? err : new Error(String(err));
    });
  return loading;
}

/** Ghostty's own pairing: JetBrains Mono, with Nerd Font symbols for fancy prompts, then the system's. */
export const TERMINAL_FONT = '"JetBrains Mono", "JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", "SF Mono", Menlo, Monaco, Consolas, "DejaVu Sans Mono", monospace';
export const TERMINAL_FONT_SIZE = 12;

/** Ghostty's default palette (Tomorrow Night) on the dark theme. */
const DARK: ITheme = {
  background: '#171717',
  foreground: '#ebebeb',
  selectionBackground: '#3e4451',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};

/** Its light sibling (Tomorrow), with white and yellow darkened enough to read on the light theme. */
const LIGHT: ITheme = {
  background: '#f7f7f7',
  foreground: '#262626',
  selectionBackground: '#cdd9e8',
  black: '#1d1f21',
  red: '#c82829',
  green: '#718c00',
  yellow: '#a87b00',
  blue: '#4271ae',
  magenta: '#8959a8',
  cyan: '#3e999f',
  white: '#8e908c',
  brightBlack: '#5c5c5c',
  brightRed: '#d7373a',
  brightGreen: '#5b7d00',
  brightYellow: '#b58900',
  brightBlue: '#3465a4',
  brightMagenta: '#a35bc6',
  brightCyan: '#2c8a91',
  brightWhite: '#6b6b6b',
};

let probe: CanvasRenderingContext2D | null = null;

/** ghostty-web reads #rrggbb or rgb() only; the page's colours are hsl() and color-mix(). */
function toHex(color: string): string | null {
  probe ??= document.createElement('canvas').getContext('2d');
  if (!probe || !color) return null;
  probe.fillStyle = '#000000';
  probe.fillStyle = color;
  const value = String(probe.fillStyle);
  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

/** The palette for the theme, on the panel's own background and text colours. */
export function terminalTheme(el: HTMLElement, light: boolean): ITheme {
  const base = light ? LIGHT : DARK;
  const style = getComputedStyle(el);
  const background = toHex(style.backgroundColor) ?? base.background!;
  const foreground = toHex(style.color) ?? base.foreground!;
  return { ...base, background, foreground, cursor: foreground, cursorAccent: background };
}

/** Whether the light theme is on (web/theme.ts sets the class), following changes. */
export function useLightTheme(): boolean {
  return useSyncExternalStore(listener => {
    const observer = new MutationObserver(listener);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, () => document.documentElement.classList.contains('theme-light'));
}
