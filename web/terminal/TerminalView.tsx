/**
 * One terminal: Ghostty's emulator (ghostty-web) on a canvas, wired to its shell's socket. Every
 * terminal is mounted once, side by side with the others, and placed over its split's area (or
 * hidden), so splitting, switching tabs or switching projects never restarts its screen. A page
 * that mounts it fresh gets the shell's recent output replayed first.
 */
import type { FitAddon, Terminal } from 'ghostty-web';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { findLocalUrls } from '../../shared/browser.ts';
import type { TerminalInfo, TerminalServerMessage } from '../../shared/types.ts';
import { IS_MAC } from '../platform.ts';
import { runShortcut } from '../shortcuts.ts';
import { ContextMenu } from '../ui/ContextMenu.tsx';
import { toast, updateTerminals } from '../store.ts';
import { cx, MenuDivider, MenuRow } from '../ui/common.tsx';
import { ClipboardPaste, Copy, Eraser, Maximize2, Minimize2, SplitColumns, SplitRows, X } from '../mono/icons.tsx';
import {
  closeTerminals, equalizeSplits, focusSplit, newTerminal, notePreviewUrls, noteTerminalFocus, noteTerminalSize, setTerminalTitle,
  shellExited, splitTerminal, toggleZoom, useFocusRequest,
} from './actions.ts';
import { loadGhostty, TERMINAL_FONT, TERMINAL_FONT_SIZE, terminalTheme, useLightTheme } from './ghostty.ts';
import { classifyKey } from './keys.ts';
import type { Rect } from './splits.ts';

/** A shell that fails this soon after starting gets a toast, since its tab closes at once. */
const QUICK_EXIT_MS = 3000;
/** Shortcuts for the menu (ACH-D26); Ghostty's split keys are macOS only (web/terminal/keys.ts). */
const HINT = IS_MAC ? { right: 'Mod+D', down: 'Shift+Mod+D', zoom: 'Shift+Mod+Enter', equalize: 'Ctrl+Mod+=', close: 'Mod+W' } : null;

const percent = (n: number) => `${(n * 100).toFixed(4)}%`;

