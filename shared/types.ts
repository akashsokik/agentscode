// Types shared by the server (Node, type-stripped) and the web client (Vite).
// Keep this file to erasable syntax only (no enums, namespaces or parameter
// properties) so Node can run it with plain type stripping.

export type EngineKind = 'claude' | 'codex';

/** What an agent is for. Only a lead may delegate structured tasks to teammates. */
export type AgentRole = 'dev' | 'lead' | 'reviewer' | 'tester' | 'planner' | 'scout' | 'custom';

/**
 * How much an agent may do without asking.
 * - readonly: Claude plan mode / Codex read-only sandbox
 * - ask:      Claude asks before edits and commands / Codex workspace-write sandbox
 * - edits:    Claude auto-accepts file edits, asks for commands / Codex workspace-write sandbox
 * - full:     no approvals (Claude bypassPermissions / Codex danger-full-access)
 */
export type Autonomy = 'readonly' | 'ask' | 'edits' | 'full';

export type AgentStatus =
  | 'idle' // nothing running
  | 'working' // running a turn
  | 'waiting' // blocked on the user (approval, question or plan review)
  | 'done' // finished the last turn
  | 'error'; // the last turn failed

/** A separate checkout on its own branch, so an agent never collides with you or other agents. */
export interface Worktree {
  path: string; // worktree root
  cwd: string; // where the agent works: the root, or the project's subfolder inside it
  branch: string;
  base: string; // branch (or short commit) it was created from
  baseCommit: string;
  repoRoot: string; // the main checkout
  gitDir: string; // the shared .git directory
}

export type WorktreeCleanup = 'keep' | 'remove' | 'discard';

export interface AgentTask {
  summary: string;
  source: 'user' | 'agent';
  fromAgentId?: string;
  /** The peer message this turn handles, when source is 'agent'. */
  messageId?: string;
  /** The transcript entry holding the user's message, when source is 'user'. */
  entryId?: string;
  /** The channel post this turn answers, and its channel; the final reply is posted back there. */
  channelPostId?: string;
  channelId?: string;
}

export interface Agent {
  id: string;
  name: string;
  engine: EngineKind;
  projectId: string;
  worktree: Worktree | null;
  model: string; // '' means the CLI default
  effort: string; // reasoning effort; '' means the CLI default
  autonomy: Autonomy;
  useMcp: boolean; // Claude only: load the user's own MCP servers
  role: AgentRole;
  instructions: string; // standing instructions appended to the system prompt
  status: AgentStatus;
  activity: string; // a few words on what it is doing right now
  currentTask: AgentTask | null;
  sessionId: string | null; // Claude session id or Codex thread id
  createdAt: number;
  lastActiveAt: number;
  turnStartedAt: number | null;
  unread: boolean; // finished or received something the user has not looked at yet
  costUsd: number;
  tokens: number;
  turns: number;
  queued: number; // user and peer messages waiting behind the current turn
  lastSummary: string;
  error: string | null;
  /** How full the model's context window is, from the last request. Absent until the engine reports it. */
  context?: ContextUsage;
}

/**
 * The context window as of the last request: a level, not a running total, so each reading
 * replaces the one before (MonoCode's ContextUsage). Helpers are in shared/contextUsage.ts.
 */
export interface ContextUsage {
  /** Tokens in the context window as of the last request. */
  used: number;
  /** The active model's context window, once the engine has reported it. */
  window?: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  exists: boolean;
  isGit: boolean;
}

// ---- agent-to-agent communication -------------------------------------------

export type DelegationKind = 'implementation' | 'testing' | 'validation' | 'review';

export interface Delegation {
  kind: DelegationKind;
  task: string;
  acceptanceCriteria: string;
  context?: string;
}

export interface Report {
  outcome: 'passed' | 'failed' | 'blocked' | 'done';
  summary: string;
  evidence: string;
}

export type PeerMessageStatus = 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled';

/** One message between two agents. Delivery runs it as a turn in the recipient's session. */
export interface PeerMessage {
  id: string;
  conversationId: string;
  replyTo?: string;
  fromAgentId: string;
  fromName: string;
  toAgentId: string;
  toName: string;
  text: string;
  expectsReply: boolean;
  ts: number;
  status: PeerMessageStatus;
  error?: string;
  delegation?: Delegation;
  report?: Report;
  /** Set when an agent mentioned the recipient in a channel post (postId), or answered one. */
  channelId?: string;
  postId?: string;
}

