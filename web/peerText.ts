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

/** A review that asks for changes is a warning, not a failure: the work goes on. */
export function outcomeTone(outcome: Report['outcome'], kind?: DelegationKind): OutcomeTone {
  if (outcome === 'failed') return kind === 'review' ? 'warning' : 'danger';
  return outcome === 'blocked' ? 'warning' : 'success';
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

const ASKED: Record<DelegationKind, string> = {
  implementation: 'asked for an implementation',
  testing: 'asked for testing',
  validation: 'asked for validation',
  review: 'asked for a review',
};

/**
 * What the sender did, as the words after its name in a transcript header: "SuperAgent asked for an
 * implementation", "Ada reported back". `channel` is the channel's name when it came through one.
 */
export function messagePhrase(message: PeerMessage, channel?: string): string {
  if (channel) return message.replyTo ? `answered in #${channel}` : `posted in #${channel}`;
  if (message.report) return 'reported back';
  if (message.delegation) return ASKED[message.delegation.kind];
  if (message.replyTo) return 'replied';
  return message.expectsReply ? 'asked' : 'sent a note';
}

/**
 * A message in an agent's own work trail, as one phrase from that agent's side: "Reported to
 * SuperAgent", "Replied to Ada", "Note from Rhea".
 */
export function trailPhrase(message: PeerMessage, selfId: string, channel?: string): string {
  const sent = message.toAgentId !== selfId;
  if (channel) return sent ? `Posted in #${channel}` : `${message.fromName} in #${channel}`;
  if (sent) {
    if (message.report) return `Reported to ${message.toName}`;
    if (message.delegation) return `${kindWords(message.delegation.kind)} for ${message.toName}`;
    if (message.replyTo) return `Replied to ${message.toName}`;
    return message.expectsReply ? `Asked ${message.toName}` : `Note to ${message.toName}`;
  }
  return `${messageTag(message)} from ${message.fromName}`;
}

/** The message's whole body as Markdown, for when it is expanded. */
export function messageMarkdown(message: PeerMessage): string {
  if (message.report) {
    const parts = [message.report.summary.trim()];
    // Evidence is mostly command output: kept as code, so line breaks and *, _ or # stay as they are.
    const evidence = message.report.evidence.trim();
    if (evidence) parts.push('**Evidence**', evidence.includes('```') ? evidence : `\`\`\`text\n${evidence}\n\`\`\``);
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
  if (report?.report) {
    const kind = delegation.delegation?.kind;
    return { label: outcomeWords(report.report.outcome, kind), tone: outcomeTone(report.report.outcome, kind) };
  }
  if (delegation.status === 'failed') return { label: 'Not delivered', tone: 'danger' };
  if (delegation.status === 'cancelled') return { label: 'Cancelled', tone: 'warning' };
  if (delegation.status === 'queued') return { label: 'Sent', tone: 'neutral' };
  if (delegation.status === 'delivering') return { label: 'Working', tone: 'busy' };
  return { label: 'Awaiting report', tone: 'neutral' };
}

/**
 * Turns whose prompt an earlier turn already ran: the same message delivered again (after a restart,
 * say). The first stays the message's turn; each repeat maps to when that first turn started, for
 * "Redelivered: same report as 12:24".
 */
export function repeatedPromptTurns(turns: readonly { id: string; prompt?: Entry; startedAt: number }[]): Map<string, number> {
  const first = new Map<string, number>();
  const repeats = new Map<string, number>();
  for (const turn of turns) {
    const prompt = turn.prompt;
    if (!prompt || prompt.kind !== 'peer') continue;
    const at = first.get(prompt.id);
    if (at !== undefined) repeats.set(turn.id, at);
    else first.set(prompt.id, turn.startedAt);
  }
  return repeats;
}
