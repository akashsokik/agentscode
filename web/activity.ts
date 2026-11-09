import type { Entry, ToolCall } from '../shared/types.ts';

/**
 * A turn's work, laid out the way MonoCode's transcriptActivity.ts lays it out: the agent's prose
 * stands on its own, runs of tool calls between it are activity groups, and the work the agent has
 * already written past folds away behind the turn's status line. Pure, so it is tested directly.
 */

/** Comms tools that send mail: the peer row already shows what they sent. */
export const SENDING_TOOLS = /(?:^mcp__agentscode__|^agentscode\.)(send_message|reply|delegate_task|report_result)$/;
/** Memory tools: what the agent learned or dropped reads as one line of its own, not as work. */
export const MEMORY_TOOLS = /(?:^mcp__agentscode__|^agentscode\.)(remember|forget)$/;

/** The walkthrough tool: what it made shows as a card of its own, not as work. */
export const WALKTHROUGH_TOOL = /(?:^mcp__agentscode__|^agentscode\.)create_walkthrough$/;

export type WorkKind = 'edit' | 'run' | 'agent' | 'research' | 'plan' | 'other';
/** A group's icon: the work it did most of, or a note when it holds only messages and status. */
export type PhaseKind = WorkKind | 'note';

export type TurnItem =
  | { type: 'prose'; entry: Entry }
  | { type: 'memory'; entry: Entry }
  | { type: 'dream'; entry: Entry }
  | { type: 'walkthrough'; entry: Entry }
  /** A delegation this agent sent: a card that follows the work to its report (PeerMessages.tsx). */
  | { type: 'delegation'; entry: Entry }
  | { type: 'activity'; entries: Entry[] };

/** The span of a turn's items that folds away once the agent has answered for it. */
export interface WorkFold {
  start: number;
  end: number;
}

export function isHiddenTool(entry: Entry): boolean {
  return entry.kind === 'tool' && SENDING_TOOLS.test(entry.tool?.name ?? '');
}

export function isMemoryTool(entry: Entry): boolean {
  return entry.kind === 'tool' && MEMORY_TOOLS.test(entry.tool?.name ?? '');
}

export function isWalkthroughTool(entry: Entry): boolean {
  return entry.kind === 'tool' && WALKTHROUGH_TOOL.test(entry.tool?.name ?? '');
}

/** The walkthrough a create_walkthrough call made, read from the tool's result; null until it succeeds. */
export function walkthroughResult(tool: ToolCall): { id: string; title: string; stepCount: number } | null {
  if (tool.status !== 'ok' || !tool.output) return null;
  const start = tool.output.indexOf('{');
  if (start < 0) return null;
  try {
    const created = (JSON.parse(tool.output.slice(start)) as { created?: { id?: unknown; title?: unknown; stepCount?: unknown } }).created;
    if (typeof created?.id !== 'string' || typeof created.title !== 'string') return null;
    return { id: created.id, title: created.title, stepCount: typeof created.stepCount === 'number' ? created.stepCount : 0 };
  } catch {
    return null;
  }
}

/** The line a dream writes when it finishes: "Dreamed: +2 -1 ~1, soul change proposed". */
export function isDreamLine(entry: Entry): boolean {
  return entry.kind === 'system' && /^Dreamed:/.test(entry.text);
}

/** A memory tool call as its line reads: "Remembered: <text>", "Forgot: <text>". */
export function memoryLine(tool: ToolCall): { verb: string; text: string } {
  const forget = /forget$/.test(tool.name);
  // The server's summary already leads with the verb; the line says it once, by the call's state.
  const text = tool.summary.replace(/^(remembered|remembering|remember|forgot|forgetting|forget)\s*:\s*/i, '').trim();
  const verb = tool.status === 'error' ? (forget ? 'Could not forget' : 'Could not remember')
    : tool.status === 'running' ? (forget ? 'Forgetting' : 'Remembering')
    : forget ? 'Forgot' : 'Remembered';
  return { verb, text };
}

/** Tool calls, status lines and teammate messages: the steps of a turn's work. */
export function isActivity(entry: Entry): boolean {
  if (entry.kind === 'tool') return !isHiddenTool(entry) && !isMemoryTool(entry) && !isWalkthroughTool(entry);
  if (isDreamLine(entry)) return false;
  return entry.kind === 'system' || entry.kind === 'peer';
}

