// How a teammate message reads in a transcript: what it is, how it came out, the line that says what
// it means, when it arrived, and which delegation a report answers. Pure, so it is tested directly.
import type { DelegationKind, Entry, PeerMessage, Report } from '../shared/types.ts';

export type OutcomeTone = 'success' | 'danger' | 'warning';

/**
 * The words the mail tools put at the top of a message, which say nothing a chip does not:
 * "REVIEW RESULT: FAILED", "IMPLEMENTATION RESULT: DONE", "REVIEW:", "IMPLEMENTATION:".
 */
const BOILERPLATE = /^\s*(implementation|review|testing|validation)(?:\s+(?:result|request|task))?\s*:\s*(?:(passed|failed|blocked|done)\b\.?\s*)?/i;

/** The delegation kind a message's own text names, from its boilerplate opening. */
export function boilerplateKind(text: string): DelegationKind | undefined {
  const match = BOILERPLATE.exec(text);
  return match ? (match[1].toLowerCase() as DelegationKind) : undefined;
}

/** The text without its boilerplate opening line or prefix. */
export function stripBoilerplate(text: string): string {
  return text.replace(BOILERPLATE, '').replace(/^\s+/, '');
}

/**
 * What a report's outcome means for the work it answers: a review that failed asks for changes and
 * one that passed approves; tests keep their own words; finished work is done.
 */
export function outcomeWords(outcome: Report['outcome'], kind?: DelegationKind): string {
  if (outcome === 'blocked') return 'Blocked';
  if (outcome === 'done') return 'Done';
  if (kind === 'review') return outcome === 'passed' ? 'Approved' : 'Changes needed';
  return outcome === 'passed' ? 'Passed' : 'Failed';
}

export function outcomeTone(outcome: Report['outcome']): OutcomeTone {
  return outcome === 'failed' ? 'danger' : outcome === 'blocked' ? 'warning' : 'success';
}

const KIND_WORDS: Record<DelegationKind, string> = {
  implementation: 'Implementation',
  testing: 'Testing',
  validation: 'Validation',
  review: 'Review',
};

export function kindWords(kind: DelegationKind): string {
  return KIND_WORDS[kind];
}

/** A greeting or sign-off line carries nothing to preview. */
const FILLER = /^(hi|hey|hello|thanks|thank you)\b[^.!?\n]*[,.!]?\s*$/i;

/**
 * The first sentence that says something: boilerplate and greetings dropped, whitespace folded,
 * cut at a sentence end (not inside "e6abf61." style tokens) or at `limit` characters.
 */
