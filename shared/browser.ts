/**
 * The integrated browser's rules that do not depend on Electron: which addresses it may open,
 * how a typed address becomes a URL, how an accessibility tree reads as text for an agent, and
 * which keys an agent may press. electron/browser.ts and the page both use them; tests cover them.
 */

/** What the address bar accepts as a bare host: localhost, an IP, or a name with a dot. */
const HOSTLIKE = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d{1,5})?(?:[/?#].*)?$/i;

/**
 * A typed address as a URL: `localhost:3000` and `example.com/x` gain a scheme (http for local
 * hosts, https otherwise); anything that does not look like an address is null.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).href;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /\s/.test(text) || !HOSTLIKE.test(text)) return null;
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(text);
  try {
    return new URL(`${local ? 'http' : 'https'}://${text}`).href;
  } catch {
    return null;
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Why the browser will not open a URL, or null when it may. Only http and https, and never
 * AgentsCode itself: a page there could act as the user (`appPort` is the server's port).
 */
export function blockedReason(url: string, appPort: number): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'That is not a valid URL.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'The browser only opens http and https addresses.';
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (isLocalUrl(url) && port === appPort) return 'The browser does not open AgentsCode itself.';
  return null;
}

/**
 * localhost and 127.0.0.1 addresses in a stretch of terminal output, as a dev server prints
 * them: "Local: http://localhost:5173/". Colour codes are stripped first; each URL appears once.
 */
export function findLocalUrls(text: string): string[] {
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  const found = new Set<string>();
  for (const match of plain.matchAll(/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>)\]]*)?/gi)) {
    const url = match[0].replace(/[.,;:]+$/, '').replace('0.0.0.0', 'localhost');
    try {
      found.add(new URL(url).href);
    } catch {
      // not a URL after all
    }
  }
  return [...found];
}

/** A node of Chrome's accessibility tree, as Accessibility.getFullAXTree returns it. */
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Roles an agent can act on; each gets a ref like [e3]. */
const ACTIONABLE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'treeitem', 'listbox',
]);
/** Roles that only wrap other nodes; they are left out and their children move up a level. */
const WRAPPERS = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'group', 'Section']);
const STATES = ['checked', 'selected', 'expanded', 'disabled', 'pressed', 'required', 'focused'];

/** A text piece with nothing to act on inside it: joined with its neighbours into one line. */
function plainText(node: AXNode): boolean {
  return !node.ignored && str(node.role?.value) === 'StaticText' && Boolean(str(node.name?.value).trim());
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

/**
 * The tree as indented lines an agent can read, with a ref on every node it can act on.
 * Text that only repeats its parent's name is dropped, and a run of text pieces (pages that wrap
 * each word in its own element for an animation) reads as one line. `refs` maps each ref to its DOM node.
 */
export function formatAXTree(nodes: AXNode[], maxChars: number): { text: string; refs: Map<string, number>; truncated: boolean } {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const root = nodes.find(n => !n.parentId) ?? nodes[0];
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  const walk = (node: AXNode, depth: number, parentName: string) => {
    if (truncated) return;
    const role = str(node.role?.value);
    const name = str(node.name?.value).replace(/\s+/g, ' ').trim();
    const skip = node.ignored || WRAPPERS.has(role) || (role === 'StaticText' && (!name || parentName.includes(name)));
    let nextDepth = depth;
    if (!skip && role) {
      let line = `${'  '.repeat(depth)}- ${role}${name ? ` "${name.slice(0, 200)}"` : ''}`;
      const value = str(node.value?.value);
      if (value && value !== name) line += ` value="${value.slice(0, 200)}"`;
      for (const p of node.properties ?? []) {
        if (STATES.includes(p.name) && p.value?.value !== undefined && p.value.value !== false) line += p.value.value === true ? ` ${p.name}` : ` ${p.name}=${str(p.value.value)}`;
        if (p.name === 'url' && role === 'link' && str(p.value?.value)) line += ` -> ${str(p.value?.value)}`;
      }
      if (ACTIONABLE.has(role) && node.backendDOMNodeId !== undefined) {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, node.backendDOMNodeId);
        line += ` [${ref}]`;
      }
      if (!push(line)) return;
      nextDepth = depth + 1;
    }
    const childParent = skip ? parentName : name;
    let run: string[] = [];
    const flush = () => {
      const text = run.join(' ').replace(/\s+/g, ' ').trim();
      run = [];
      if (text && !childParent.includes(text)) push(`${'  '.repeat(nextDepth)}- StaticText "${text.slice(0, 400)}"`);
    };
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (!child) continue;
      if (plainText(child)) {
        run.push(str(child.name?.value));
        continue;
      }
      flush();
      walk(child, nextDepth, childParent);
    }
    flush();
  };
  const push = (line: string): boolean => {
    if (truncated) return false;
    if (length + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };
  if (root) walk(root, 0, '');
  return { text: lines.join('\n'), refs, truncated };
}

/** Keys browser_press accepts, as CDP Input.dispatchKeyEvent describes them. */
const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};

export const PRESSABLE_KEYS = [...Object.keys(NAMED_KEYS), 'any single character'];

/** The key event for a key name, or null when browser_press does not know it. */
export function keyEvent(key: string): { key: string; code: string; windowsVirtualKeyCode: number; text?: string } | null {
  const named = NAMED_KEYS[key];
  if (named) return { key: key === 'Space' ? ' ' : key, code: named.code, windowsVirtualKeyCode: named.keyCode, text: named.text };
  if ([...key].length !== 1) return null;
  const upper = key.toUpperCase();
  const letter = /^[A-Z]$/.test(upper);
  const digit = /^[0-9]$/.test(key);
  return {
    key,
    code: letter ? `Key${upper}` : digit ? `Digit${key}` : '',
    windowsVirtualKeyCode: letter || digit ? upper.charCodeAt(0) : 0,
    text: key,
  };
}

/** One console line kept for a tab: what the page logged, threw, or failed to load. */
export interface ConsoleEntry {
  seq: number;
  ts: number;
  level: 'debug' | 'log' | 'info' | 'warn' | 'error';
  source: 'console' | 'exception' | 'network';
  text: string;
  url?: string;
}

/** The state of one browser tab the page draws in its toolbar. */
export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  errors: number;
  /** The agent that owns the tab, if an agent opened it. */
  agentId: string | null;
  /** An agent is acting in the tab right now (until a moment after its last action). */
  driving: boolean;
  /** The user took the tab over: agent input stays paused until the agent opens it again. */
  paused: boolean;
  /** Set when the last load failed: what to show instead of the page. */
  failure: string | null;
}

/** Events main sends the page about browser tabs. */
export type BrowserEvent =
  | { type: 'state'; tab: BrowserTabState }
  | { type: 'closed'; id: string }
  /** An agent opened a tab, or a page inside a tab opened a new window: show it beside. */
  | { type: 'opened'; tab: BrowserTabState; side: boolean }
  /** The app's own page asked to open a local link (a localhost URL in a transcript). */
  | { type: 'open-url'; url: string }
  /** A shortcut pressed while the browser view had the keyboard, for the page to run. */
  | { type: 'shortcut'; key: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }
  /** The user clicked into a browser view: focus its pane. */
  | { type: 'focus'; id: string }
  /** Cmd+L inside a browser view: put the caret in that tab's address bar. */
  | { type: 'focus-address'; id: string };

/** What the preload script puts on `window.agentscodeDesktop.browser` (electron/preload.cts). */
export interface DesktopBrowser {
  call(op: string, args?: unknown): Promise<unknown>;
  onEvent(callback: (event: BrowserEvent) => void): () => void;
}
