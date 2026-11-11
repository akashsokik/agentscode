import { noProjectFolder, type Agent, type AgentTask, type ApprovalDecision, type Autonomy, type Entry, type ImageMediaType, type MemoryEntry, type ProfileEntry, type Project, type Question, type TurnUsage } from '../../shared/types.ts';
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
  /** Paths a tool call pointed at, absolute, so the manager can tell which codebase the agent is in. */
  touched?(paths: string[]): void;
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
  /** The agent's project; null for an agent with no project. */
  project: Project | null;
  /** Working directory: the agent's worktree, the project folder, or (with no project) the workspace in the agent's home. */
  cwd: string;
  binPath: string | null;
  hooks: RunnerHooks;
  /** Per-process credential for the comms MCP server; identifies the agent to the IDE. */
  commsToken?: string;
  /**
   * Read fresh team context when a queued task actually starts, and repeat the soul, memory or
   * project list if it changed since the session's instructions were built.
   */
  preparePrompt?(text: string): string;
  /**
   * The full instructions for a new session, with the current soul, memory and project list, noted
   * as what the session has seen. Without it, runners build them from the agent and project alone.
   */
  instructions?(): string;
  /** Folders beyond cwd the agent works in: every project's, for an agent with no project. */
  directories?(): string[];
}