export function firstSentence(text: string, limit = 220): string {
  const lines = stripBoilerplate(text).split('\n').map(l => l.trim()).filter(Boolean);
  while (lines.length > 1 && FILLER.test(lines[0])) lines.shift();
  let flat = lines.join(' ').replace(/\s+/g, ' ').trim();
  // "Hi Fen, the user asked me..." keeps what follows the greeting.
  flat = flat.replace(/^(hi|hey|hello)\s+[^,.!?]{1,30},\s*/i, '');
  const end = /[.!?](?=\s+[A-Z(`"'])/.exec(flat);
  const sentence = end && end.index < limit ? flat.slice(0, end.index + 1) : flat;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1).trimEnd()}…` : sentence;
}

/** The kind of a report: from the delegation it answers, else from its own text. */
export function reportKind(message: PeerMessage, answered?: PeerMessage): DelegationKind | undefined {
  return answered?.delegation?.kind ?? boilerplateKind(message.text);
}

/** The line a message leads with: a report's summary, a delegation's task, else its first sentence. */
export function messagePreview(message: PeerMessage): string {
  if (message.report?.summary.trim()) return firstSentence(message.report.summary, 280);
  if (message.delegation?.task.trim()) return taskTitle(message.delegation.task);
  return firstSentence(message.text);
}

/** A delegation's task as a title: its first sentence, boilerplate dropped. */
export function taskTitle(task: string): string {
  return firstSentence(task, 140);
}

/** What kind of message it is, as a short tag. */
export function messageTag(message: PeerMessage): string {
  if (message.report) return 'Report';
  if (message.delegation) return kindWords(message.delegation.kind);
  if (message.channelId) return 'Channel';
  if (message.replyTo) return 'Reply';
  return message.expectsReply ? 'Question' : 'Note';
}

/** The message's whole body as Markdown, for when it is expanded. */
export function messageMarkdown(message: PeerMessage): string {
  if (message.report) {
    const parts = [message.report.summary.trim()];
    if (message.report.evidence.trim()) parts.push('**Evidence**', message.report.evidence.trim());
    return parts.join('\n\n');
  }
  if (message.delegation) {
    const d = message.delegation;
    const parts = [stripBoilerplate(d.task).trim()];
    if (d.acceptanceCriteria.trim()) parts.push('**Acceptance criteria**', d.acceptanceCriteria.trim());
    if (d.context?.trim()) parts.push('**Context**', d.context.trim());
    return parts.join('\n\n');
  }
  return stripBoilerplate(message.text).trim() || message.text;
}

/** Past this, a message that waited before its turn says when it was sent and when it arrived. */
export const LATE_AFTER_MS = 5 * 60 * 1000;

/** "sent 11:48, arrived 12:24" when the turn it opened started well after it was sent, else null. */
export function arrivalNote(sentAt: number, arrivedAt: number | undefined, clock: (ms: number) => string): string | null {
  if (arrivedAt === undefined || arrivedAt - sentAt < LATE_AFTER_MS) return null;
  return `sent ${clock(sentAt)}, arrived ${clock(arrivedAt)}`;
}

export interface CommsIndex {
  /** Messages in this transcript by id. */
  byId: Map<string, PeerMessage>;
  /** A delegation's report, by the delegation's message id: the latest one that answers it. */
  reportFor: Map<string, PeerMessage>;
}

/** Index the transcript's teammate messages so a report and its delegation can find each other. */
export function commsIndex(entries: readonly Entry[]): CommsIndex {
  const byId = new Map<string, PeerMessage>();
  for (const entry of entries) if (entry.kind === 'peer' && entry.peer) byId.set(entry.peer.id, entry.peer);
  const reportFor = new Map<string, PeerMessage>();
  for (const message of byId.values()) {
    if (!message.report || !message.replyTo) continue;
    const asked = byId.get(message.replyTo);
    if (!asked?.delegation) continue;
    const known = reportFor.get(asked.id);
    if (!known || known.ts <= message.ts) reportFor.set(asked.id, message);
  }
  return { byId, reportFor };
}

export interface DelegationState {
  label: string;
  tone: 'neutral' | 'busy' | OutcomeTone;
}

/** Where a delegation stands, from its message and the report that answers it (if any). */
export function delegationState(delegation: PeerMessage, report?: PeerMessage): DelegationState {
  if (report?.report) return { label: outcomeWords(report.report.outcome, delegation.delegation?.kind), tone: outcomeTone(report.report.outcome) };
  if (delegation.status === 'failed') return { label: 'Not delivered', tone: 'danger' };
  if (delegation.status === 'cancelled') return { label: 'Cancelled', tone: 'warning' };
  if (delegation.status === 'queued') return { label: 'Sent', tone: 'neutral' };
  if (delegation.status === 'delivering') return { label: 'Working', tone: 'busy' };
  return { label: 'Awaiting report', tone: 'neutral' };
}

/**
 * Turns whose prompt an earlier turn already ran: the same message delivered again (after a restart,
 * say). The first stays the message's turn; the ids returned are the repeats.
 */
export function repeatedPromptTurns(turns: readonly { id: string; prompt?: Entry }[]): Set<string> {
  const seen = new Set<string>();
  const repeats = new Set<string>();
  for (const turn of turns) {
    const prompt = turn.prompt;
    if (!prompt || prompt.kind !== 'peer') continue;
    if (seen.has(prompt.id)) repeats.add(turn.id);
    else seen.add(prompt.id);
  }
  return repeats;
}