/** A delegation this agent sent, which stands on its own so its live status stays in view. */
export function isOutgoingDelegation(entry: Entry): boolean {
  return entry.kind === 'peer' && Boolean(entry.peer?.delegation) && entry.peer!.fromAgentId === entry.agentId;
}

/** A turn item's identity, stable as the group it names grows. */
export function turnItemKey(item: TurnItem): string {
  return item.type === 'activity' ? item.entries[0].id : item.entry.id;
}

/**
 * Contiguous runs of work become activity groups; the agent's prose always stands on its own, so
 * the readable transcript never disappears into activity chrome, and so does what it remembered or
 * forgot. Prompts, results and errors are not items: the turn lays those out itself.
 */
export function groupTurnItems(entries: Entry[]): TurnItem[] {
  const items: TurnItem[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (run.length) items.push({ type: 'activity', entries: run });
    run = [];
  };
  for (const entry of entries) {
    if (isMemoryTool(entry)) {
      flush();
      items.push({ type: 'memory', entry });
    } else if (isDreamLine(entry)) {
      flush();
      items.push({ type: 'dream', entry });
    } else if (isWalkthroughTool(entry)) {
      flush();
      items.push({ type: 'walkthrough', entry });
    } else if (isOutgoingDelegation(entry)) {
      flush();
      items.push({ type: 'delegation', entry });
    } else if (isActivity(entry)) {
      run.push(entry);
    } else if (entry.kind === 'agent' && entry.text.trim()) {
      flush();
      items.push({ type: 'prose', entry });
    }
  }
  flush();
  return items;
}

/**
 * The work a turn can put away: everything from the first thing the agent did up to the last group
 * it has already written past. As the turn runs, each new paragraph folds the work and commentary
 * before it, leaving the latest words and whatever the agent is doing now in view. A memory line
 * alone is not work to put away, and one inside the fold stays in view under it (see keptInView).
 */
export function foldableWork(items: TurnItem[]): WorkFold | undefined {
  let answered = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const type = items[index].type;
    if (type === 'prose') answered = true;
    else if (answered && type === 'activity') return { start: 0, end: index };
  }
  return undefined;
}

/** The items of a closed fold that stay in view under its line: what the agent remembered, forgot or dreamed. */
export function keptInView(items: TurnItem[], fold: WorkFold | undefined): TurnItem[] {
  return fold ? items.slice(fold.start, fold.end + 1).filter(item => item.type === 'memory' || item.type === 'dream' || item.type === 'walkthrough' || item.type === 'delegation') : [];
}

export function toolCategory(tool: ToolCall): WorkKind {
  switch (tool.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Read':
    case 'NotebookRead':
    case 'LS':
    case 'Grep':
    case 'Glob':
    case 'WebFetch':
    case 'WebSearch':
    case 'ToolSearch':
      return 'research';
    case 'Bash':
    case 'Shell':
    case 'BashOutput':
    case 'KillShell':
    case 'KillBash':
      return 'run';
    case 'Task':
    case 'Agent':
      return 'agent';
    case 'TodoWrite':
    case 'Plan':
    case 'ExitPlanMode':
      return 'plan';
    default:
      return 'other';
  }
}

const WORK_KIND_ORDER: WorkKind[] = ['edit', 'run', 'agent', 'research', 'plan', 'other'];

interface Tally {
  /** The kinds of work in the group, in the order the agent first did them. */
  order: WorkKind[];
  counts: Map<WorkKind, number>;
  reads: Set<string>;
  edits: Set<string>;
  searches: number;
  webSearches: number;
  runs: number;
  agents: number;
  plans: number;
  others: number;
  messages: number;
  statuses: number;
}

const READS = new Set(['Read', 'NotebookRead']);
const WEB = new Set(['WebFetch', 'WebSearch']);