/** A chain of peer messages started by one task. All its messages share one budget. */
export interface Conversation {
  id: string;
  startedBy: string; // agent id of the first sender
  messageLimit: number; // 0 means unlimited
  stopped: boolean;
  createdAt: number;
}

export const DEFAULT_MESSAGE_LIMIT = 12;

// ---- channels ---------------------------------------------------------------

/**
 * A named room where the user and invited agents, from any project, work together.
 * Membership is the user's explicit opt-in, so it lets members reach each other
 * whatever the awareness setting says.
 */
export interface Channel {
  id: string;
  name: string; // lowercase slug, shown as #name
  topic: string;
  memberIds: string[]; // agents; the user is always in every channel
  createdAt: number;
  lastPostAt: number;
  unread: boolean; // an agent posted since the user last looked
}

export type ChannelDeliveryStatus = 'queued' | 'working' | 'replied' | 'failed' | 'stopped';

/** One member a post started a turn for, and how far that turn got. */
export interface ChannelDelivery {
  agentId: string;
  name: string;
  status: ChannelDeliveryStatus;
  error?: string;
}

/**
 * One post. A user post starts a turn for each mentioned member; an agent post starts
 * one for each member it names in mention_agent_ids. Posts without mentions start nothing.
 * Final replies, problems and approval requests from those turns come back as posts.
 */
export interface ChannelPost {
  id: string;
  channelId: string;
  ts: number;
  from: 'user' | 'agent' | 'system';
  agentId?: string; // the author, for agent posts
  fromName: string;
  kind: 'post' | 'reply' | 'error' | 'needs_you' | 'event';
  text: string;
  to: ChannelDelivery[];
  inReplyTo?: string;
  /** The top-level post this thread belongs to; absent on top-level posts. */
  threadId?: string;
  meta?: { costUsd?: number; durationMs?: number; tokens?: number };
}

export interface ChannelInput {
  name?: string;
  topic?: string;
  memberIds?: string[];
}

// ---- transcripts ------------------------------------------------------------

export interface ToolCall {
  name: string;
  summary: string;
  detail?: string;
  output?: string;
  status: 'running' | 'ok' | 'error';
}

export type EntryKind = 'user' | 'agent' | 'tool' | 'system' | 'done' | 'error' | 'peer' | 'turn';

/**
 * Written when a turn actually starts. Prompts are written when they are sent, so a message
 * queued behind a running turn lands inside it; the marker says which prompt this turn runs.
 */
export interface TurnMarker {
  source: 'user' | 'agent';
  /** The user entry this turn answers. */
  entryId?: string;
  /** The peer message this turn handles; its entry id is `peer:<messageId>`. */
  messageId?: string;
}

