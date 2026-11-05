import type { Entry } from '../../shared/types.ts';

/** A scorer's verdict on session 2. `pass: null` is inconclusive (nothing to judge); it is left out of rates. */
export interface Score {
  pass: boolean | null;
  detail: string;
}

/** What a scorer can see of session 2. */
export interface SessionView {
  /** The project folder, after session 2. */
  project: string;
  /** Transcript entries from session 2 only. */
  entries: Entry[];
  /** The agent's last message in session 2 (its final reply). */
  finalReply: string;
  /** Every shell command the agent ran in session 2, in order: Claude's Bash and Codex's Shell. */
  commands: string[];
  /** A project file's text, or null when it does not exist. Paths are relative, with '/'. */
  read(rel: string): string | null;
  /** Project files that are new or differ from the seed, relative, sorted. */
  changed: string[];
  /** Project files that the seed did not have. */
  added: string[];
}

/** One thing to learn in session 1 and apply in session 2. */
export interface Lesson {
  id: string;
  /** The lesson as a memory entry; the dry engine's remember and dream write this. Must match `knows`. */
  text: string;
  /** Matches text that carries the lesson: used to see whether memory holds it, and by the dry engine. */
  knows: RegExp;
  /**
   * A substring of the session-1 digest item a dream would cite for this lesson (a user message, or a
   * result the user confirmed). The dry dream cites the item that contains it.
   */
  evidence: string;
}

/** One turn of the dry-run engine. */
export interface FakeTurn {
  session: 1 | 2;
  /** Which user message of the session this turn answers, from 0. */
  step: number;
  /** Whether a lesson (all lessons, with no id) is in the engine's context: its instructions or the prompt. */
  knows(lessonId?: string): boolean;
  read(rel: string): string | null;
  write(rel: string, text: string): void;
  remove(rel: string): void;
  /** Record a shell command as a tool call; nothing is executed. */
  run(command: string, result?: { ok?: boolean; output?: string }): void;
}

export type ScenarioKind = 'explicit' | 'hard';

/**
 * Session 1 is three or more user messages (so the real dream gate, three turns, applies) holding one or
 * more lessons; session 2 is a fresh session with a different task where the lessons matter. The
 * project is put back to the seed before session 2, so a lesson can only travel through memory.
 */
export interface Scenario {
  id: string;
  title: string;
  /** explicit: a plain user correction, which agents usually save themselves. hard: lessons they rarely save. */
  kind: ScenarioKind;
  lessons: Lesson[];
  /** Project files, relative path to contents. */
  seed: Record<string, string>;
  /** Session 1's user messages, in order; at least three. */
  session1: string[];
  /** Edits the user makes by hand after session-1 turn N (0-based), before the next message. */
  userEdits?: Record<number, (project: ProjectFiles) => void>;
  session2: string;
  score(view: SessionView): Score;
  /** What the dry-run engine does in a turn, so the plumbing can be checked without a model. Returns its reply. */
  fake(turn: FakeTurn): string;
  /** Dry runs: whether the fake agent saves the lesson itself with remember when it is told it (like real agents do for plain corrections). */
  fakeRemembers: boolean;
}

/** File access for a user edit. */
export interface ProjectFiles {
  read(rel: string): string | null;
  write(rel: string, text: string): void;
}