export function TerminalView({ info, rect, dimmed, split, zoomed }: {
  info: TerminalInfo;
  /** Where it sits in the panel's body, or null when its tab is not in front. */
  rect: Rect | null;
  /** Another split of the tab has focus: drawn dimmer, as in Ghostty. */
  dimmed: boolean;
  /** Its tab has more than one split. */
  split: boolean;
  zoomed: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const infoRef = useRef(info);
  infoRef.current = info;
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null);
  // ghostty-web cannot change colours once open, so a theme switch starts a fresh view.
  const light = useLightTheme();
  const visible = rect !== null;

  useEffect(() => {
    const wrapper = host.current;
    const mount = screen.current;
    if (!wrapper || !mount) return;
    let disposed = false;
    let exited = false;
    let socket: WebSocket | null = null;
    let retries = 0;
    let retryTimer: number | undefined;
    let term: Terminal | null = null;
    const encoder = new TextEncoder();
    // A dev server's address, for the panel's Preview button. The tail carries a URL split
    // across two reads into the next one.
    const decoder = new TextDecoder();
    let tail = '';
    const watchForUrls = (bytes: Uint8Array) => {
      const text = tail + decoder.decode(bytes, { stream: true });
      tail = text.slice(-300);
      if (text.includes('://')) notePreviewUrls(info.id, findLocalUrls(text));
    };
    const self = () => infoRef.current;

    const sendSize = () => {
      if (!term || socket?.readyState !== WebSocket.OPEN || term.cols < 2 || term.rows < 1) return;
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    const quickExit = (how: string) => {
      if (Date.now() - info.createdAt < QUICK_EXIT_MS) toast(`${info.shell} exited as soon as it started (${how}). Check your shell setup.`);
    };

    const connect = (again: boolean) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal/${info.id}`);
      ws.binaryType = 'arraybuffer';
      socket = ws;
      ws.onopen = () => {
        retries = 0;
        // The server replays the shell's recent output on every attach; start from a clean screen.
        if (again) term?.reset();
        sendSize();
      };
      ws.onmessage = event => {
        if (typeof event.data !== 'string') {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          term?.write(bytes);
          watchForUrls(bytes);
          return;
        }
        const message = JSON.parse(event.data) as TerminalServerMessage;
        if (message.type === 'exit') {
          exited = true;
          if (message.exitCode !== 0) quickExit(`code ${message.exitCode}`);
          shellExited(self(), wrapper.contains(document.activeElement));
        }
      };
      ws.onclose = event => {
        if (disposed || exited || event.code === 1000) return; // the shell ended or was closed
        if (event.code === 4404) {
          // Gone before this page attached: it failed at once, or the server restarted. The
          // list may still name it if its removal arrived before the request that created it.
          updateTerminals(list => list.filter(t => t.id !== info.id));
          quickExit('before the terminal attached');
          return;
        }
        // A dropped connection (a sleeping laptop): the shell is likely still there.
        if (retries++ < 6) retryTimer = window.setTimeout(() => connect(true), Math.min(4000, 250 * 2 ** retries));
      };
    };

    // Kept from ghostty-web, which would otherwise encode every modifier chord for the shell and
    // stop it there: app shortcuts and menu keys go on to the app, Option types its character,
    // and Ghostty's split keys work on the splits.
    const onKeyDown = (e: KeyboardEvent) => {
      if (!term || e.isComposing) return;
      const action = classifyKey(e, IS_MAC);
      if (action.kind === 'terminal') return;
      e.stopPropagation();
      if (action.kind === 'app') {
        if (runShortcut(e)) e.preventDefault();
        return;
      }
      e.preventDefault();
      switch (action.kind) {
        case 'send': term.input(action.data, true); break;
        case 'selectAll': term.selectAll(); break;
        case 'newTerminal': void newTerminal(self().projectId); break;
        case 'split': void splitTerminal(self(), action.dir); break;
        case 'closeSplit': void closeTerminals([self().id]); break;
        case 'focusSplit': focusSplit(self(), action.to); break;
        case 'zoomSplit': toggleZoom(self()); break;
        case 'equalizeSplits': equalizeSplits(self()); break;
      }
    };
    // Our menu instead of the browser's (or the desktop app's) Cut, Copy and Paste.
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY, selection: Boolean(term?.hasSelection()) });
    };
    const onFocusIn = () => noteTerminalFocus(self());
    wrapper.addEventListener('keydown', onKeyDown, true);
    wrapper.addEventListener('contextmenu', onContextMenu, true);
    wrapper.addEventListener('focusin', onFocusIn);

    loadGhostty().then(ghostty => {
      if (disposed) return;
      term = new ghostty.Terminal({
        fontFamily: TERMINAL_FONT,
        fontSize: TERMINAL_FONT_SIZE,
        scrollback: 10_000,
        cursorBlink: false,
        theme: terminalTheme(wrapper, light),
      });
      const fit = new ghostty.FitAddon();
      term.loadAddon(fit);
      term.open(mount);
      fit.fit();
      fit.observeResize();
      term.onData(data => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
      });
      term.onResize(({ cols, rows }) => {
        noteTerminalSize(cols, rows);
        sendSize();
      });
      term.onTitleChange(title => setTerminalTitle(info.id, title));
      noteTerminalSize(term.cols, term.rows);
      termRef.current = term;
      fitRef.current = fit;
      setReady(true);
      connect(false);
    }, (err: Error) => {
      if (!disposed) setFailure(err.message || 'The terminal could not load.');
    });

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      wrapper.removeEventListener('keydown', onKeyDown, true);
      wrapper.removeEventListener('contextmenu', onContextMenu, true);
      wrapper.removeEventListener('focusin', onFocusIn);
      socket?.close();
      fitRef.current?.dispose();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
  }, [info.id, info.shell, info.createdAt, light]);

  // A hidden terminal measures as zero; fit it whenever it shows or its split changes size.
  useEffect(() => {
    if (!visible || !ready) return;
    const frame = requestAnimationFrame(() => fitRef.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [visible, ready, rect?.w, rect?.h]);

  // Take the keyboard when asked to, once on screen and ready.
  const focus = useFocusRequest();
  const answered = useRef(0);
  useEffect(() => {
    if (focus.id !== info.id || focus.n === answered.current || !visible || !ready) return;
    const frame = requestAnimationFrame(() => {
      answered.current = focus.n;
      focusScreen(termRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, info.id, visible, ready]);

  const run = (action: () => void) => () => {
    setMenu(null);
    action();
  };
  const paste = async () => {
    const term = termRef.current;
    if (!term) return;
    focusScreen(term);
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text);
    } catch {
      // A browser tab may refuse to read the clipboard; the paste command still works there.
      document.execCommand('paste');
    }
  };
  const clear = () => {
    const term = termRef.current;
    if (!term) return;
    // Scrollback goes here; Ctrl+L has the shell clear the screen and draw its prompt again.
    term.write('\x1b[3J');
    term.input('\x0c', true);
    focusScreen(term);
  };

  const style: CSSProperties | undefined = rect ? { left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h) } : undefined;
  return (
    <div ref={host} className={cx('absolute bg-background-base text-content', !visible && 'hidden')} style={style}>
      {/* Keyed by theme so a switch mounts ghostty-web on a fresh element. ghostty-web makes it
          editable, so the browser's own caret is hidden: the terminal draws its cursor itself. */}
      <div key={light ? 'light' : 'dark'} ref={screen} className="absolute inset-0 overflow-hidden py-1 pl-3 pr-1 caret-transparent outline-none" />
      {dimmed ? <div aria-hidden className="pointer-events-none absolute inset-0 bg-background-base/40" /> : null}
      {failure ? (
        <div className="absolute inset-0 grid place-items-center p-6 text-center font-sans text-[12px] text-content/55">
          <p>The terminal could not start: {failure}</p>
        </div>
      ) : null}
      {menu ? (
        <ContextMenu anchor={{ x: menu.x, y: menu.y }} onClose={() => setMenu(null)} label="Terminal">
          <MenuRow icon={Copy} title="Copy" hint={menu.selection ? undefined : 'Select text first. Selecting copies it too.'} disabled={!menu.selection} onSelect={run(() => {
            const text = termRef.current?.getSelection();
            if (text) void navigator.clipboard.writeText(text).catch(() => document.execCommand('copy'));
          })} />
          <MenuRow icon={ClipboardPaste} title="Paste" shortcut="Mod+V" onSelect={run(() => void paste())} />
          <MenuDivider />
          <MenuRow icon={SplitColumns} title="Split right" shortcut={HINT?.right} onSelect={run(() => void splitTerminal(info, 'right'))} />
          <MenuRow icon={SplitRows} title="Split down" shortcut={HINT?.down} onSelect={run(() => void splitTerminal(info, 'down'))} />
          {split ? <MenuRow icon={zoomed ? Minimize2 : Maximize2} title={zoomed ? 'Show all splits' : 'Zoom this split'} shortcut={HINT?.zoom} onSelect={run(() => toggleZoom(info))} /> : null}
          {split && !zoomed ? <MenuRow icon={SplitColumns} title="Make splits equal" shortcut={HINT?.equalize} onSelect={run(() => equalizeSplits(info))} /> : null}
          <MenuDivider />
          <MenuRow icon={Eraser} title="Clear" hint="Screen and scrollback." onSelect={run(clear)} />
          <MenuRow icon={X} title={split ? 'Close split' : 'Close terminal'} shortcut={HINT?.close} danger onSelect={run(() => void closeTerminals([info.id]))} />
        </ContextMenu>
      ) : null}
    </div>
  );
}

/**
 * Give a terminal the keyboard where a click would: ghostty-web's hidden input. Its own focus()
 * picks the editable box around the canvas, where the browser would blink a text caret.
 */
function focusScreen(term: Terminal | null): void {
  if (term?.textarea) term.textarea.focus();
  else term?.focus();
}
