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
  /** The file or folder the input names, with the home folder as ~. */
  path: string;
  /** Detail to show up front: a command, a diff, a prompt. */
  shown: string;
  /** Raw tool input (JSON), kept behind "Show details". */
  hidden: string;
}

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

/** The path with the user's home folder as ~ ("/Users/me/x" and "/home/me/x"). */
export function tildePath(path: string): string {
  return path.replace(/^(?:\/Users|\/home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
}

export function approvalText(approval: Pick<Approval, 'title' | 'detail'>): ApprovalText {
  const title = approval.title.trim();
  const match = /^(\S+)\s+(.+?)\?$/.exec(title);
  const input = jsonObject(approval.detail);
  const named = input ? PATH_KEYS.map(key => input[key]).find((v): v is string => typeof v === 'string' && v.length > 0) : undefined;
  const path = named ? tildePath(named) : '';
  let lead = match ? match[1] : title;
  let target = match ? match[2] : '';
  // "Use Read?" with a file in its input reads better as the file: "Read notes.md?".
  if (lead === 'Use' && named && /^[A-Za-z]+$/.test(target)) {
    lead = target;
    target = named.split(/[\\/]/).filter(Boolean).pop() ?? named;
  }
  return { lead, target, path, shown: input ? '' : approval.detail, hidden: input ? approval.detail.trim() : '' };
}

export interface ApprovalKey {
  key: string;
  /** Any of Cmd, Ctrl, Alt or Shift held, a repeat, or IME composition. */
  modified: boolean;
  /** How long the approval has been on screen. */
  shownForMs: number;
  /** Focus is in this approval's own pane, or nowhere. */
  inScope: boolean;
  /** Focus is in a text field that has text, or one that is not this pane's composer. */
  typing: boolean;
  /** A menu, picker or dialog is open; Enter and Esc are its. */
  overlay: boolean;
  /** This is the first approval waiting in its pane. */
  first: boolean;
}

/** A key pressed this soon after an approval lands was meant for something else. */
export const APPROVAL_KEY_GUARD_MS = 600;

/** What a key press does to a waiting approval: Enter allows it, Esc denies it, anything else nothing. */
export function approvalKeyAction(press: ApprovalKey): 'allow' | 'deny' | null {
  if (press.key !== 'Enter' && press.key !== 'Escape') return null;
  if (press.modified || press.typing || press.overlay || !press.inScope || !press.first) return null;
  if (press.shownForMs < APPROVAL_KEY_GUARD_MS) return null;
  return press.key === 'Enter' ? 'allow' : 'deny';
}