function tallySteps(steps: Entry[]): Tally {
  const tally: Tally = {
    order: [], counts: new Map(), reads: new Set(), edits: new Set(),
    searches: 0, webSearches: 0, runs: 0, agents: 0, plans: 0, others: 0, messages: 0, statuses: 0,
  };
  for (const entry of steps) {
    if (entry.kind === 'peer') { tally.messages += 1; continue; }
    if (entry.kind === 'system') { tally.statuses += 1; continue; }
    const tool = entry.tool;
    if (entry.kind !== 'tool' || !tool) continue;
    const kind = toolCategory(tool);
    if (!tally.order.includes(kind)) tally.order.push(kind);
    tally.counts.set(kind, (tally.counts.get(kind) ?? 0) + 1);
    const target = tool.summary || entry.id;
    switch (kind) {
      case 'edit':
        // Codex reports one edit across several files as "a.ts, b.ts".
        for (const path of target.split(', ')) tally.edits.add(path);
        break;
      case 'research':
        if (READS.has(tool.name)) tally.reads.add(target);
        else {
          tally.searches += 1;
          if (WEB.has(tool.name)) tally.webSearches += 1;
        }
        break;
      case 'run': tally.runs += 1; break;
      case 'agent': tally.agents += 1; break;
      case 'plan': tally.plans += 1; break;
      default: tally.others += 1;
    }
  }
  return tally;
}

function leafName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function fileLabel(paths: Set<string>): string {
  const [first] = paths;
  if (paths.size === 1 && first) return leafName(first) || first;
  return `${paths.size} files`;
}

function counted(n: number, live: boolean, verb: [string, string], one: string, many: string): string {
  return n === 1 ? `${live ? verb[0] : verb[1]} ${one}` : `${live ? verb[0] : verb[1]} ${n} ${many}`;
}

/** What the calls of one kind add up to: "Edited 2 files", "Ran 3 commands". */
function workSummary(kind: WorkKind, tally: Tally, live: boolean): string {
  switch (kind) {
    case 'edit':
      return `${live ? 'Editing' : 'Edited'} ${fileLabel(tally.edits)}`;
    case 'research':
      if (tally.reads.size > 0 && tally.searches === 0) return `${live ? 'Reading' : 'Read'} ${fileLabel(tally.reads)}`;
      if (tally.reads.size === 0 && tally.searches === tally.webSearches) return live ? 'Searching the web' : 'Searched the web';
      if (tally.reads.size === 0) return live ? 'Searching the project' : 'Searched the project';
      return live ? 'Exploring the project' : 'Explored the project';
    case 'run':
      return counted(tally.runs, live, ['Running', 'Ran'], 'a command', 'commands');
    case 'agent':
      return counted(tally.agents, live, ['Running', 'Ran'], 'a subagent', 'subagents');
    case 'plan':
      return live ? 'Updating the plan' : 'Updated the plan';
    default:
      return counted(tally.others, live, ['Running', 'Ran'], 'a tool', 'tools');
  }
}

/** The kind of work the group is in the middle of: its most recent call. */
function currentWorkKind(steps: Entry[]): WorkKind | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const tool = steps[index].tool;
    if (steps[index].kind === 'tool' && tool) return toolCategory(tool);
  }
  return undefined;
}

/**
 * What a run of work adds up to, one clause per kind: "Read 3 files · Edited app.ts · Ran a
 * command". While the run is live, the clause for the call in flight is present tense, so "Running
 * 2 commands" settles to "Ran 2 commands" when it folds. Teammate messages ride along at the end.
 */
export function workSummaryLine(steps: Entry[], live = false): string {
  const tally = tallySteps(steps);
  const messages = tally.messages === 1 ? '1 message' : tally.messages > 1 ? `${tally.messages} messages` : '';
  if (tally.order.length === 0) {
    if (messages) return messages;
    if (tally.statuses > 0) return 'Status update';
    return live ? 'Working' : 'Worked';
  }
  const running = live ? currentWorkKind(steps) : undefined;
  return [...tally.order.map(kind => workSummary(kind, tally, kind === running)), ...(messages ? [messages] : [])].join(' · ');
}

/** The icon a run of work answers to: whatever it did most of. */
export function workKind(steps: Entry[]): PhaseKind {
  const { counts } = tallySteps(steps);
  let best: WorkKind | undefined;
  for (const kind of WORK_KIND_ORDER) {
    const count = counts.get(kind) ?? 0;
    if (count > 0 && (!best || count > (counts.get(best) ?? 0))) best = kind;
  }
  return best ?? 'note';
}
