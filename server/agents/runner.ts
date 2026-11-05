import type { Agent, AgentTask, ApprovalDecision, Autonomy, Entry, ImageMediaType, Project, Question, TurnUsage } from '../../shared/types.ts';
import { roleInstructions } from '../../shared/roles.ts';
import { COMMS_INSTRUCTIONS } from '../comms/tools.ts';

export interface TurnResult {
  ok: boolean;
  stopped?: boolean;
  summary: string;
  error?: string;
  costUsd?: number;
  tokens?: number;
  /** What this turn alone spent, when the engine said. */
  usage?: TurnUsage;
  /** Codex: the thread's new running totals, kept on the agent to work out the next turn's usage. */
  threadUsage?: { thread: string; usage: TurnUsage };
  /** User messages still queued behind this turn; the agent keeps working when > 0. */
  pending?: number;
}

export interface ApprovalRequest {
  type: 'tool' | 'question' | 'plan';
  toolName: string;
  title: string;
  detail: string;
  description: string;
  canAlwaysAllow: boolean;
  questions?: Question[];
  plan?: string;
}

export type EntryDraft = Omit<Entry, 'agentId' | 'ts'> & { ts?: number };

/** An image the user attached, as a stored file the engine reads when the turn starts. */
export interface RunnerImage {
  path: string;
  mediaType: ImageMediaType;
}

export interface RunnerInput {
  text: string;
  task?: AgentTask;
  images?: RunnerImage[];
}

/** Callbacks a runner uses to report back to the AgentManager. */
export interface RunnerHooks {
  session(id: string): void;
  entry(entry: EntryDraft): void;
  activity(text: string): void;
  turnStart(task?: AgentTask): void;
  turnEnd(result: TurnResult): void;
  ready?(): void;
  /**
   * A context window reading: `used` is the size of the last prompt (a level, not a total),
   * `window` the model's limit. Either half may come alone; the manager keeps the other.
   */
  context?(reading: { used?: number; window?: number }): void;
  approval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /** The underlying process went away. The next send() starts a fresh one. */
  closed(error?: string): void;
}

export interface RunnerContext {
  agent: () => Agent;
  project: Project;
  /** Working directory: the agent's worktree, or the project folder. */
  cwd: string;
  binPath: string | null;
  hooks: RunnerHooks;
  /** Per-process credential for the comms MCP server; identifies the agent to the IDE. */
  commsToken?: string;
  /** Read fresh team context when a queued task actually starts. */
  preparePrompt?(text: string): string;
}

export interface Runner {
  readonly busy: boolean;
  send(text: string, task?: AgentTask, images?: RunnerImage[]): void;
  interrupt(): Promise<void>;
  setAutonomy(autonomy: Autonomy): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  close(): void;
  /** Resolves only once the underlying process/query has actually closed. */
  dispose?(): Promise<void>;
  /**
   * The slash commands and skills a running session can run, excluding the engine's own built-in
   * commands; undefined when no session is running or the engine cannot say.
   */
  commands?(): Promise<RunnerCommand[] | undefined>;
}

export interface RunnerCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export function systemInstructions(agent: Agent, project: Project): string {
  const lines = [
    `You are ${agent.name}, a coding agent in AgentsCode, an IDE where one person runs several agents side by side and the agents can message each other.`,
    `Your project is "${project.name}" at ${project.path}. Work inside that folder unless the user explicitly asks otherwise.`,
    'Keep replies short and concrete. When you finish a task, end with a one to three sentence summary of what you did and anything the user should check.',
    'Do not use emojis.',
  ];
  const wt = agent.worktree;
  if (wt) {
    lines[1] = `Your project is "${project.name}". You work in your own git worktree at ${wt.cwd}, on branch ${wt.branch} (created from ${wt.base}). Stay inside the worktree and do not switch branches; the main checkout at ${project.path} belongs to the user.`;
    lines.push('When you finish a task, commit your changes on your branch with a clear message, unless the user says otherwise.');
  }
  if (agent.instructions.trim()) lines.push(`Your standing instructions: ${agent.instructions.trim()}`);
  lines.push(COMMS_INSTRUCTIONS);
  lines.push(roleInstructions(agent.role));
  return lines.join('\n');
}
