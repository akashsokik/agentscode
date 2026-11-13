// The shared status mark's states (ACH-D45), as data so tests can read them: each state's glyph,
// by its name in web/mono/icons, and its colour. From MonoCode's checkMark
// (src/features/inbox/ui/InboxPrChecks.tsx): circled glyphs, never a bare tick or cross.

export type StatusState = 'pass' | 'fail' | 'pending' | 'cancel' | 'skip' | 'unknown' | 'warn';
export type StatusGlyph = 'CheckCircle' | 'CircleX' | 'LoaderCircle' | 'Minus' | 'CircleDashed' | 'CircleHelp' | 'AlertCircle';

export const STATUS_MARKS: Record<StatusState, { glyph: StatusGlyph; tone: string; word: string }> = {
  pass: { glyph: 'CheckCircle', tone: 'text-success', word: 'Passed' },
  fail: { glyph: 'CircleX', tone: 'text-danger', word: 'Failed' },
  pending: { glyph: 'LoaderCircle', tone: 'animate-spin text-content/55', word: 'In progress' },
  cancel: { glyph: 'Minus', tone: 'text-content/45', word: 'Cancelled' },
  skip: { glyph: 'CircleDashed', tone: 'text-content/40', word: 'Skipped' },
  unknown: { glyph: 'CircleHelp', tone: 'text-content/45', word: 'Unknown' },
  warn: { glyph: 'AlertCircle', tone: 'text-warning', word: 'Needs attention' },
};

/** The colour a mark takes: its own, or (quiet) none, for a result that needs nothing from you. */
export function statusTone(state: StatusState, quiet = false): string {
  if (!quiet) return STATUS_MARKS[state].tone;
  return state === 'pending' ? 'animate-spin text-content/40' : 'text-content/40';
}

/** Words only take the state's colour when it needs you, as StatusLabel does. */
export function statusWordsTone(state: StatusState, quiet = false): string {
  if (quiet) return 'text-content/40';
  return state === 'fail' ? 'text-danger' : state === 'warn' ? 'text-warning' : 'text-content/55';
}

/** The state in words, for headings and accessible names ("Failed", "In progress"). */
export function statusWord(state: StatusState): string {
  return STATUS_MARKS[state].word;
}