export interface Entry {
  id: string;
  agentId: string;
  ts: number;
  kind: EntryKind;
  text: string;
  tool?: ToolCall;
  peer?: PeerMessage;
  turn?: TurnMarker;
  meta?: { costUsd?: number; durationMs?: number; tokens?: number };
  /** The channel a user prompt was posted in. */
  channel?: { id: string; postId: string };
  /** Marks a user-started fresh session. */
  sessionStart?: boolean;
  /** Images the user attached to this message. */
  images?: ImageAttachment[];
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** An image attached to a user message. The bytes live in the data folder, one folder per agent. */
export interface ImageAttachment {
  /** The stored file name, `<uuid>.<ext>`; also its address under /api/agents/:id/attachments/. */
  id: string;
  /** What the user called it, for alt text and titles. */
  name: string;
  mediaType: ImageMediaType;
  size: number;
}

// ---- approvals --------------------------------------------------------------

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface Approval {
  id: string;
  agentId: string;
  createdAt: number;
  type: 'tool' | 'question' | 'plan';
  toolName: string;
  title: string;
  detail: string;
  description: string;
  canAlwaysAllow: boolean;
  questions?: Question[];
  plan?: string;
}

export interface ApprovalDecision {
  allow: boolean;
  always?: boolean;
  message?: string;
  answers?: Record<string, string>;
}

// ---- settings, engines and models ------------------------------------------

export interface Settings {
  /** Messages per collaboration chain; 0 means unlimited. */
  messageLimit: number;
  /** Which teammates an agent can see and message. */
  awareness: 'off' | 'project' | 'all';
  /** Share each agent's current task and activity with teammates. */
  shareActivity: boolean;
  /** Prefix each task with a snapshot of teammates. */
  autoTeamContext: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  messageLimit: DEFAULT_MESSAGE_LIMIT,
  awareness: 'all',
  shareActivity: true,
  autoTeamContext: true,
};

export interface ModelOption {
  value: string;
  label: string;
  description: string;
  efforts: string[]; // supported reasoning efforts, empty if unknown
}

export interface EngineModels {
  /** What "Default" resolves to, e.g. "Opus 5.5" (from the CLI config or account). */
  defaultLabel: string;
  defaultEffort: string | null;
  models: ModelOption[];
  efforts: string[]; // every effort any model supports
  discovered: boolean; // false while loading or if the CLI could not be asked
}

export interface EngineInfo {
  available: boolean;
  path: string | null;
  version: string | null;
}

export interface Snapshot {
  agents: Agent[];
  projects: Project[];
  approvals: Approval[];
  messages: PeerMessage[];
  conversations: Conversation[];
  channels: Channel[];
  settings: Settings;
  engines: Record<EngineKind, EngineInfo>;
  models: Record<EngineKind, EngineModels>;
  home: string;
  platform: string;
}

/**
 * A shell in the bottom terminal panel. It runs on the server in its project's folder and lives
 * until it exits, is closed, its project is removed or AgentsCode stops; reloading the page
 * reattaches to it. Its bytes travel on its own socket, /ws/terminal/<id>, never on the event feed.
 */
export interface TerminalInfo {
  id: string;
  projectId: string;
  /** The folder the shell started in: the project's path. */
  cwd: string;
  /** The shell's name, such as "zsh". */
  shell: string;
  createdAt: number;
}

/**
 * The terminal socket's control messages, as JSON text frames. Terminal bytes go as binary
 * frames both ways: keystrokes to the shell, output to the page (the buffered output first).
 */
export type TerminalClientMessage = { type: 'resize'; cols: number; rows: number };
export type TerminalServerMessage = { type: 'exit'; exitCode: number; signal?: number };

export type ServerEvent =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'agent'; agent: Agent }
  | { type: 'agentRemoved'; id: string }
  | { type: 'project'; project: Project }
  | { type: 'projectRemoved'; id: string }
  | { type: 'entry'; entry: Entry }
  | { type: 'message'; message: PeerMessage }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'channel'; channel: Channel }
  | { type: 'channelRemoved'; id: string }
  | { type: 'post'; post: ChannelPost }
  | { type: 'approval'; approval: Approval }
  | { type: 'approvalResolved'; id: string; agentId: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'models'; models: Record<EngineKind, EngineModels> }
  /** Every open terminal, sent on connect and whenever one opens or ends. */
  | { type: 'terminals'; terminals: TerminalInfo[] };

// ---- requests ---------------------------------------------------------------

export interface CreateAgentRequest {
  name: string;
  engine: EngineKind;
  projectId: string;
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  useMcp?: boolean;
  role?: AgentRole;
  instructions?: string;
  worktree?: boolean;
  branch?: string;
  task?: string;
}

export interface AgentPatch {
  name?: string;
  autonomy?: Autonomy;
  model?: string;
  effort?: string;
  role?: AgentRole;
  instructions?: string;
}

// ---- files and git ----------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  isProject: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

export interface TreeEntry {
  name: string;
  path: string; // relative to the root
  dir: boolean;
}

export interface TreeListing {
  root: string;
  path: string;
  entries: TreeEntry[];
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string;
}

export interface ChangedFile {
  path: string;
  status: string; // porcelain code: M, A, D, R, ?? ...
  added: number;
  removed: number;
}

export interface GitStatus {
  root: string;
  isRepo: boolean;
  branch: string | null;
  files: ChangedFile[];
  added: number;
  removed: number;
  /** Commits on an agent's worktree branch since it was created. */
  commits: number | null;
}

export interface FileDiff {
  path: string;
  status: string;
  diff: string;
}

export const MAX_AGENTS = 24;