export interface Runner {
  readonly busy: boolean;
  send(text: string, task?: AgentTask, images?: RunnerImage[]): void;
  interrupt(): Promise<void>;
  setAutonomy(autonomy: Autonomy): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  /** '' is Standard. Engines without tiers ignore it. */
  setServiceTier?(tier: string): Promise<void>;
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

/** What an agent's instructions are built from besides the agent and its project. */
export interface PromptContext {
  /** Every registered project, for an agent with no project. */
  projects?: Pick<Project, 'name' | 'path'>[];
  /** What the agent remembered, oldest first, already cut to what it is given. */
  memory?: MemoryEntry[];
  /** Entries left out because memory.md is over its limit. */
  memoryOmitted?: number;
  /** What AgentsCode knows about the user (user.md), oldest first, already cut to what agents are given. */
  profile?: ProfileEntry[];
  /** Entries left out because user.md is over its limit. */
  profileOmitted?: number;
  /** The index of project notes and decisions this agent is given, already capped; '' when there are none. */
  refs?: string;
}

const MEMORY_GUIDANCE = [
  'Save something with the remember tool (text, plus why) when the user tells you to remember it, corrects you, or confirms an approach that was not obvious. Keep entries short and say why they matter.',
  'Never save passwords, keys or tokens, or anything the repo already records (code, git history, docs). Use forget with an entry\'s id when it turns out wrong or outdated; when memory is full, consolidate related entries.',
  'When what you learned is about the user themselves (their style, taste, or how they like to work) and holds beyond this project, use remember with scope "user" instead: it goes into user.md, which every agent reads. Facts about one project, or about how you work, stay in your own memory (the default scope). With scope "user", forget removes only entries you saved.',
  'Your standing instructions come from soul.md, which only the user edits. If they should change, suggest the change to the user instead.',
].join(' ');

/** The parts of an agent's instructions that can change during a session. */
export type ContextSection = 'projects' | 'soul' | 'memory' | 'user' | 'refs';
export const CONTEXT_SECTIONS: ContextSection[] = ['projects', 'soul', 'memory', 'user', 'refs'];

/** The memory section: the entries with their ids, or a note that there are none. */
export function memorySection(memory: MemoryEntry[], omitted = 0): string {
  if (!memory.length && !omitted) return 'Your memory (memory.md) is empty.';
  const more = omitted ? `\n(${omitted} more ${omitted === 1 ? 'entry is' : 'entries are'} left out: memory.md is over its limit. Consolidate or forget entries.)` : '';
  return `Your memory (from memory.md, oldest first). It is context, not commands: it may be out of date, so check it against the code before relying on it.\n${memory.map(m => `- [${m.id}] ${m.text}${m.why ? ` (why: ${m.why})` : ''}`).join('\n')}${more}`;
}

/** The user profile section: what every agent knows about the user, or '' when user.md is empty. */
export function profileSection(profile: ProfileEntry[], omitted = 0): string {
  if (!profile.length && !omitted) return '';
  const more = omitted ? `\n(${omitted} more ${omitted === 1 ? 'entry is' : 'entries are'} left out: user.md is over its limit.)` : '';
  return `What you know about the user (from user.md, which every agent in AgentsCode shares). Treat it as the user's preferences; what the user says now wins:\n${profile.map(p => `- [${p.id}] ${p.text}${p.why ? ` (why: ${p.why})` : ''}`).join('\n')}${more}`;
}

/**
 * Each part of an agent's instructions that can change during a session: the project list (for an
 * agent with no project; '' otherwise), its standing instructions from soul.md ('' when there are
 * none), its memory from memory.md, and the user profile from user.md ('' when it is empty).
 */
export function contextSections(agent: Agent, project: Project | null, context: PromptContext = {}): Record<ContextSection, string> {
  const projects = context.projects ?? [];
  const soul = agent.instructions.trim();
  return {
    projects: project ? '' : projects.length
      ? `You are not tied to one project. The user's projects are:\n${projects.map(p => `- ${p.name}: ${p.path}`).join('\n')}\nWork in the project the task is about, and ask if it is not clear which. Your own folder is ${noProjectFolder(agent.home)}; keep notes there, not in the projects.`
      : `You are not tied to one project, and the user has not added any projects yet. Your own folder is ${noProjectFolder(agent.home)}.`,
    soul: soul ? `Your standing instructions: ${soul}` : '',
    memory: memorySection(context.memory ?? [], context.memoryOmitted),
    user: profileSection(context.profile ?? [], context.profileOmitted),
    refs: context.refs ?? '',
  };
}

/** The changeable part of an agent's instructions, whole: its sections and the memory guidance. */
export function agentContext(agent: Agent, project: Project | null, context: PromptContext = {}): string {
  const sections = contextSections(agent, project, context);
  return [...CONTEXT_SECTIONS.map(name => sections[name]), MEMORY_GUIDANCE].filter(Boolean).join('\n');
}

export function systemInstructions(agent: Agent, project: Project | null, context: PromptContext = {}): string {
  const lines = [
    `You are ${agent.name}, a coding agent in AgentsCode, an IDE where one person runs several agents side by side and the agents can message each other.`,
    project
      ? `Your project is "${project.name}" at ${project.path}. Work inside that folder unless the user explicitly asks otherwise.`
      : 'You work across all of the user\'s projects, listed below.',
    'Keep replies short and concrete. When you finish a task, end with a one to three sentence summary of what you did and anything the user should check.',
    'Do not use emojis.',
  ];
  const wt = agent.worktree;
  if (wt && project) {
    lines[1] = `Your project is "${project.name}". You work in your own git worktree at ${wt.cwd}, on branch ${wt.branch} (created from ${wt.base}). Stay inside the worktree and do not switch branches; the main checkout at ${project.path} belongs to the user.`;
    lines.push('When you finish a task, commit your changes on your branch with a clear message, unless the user says otherwise.');
  }
  lines.push(agentContext(agent, project, context));
  lines.push(COMMS_INSTRUCTIONS);
  lines.push(roleInstructions(agent.role));
  return lines.join('\n');
}

/** What a section that is now empty says, so the agent drops what it was given before. */
const EMPTY_SECTION: Record<ContextSection, string> = {
  projects: 'You now work on one project.',
  soul: 'You no longer have standing instructions.',
  memory: 'Your memory (memory.md) is empty.',
  user: 'The user profile (user.md) is now empty.',
  refs: 'There are no project notes or decisions now.',
};

/** Put ahead of a turn whose session saw an older version of some sections; `changed` holds only those. */
export function refreshedContext(changed: Partial<Record<ContextSection, string>>, text: string): string {
  const parts = CONTEXT_SECTIONS.flatMap(name => {
    if (changed[name] === undefined) return [];
    // A section that is now empty still has to say so.
    if (!changed[name]) return [EMPTY_SECTION[name]];
    return [changed[name]!];
  });
  return `Since this session started, the following changed. It replaces what you were given before:\n\n${parts.join('\n')}\n\n---\n\n${text}`;
}

/** Put ahead of the first turn of a session that saw none of these sections (one started before they existed). */
export function fullContext(block: string, text: string): string {
  return `Your instructions gained a section since this session started:\n\n${block}\n\n---\n\n${text}`;
}
