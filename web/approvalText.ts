// How an approval reads in the transcript: the question as a sentence with what it acts on picked
// out, the file it names, and whether its detail is worth showing up front (a command, a diff) or is
// raw tool input that waits behind "Show details". Also when Enter and Esc may answer it. Pure, so
// it is tested directly.
import type { Approval } from '../shared/types.ts';

export interface ApprovalText {
  /** The verb that opens the question: "Run", "Edit", "Read", "Use". */
  lead: string;
  /** What it acts on, shown in bold; empty when the title is not "Verb target?". */
  target: string;
  /** For a read-only lookup, the file or folder it names, with the home folder as ~. */
  path: string;
  /** Detail to show up front: a command, a diff, a prompt, or a tool's input as "key: value" lines. */
  shown: string;
  /** A read-only lookup's raw input (JSON), kept behind "Show details". */
  hidden: string;
}

/**
 * Tools that only look things up. Their raw input is tucked away, since the question already says
 * what is read. Every other tool changes something or reaches outside, so its input stays in sight.
 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

function jsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A tool's input as "key: value" lines: strings as they are, anything else as JSON. Nothing is left out. */
export function inputSummary(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
    .join('\n');
}

/** The path with the user's home folder as ~ ("/Users/me/x" and "/home/me/x"). */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

/**
 * What an approval shows. Which tool it is decides what may be hidden (`toolName`), never the shape
 * of its detail: text that happens to parse as JSON, such as a file being written, is still shown.
 */
export function approvalText(approval: Pick<Approval, 'title' | 'detail' | 'toolName'>): ApprovalText {
  const title = approval.title.trim();
  const match = /^(\S+)\s+(.+?)\?$/.exec(title);
  let lead = match ? match[1] : title;
  let target = match ? match[2] : '';
  const input = jsonObject(approval.detail);
  if (READ_ONLY_TOOLS.has(approval.toolName)) {
    const named = input ? PATH_KEYS.map(key => input[key]).find((v): v is string => typeof v === 'string' && v.length > 0) : undefined;
    // "Use Read?" with a file in its input reads better as the file: "Read notes.md?".
    if (lead === 'Use' && named && target === approval.toolName) {
      lead = approval.toolName === 'LS' ? 'List' : approval.toolName;
      target = named.split(/[\\/]/).filter(Boolean).pop() ?? named;
    }
    return { lead, target, path: named ? tildePath(named) : '', shown: input ? '' : approval.detail, hidden: input ? approval.detail.trim() : '' };
  }
  // The server sends an unknown tool's input as JSON (describe.ts toolDetail): shown, one key a line.
  const generic = input && lead === 'Use';
  return { lead, target, path: '', shown: generic ? inputSummary(input) : approval.detail, hidden: '' };
}

export interface ApprovalKey {
  key: string;
  /** Any of Cmd, Ctrl, Alt or Shift held, a repeat, or IME composition. */
  modified: boolean;
  /** Where the key was pressed: with focus nowhere, inside this approval's pane, or somewhere else. */
  focus: 'none' | 'pane' | 'elsewhere';
  /** This approval's pane is the focused one (PaneFrame's chrome.focused). */
  paneFocused: boolean;
  /** The approval's Allow button is in view: not scrolled out of the transcript, not in a hidden tab. */
  onScreen: boolean;
  /** This is the first approval waiting in its pane. */
  first: boolean;
  /** How long since this approval appeared, or since another one in its pane was answered, whichever is later. */
  settledForMs: number;
  /** Focus is in a text field, other than this pane's composer while it has been empty a while. */
  typing: boolean;
  /** A menu, picker or dialog is open, or a button has focus; Enter and Esc are its. */
  overlay: boolean;
}

/**
 * A key pressed this soon after an approval lands, after the one before it is answered, or after
 * the composer empties (you just sent a message) was meant for that, not for this approval.
 */
export const APPROVAL_KEY_GUARD_MS = 600;

/**
 * What a key press does to a waiting approval: Enter allows it, Esc denies it, anything else
 * nothing. Only for the first approval of the pane you are in, while it is on screen: with focus
 * nowhere that is the focused pane; focus inside another pane, or anywhere else, is never ours.
 */
export function approvalKeyAction(press: ApprovalKey): 'allow' | 'deny' | null {
  if (press.key !== 'Enter' && press.key !== 'Escape') return null;
  if (press.modified || press.typing || press.overlay) return null;
  const mine = press.focus === 'pane' || (press.focus === 'none' && press.paneFocused);
  if (!mine || !press.first || !press.onScreen) return null;
  if (press.settledForMs < APPROVAL_KEY_GUARD_MS) return null;
  return press.key === 'Enter' ? 'allow' : 'deny';
}
