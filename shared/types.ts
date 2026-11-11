import type { AvatarLook } from './avatar.ts';
import type { MentionHint, MentionRef } from './mentions.ts';
// Types shared by the server (Node, type-stripped) and the web client (Vite).
// Keep this file to erasable syntax only (no enums, namespaces or parameter
// properties) so Node can run it with plain type stripping.

export type EngineKind = 'claude' | 'codex' | 'orcacode';
export const ENGINES: EngineKind[] = ['claude', 'codex', 'orcacode'];
export const ENGINE_LABELS: Record<EngineKind, string> = { claude: 'Claude Code', codex: 'Codex', orcacode: 'OrcaCode' };

/** What an agent is for. Only a lead may delegate structured tasks to teammates. */
/** super: the one SuperAgent, which runs the team for the user and never edits (server/superAgent.ts). */
export type AgentRole = 'dev' | 'lead' | 'reviewer' | 'tester' | 'planner' | 'scout' | 'custom' | 'super';

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
  /** system: Podcode itself, such as the SuperAgent's wake-up updates; never the user's words. */
  source: 'user' | 'agent' | 'system';
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
  /** How it looks in the app (shared/avatar.ts); absent, it comes from the id. */
  avatar?: AvatarLook;
  /**
   * The projects it works on (shared/agentProjects.ts): null for every registered project, else the
   * chosen ones in order, the first being its start folder, where its sessions run and its worktree
   * (if any) is made. The others are used in place. Stored agents with the old projectId are
   * migrated on load: an id becomes [id], null stays null.
   */
  projectIds: string[] | null;
  worktree: Worktree | null;
  /**
   * The agent's private folder, <dataDir>/agents/<id>/: soul.md (standing instructions) and
   * memory.md (what it learned). An agent with no project also works from here.
   */
  home: string;
  model: string; // '' means the CLI default
  effort: string; // reasoning effort; '' means the CLI default
  /** A service tier the model offers (Codex `priority`, Claude `fast`); '' or absent is Standard. */
  serviceTier?: string;
  autonomy: Autonomy;
  useMcp: boolean; // Claude only: load the user's own MCP servers
  role: AgentRole;
  /** Standing instructions, mirrored from home/soul.md, which is the source of truth (up to 8000 characters). */
  instructions: string;
  /**
   * Whether the agent dreams: after a session (a new session, or the idle close) it reviews what
   * happened and updates its memory, and may propose a soul.md change. On by default; off means no
   * dream runs, not even Dream now.
   */
  dreaming: boolean;
  status: AgentStatus;
  activity: string; // a few words on what it is doing right now
  currentTask: AgentTask | null;
  sessionId: string | null; // Claude session id or Codex thread id
  /** The folder the current session started in. Claude Code keeps a session per folder, so it cannot resume from another. */
  sessionCwd?: string;
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
  /**
   * Codex only: the thread's running token totals as of its last finished turn. Codex reports
   * totals for the whole thread, so a turn's own usage is the difference from these.
   */
  threadUsage?: { thread: string; usage: TurnUsage };
  /**
   * The codebase the agent last worked in, read from its tool calls: a project's folder or a
   * worktree of one, and the branch checked out there (null outside git). Absent until known.
   */
  workingIn?: WorkingIn;
}

export interface WorkingIn {
  /** The project the folder belongs to. */
  projectId: string;
  /** The project's checkout or the worktree the agent touched. */
  root: string;
  /** The branch checked out there, a short commit when detached, or null when not a git repository. */
  branch: string | null;
  /** When the agent last touched it. */
  at: number;
}

/** What an agent with no project (it works across all of them) shows in place of a project name. */
export const ALL_PROJECTS = 'All projects';

/**
 * Where an agent with no project works: the workspace folder inside its home, so soul.md and
 * memory.md are outside its working folder (server/agentHome.ts workspacePath).
 */
export function noProjectFolder(home: string): string {
  return `${home.replace(/\/+$/, '')}/workspace`;
}

/** One thing an agent remembered, kept in its home/memory.md. */
export interface MemoryEntry {
  id: string;
  text: string;
  /** Why it is worth remembering: the correction or confirmation behind it. */
  why?: string;
  createdAt: number;
  /** The dream that wrote (or last rewrote) this entry. Your edits and deletes of these count as reverts. */
  dreamId?: string;
}

// ---- the user profile -----------------------------------------------------------

/**
 * One thing Podcode learned about the user (their style, taste, how they like to work), kept in
 * <dataDir>/user.md and given to every agent. An agent adds one with remember scope "user", a dream
 * adds one the user stated outright, and the user adds, edits or deletes them in the app.
 */
export interface ProfileEntry {
  id: string;
  text: string;
  why?: string;
  createdAt: number;
  /** The agent that saved it; absent when the user wrote it, or it came from several agents' memories. */
  agentId?: string;
  /** Who it came from, as a name to show: an agent's name when saved, or several joined. */
  from?: string;
  /** The dream that wrote it; undoing that dream removes it. */
  dreamId?: string;
}

/**
 * Something about the user that waits for approval before it reaches user.md: a dream inferred it
 * (the user did not say it outright), or two or more agents remembered the same thing.
 */
export interface ProfileProposal {
  id: string;
  kind: 'dream' | 'promotion';
  text: string;
  why?: string;
  at: number;
  agentId?: string;
  from?: string;
  dreamId?: string;
  /** For a promotion: the memory entries it replaces. Accepting it removes them from those agents' memory. */
  sources?: { agentId: string; agentName: string; entryId: string; text: string }[];
}

export interface UserProfile {
  entries: ProfileEntry[];
  proposals: ProfileProposal[];
  /** Where user.md is on disk, for the app to show. */
  file: string;
}

/** One thing a dream learned about the user, and what came of it. Kept apart from DreamOp, which is about memory.md. */
export interface ProfileOp {
  text: string;
  why: string;
  evidence: string[];
  /** applied: in user.md now; proposed: waiting for approval; rejected: refused by the checks. */
  result: 'applied' | 'proposed' | 'rejected';
  reason?: string;
  /** The user.md entry it wrote. */
  entryId?: string;
  /** The proposal it made. */
  proposalId?: string;
}

// ---- the SuperAgent -------------------------------------------------------------

/** A question the SuperAgent put to the user, with the choices to click. */
export interface SuperAsk {
  id: string;
  question: string;
  /** Why it asks, or what the user should know first. */
  detail?: string;
  /** One to four choices; the user may also type their own answer. */
  options: string[];
  createdAt: number;
  answeredAt?: number;
  answer?: string;
  /** The user put it aside without answering. */
  dismissed?: boolean;
}

/** How to take back something the SuperAgent did on its own. */
export type SuperUndo =
  | { kind: 'removeAgent'; agentId: string }
  | { kind: 'removeChannel'; channelId: string }
  | { kind: 'channel'; channelId: string; before: { name: string; topic: string; memberIds: string[] } }
  | { kind: 'agent'; agentId: string; before: { name: string; role: AgentRole; model: string; effort: string } }
  /** A goal as it was before (null: the SuperAgent added it, so undo removes it). */
  | { kind: 'goal'; goalId: string; before: SuperGoal | null }
  /** A routine the SuperAgent proposed: undo withdraws it. */
  | { kind: 'routine'; routineId: string };

/** One thing the SuperAgent did on its own, for the decision log. */
export interface SuperAction {
  id: string;
  at: number;
  /** The command it ran: create_agent, delegate_task, ... */
  tool: string;
  /** What it did, in a line. */
  summary: string;
  /** Why, in its words: the preference or situation behind it. */
  why: string;
  undo?: SuperUndo;
  undoneAt?: number;
  /** Done for work the user asked for (a turn they gave it, or mail on such work), not on its own. */
  forUser?: boolean;
}

/** queued: waiting its turn; in_progress: an agent is on it; blocked: waiting for the user; done. */
export type GoalStatus = 'queued' | 'in_progress' | 'blocked' | 'done';

/** One goal in the SuperAgent's backlog, which it works through on its own, in order. */
export interface SuperGoal {
  id: string;
  text: string;
  /** The project it is about; null for none in particular. */
  projectId: string | null;
  status: GoalStatus;
  /** Position in the backlog, 0 first. */
  order: number;
  createdAt: number;
  updatedAt: number;
  /** Who added it. */
  by: 'user' | 'super';
  /** The agent working on it, and the delegation (peer message id) it was given. */
  agentId?: string;
  delegationId?: string;
  notes?: string;
  doneAt?: number;
}

/** When a routine runs: every day at a local time ("HH:MM"), or every N hours. */
export type RoutineSchedule = { kind: 'daily'; at: string } | { kind: 'every'; hours: number };

/**
 * Something the SuperAgent does on a schedule, in the user's words: at its time it becomes an update
 * for the SuperAgent, so every wake limit and the daily budget apply. The user adds routines; the
 * SuperAgent may only propose one, which waits until the user confirms it.
 */
export interface SuperRoutine {
  id: string;
  name: string;
  projectId: string | null;
  instruction: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  /** Proposed by the SuperAgent and not yet confirmed: it never runs until the user confirms. */
  proposed?: boolean;
  why?: string;
  by: 'user' | 'super';
  createdAt: number;
  lastRunAt?: number;
}

export interface SuperState {
  /** The SuperAgent's agent id, or null before it is set up. */
  agentId: string | null;
  /** Open asks, then the latest answered ones, newest first. */
  asks: SuperAsk[];
  /** The latest decisions, newest first. */
  log: SuperAction[];
  /** The goals backlog, in order. */
  goals: SuperGoal[];
  /** Scheduled routines, oldest first. */
  routines: SuperRoutine[];
  /** Mail to the SuperAgent waiting until it may take a turn, and why; null when none waits. */
  held?: { count: number; reason: string } | null;
}

// ---- dreaming -----------------------------------------------------------------

export type DreamReason = 'session-end' | 'idle' | 'manual';
export type DreamOpKind = 'add' | 'update' | 'merge' | 'remove';

/** One memory change a dream asked for, and what came of it. */
export interface DreamOp {
  op: DreamOpKind;
  /** The memory entries it changes: one for update or remove, two or more for merge, none for add. */
  ids: string[];
  text?: string;
  why: string;
  /** Digest item ids (d1, d2, ...) it cites. */
  evidence: string[];
  result: 'applied' | 'rejected';
  /** Why it was rejected, or a note on how it applied. */
  reason?: string;
  /** The entry it wrote (add, update, merge). */
  entryId?: string;
}

export interface DreamMetrics {
  /** Items in the digest the dream read. */
  digestItems: number;
  /**
   * User corrections in the digest, as the dream judged them: the user redirected the agent, or told
   * it something memory already said. First-time teaching is not counted.
   */
  corrections: number;
  /** Of those, the ones an existing memory entry should have prevented (it was saved before the correction). */
  repeatCorrections: number;
  /** Failed or stopped turns since the last dream. */
  failedTurns: number;
  /** Turns since the last dream. */
  turns: number;
  tokens?: number;
  costUsd?: number;
  durationMs: number;
  /** Size of memory.md after the dream. */
  memoryChars?: number;
}

export interface DreamRecord {
  id: string;
  agentId: string;
  at: number;
  reason: DreamReason;
  /** nothing: the dream ran and changed nothing; rolled-back: its changes were put back by the checks. */
  status: 'applied' | 'rolled-back' | 'nothing' | 'failed';
  error?: string;
  ops: DreamOp[];
  soul?: { status: 'pending' | 'accepted' | 'rejected' | 'invalid'; why: string };
  /** What it learned about the user, for user.md. */
  profile?: ProfileOp[];
  /** The dream's own note on the session, 3 to 6 lines. */
  diary: string;
  metrics: DreamMetrics;
  undoneAt?: number;
}

/** A soul.md change a dream proposed, waiting for you to accept or reject it. */
export interface SoulProposal {
  text: string;
  why: string;
  at: number;
  dreamId?: string;
  /** Digest item ids it cites. */
  evidence?: string[];
  /** soul.md as it is now, read from the file (not the agent's copy, which lags hand edits): what the diff is against. */
  current?: string;
  /** soul.md changed since the proposal was made, so Accept is refused; reject it instead. */
  stale?: boolean;
}

/**
 * Whether dreaming helps, for one agent or a group. Ratios are null until there is something to
 * divide by. The per-session series are counted from transcripts by code, the same way for agents
 * with dreaming on and off, so the two groups compare; a session ends at a new session or after an
 * hour without activity. repeatCorrectionRate needs a dream to judge corrections, so agents with
 * dreaming off have none (compare them with the offline eval instead).
 */
export interface DreamStats {
  dreams: number;
  /** Ops applied in dreams whose changes stayed (not rolled back). */
  opsApplied: number;
  opsRejected: number;
  /** Ops that applied in a dream that was then rolled back, so they did not stay. */
  opsRolledBack: number;
  /** Rejected ops by reason. */
  rejectedByReason: Record<string, number>;
  rollbacks: number;
  /** Entries dreams wrote, in dreams that were not rolled back. */
  dreamEntries: number;
  /** Of those, the ones you later edited, deleted or undid within 7 days. */
  dreamEntriesReverted: number;
  revertRate: number | null;
  soulAccepted: number;
  soulRejected: number;
  soulAcceptanceRate: number | null;
  /** Corrections the dreams judged, and how many repeated something memory already said. */
  corrections: number;
  repeatCorrections: number;
  /** repeatCorrections / corrections. Lower is better. */
  repeatCorrectionRate: number | null;
  /**
   * Per session, oldest first (the last 30): user corrections and failed or stopped turns, counted by
   * code. For an agent, or the "on" group, only sessions that began after its first dream.
   */
  correctionsPerSession: number[];
  failedPerSession: number[];
  sessions: number;
  avgCorrectionsPerSession: number | null;
  avgFailedPerSession: number | null;
  /** memory.md size after each dream, oldest first. */
  memoryChars: number[];
  costUsd: number;
  tokens: number;
  durationMs: number;
}

/** GET /api/agents/:id/dreams */
export interface AgentDreams {
  /** Newest first, at most 100. */
  dreams: DreamRecord[];
  stats: DreamStats;
  proposal: SoulProposal | null;
}

/** GET /api/dream-stats: each agent, and agents with dreaming on and off as groups to compare. */
export interface DreamStatsReport {
  agents: Record<string, DreamStats>;
  dreamingOn: DreamStats;
  dreamingOff: DreamStats;
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

/**
 * The tokens one turn spent (MonoCode's TurnMetrics). Unlike ContextUsage this is a total for
 * the turn, summed over its requests. `inputTokens` is fresh prompt input only, without cache
 * reads or writes, for both engines. Helpers are in shared/turnUsage.ts.
 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What a finished turn cost, on its done or error entry and on its channel reply. */
export interface TurnMeta {
  costUsd?: number;
  durationMs?: number;
  tokens?: number;
  /** Absent on turns from before it was recorded, and when the engine did not say. */
  usage?: TurnUsage;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  exists: boolean;
  isGit: boolean;
  /** Short permanent code for its notes and decisions (ACH in ACH-D7); assigned once, kept on rename. */
  code?: string;
}

// ---- agent-to-agent communication -------------------------------------------

export type DelegationKind = 'implementation' | 'testing' | 'validation' | 'review';

export interface Delegation {
  kind: DelegationKind;
  task: string;
  acceptanceCriteria: string;
  context?: string;
  /** The project code the work is about (ACH), when the lead named one; lessons from it are filed there. */
  project?: string;
}

export interface Report {
  outcome: 'passed' | 'failed' | 'blocked' | 'done';
  summary: string;
  evidence: string;
  /** A reusable lesson the agent saved with the report, as a project note. */
  lesson?: { id: string; text: string };
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
  /** It was being handled when Podcode restarted, so it is delivered once more; the recipient may have started on it. */
  redelivered?: boolean;
}

/** A chain of peer messages started by one task. All its messages share one budget. */
export interface Conversation {
  id: string;
  startedBy: string; // agent id of the first sender
  messageLimit: number; // 0 means unlimited
  stopped: boolean;
  createdAt: number;
  /**
   * Started by the SuperAgent in a turn the user gave it (or from mail in such a conversation): work
   * the user asked for, whose mail never waits on the SuperAgent's wake-up limits.
   */
  userStarted?: boolean;
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
  meta?: TurnMeta;
  /** Images the user attached; stored per channel, under /api/channels/:id/attachments/. */
  images?: ImageAttachment[];
  /** What a user post @mentioned, resolved when posted (shared/mentions.ts), for its chips. */
  mentions?: MentionRef[];
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
  source: 'user' | 'agent' | 'system';
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
  meta?: TurnMeta;
  /** The channel a user prompt was posted in. */
  channel?: { id: string; postId: string };
  /** Marks a user-started fresh session. */
  sessionStart?: boolean;
  /** Images the user attached to this message. */
  images?: ImageAttachment[];
  /** What the user's message @mentioned, resolved when sent (shared/mentions.ts), for its chips. */
  mentions?: MentionRef[];
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
  /** Let agents run their own JavaScript in browser tabs (browser_eval). Off by default. */
  browserEval: boolean;
  /** Wake the SuperAgent when agents finish, fail, get stuck or wait for the user. */
  superWake: boolean;
  /** The most wake-ups an hour; past it, updates wait for the next hour. */
  superMaxWakesPerHour: number;
  /** Quiet hours, "HH:MM" local time: no wake-ups and no notifications in between. Equal times mean none. */
  superQuietFrom: string;
  superQuietTo: string;
  /** Desktop notifications when the SuperAgent asks something. */
  superNotify: boolean;
  /** Dollars the SuperAgent may spend a day before wake-ups wait for tomorrow; 0 means no cap. Your own messages always go. */
  superDailyBudgetUsd: number;
  /** Agents the SuperAgent may create in a day. */
  superMaxCreatesPerDay: number;
}

export const DEFAULT_SETTINGS: Settings = {
  messageLimit: DEFAULT_MESSAGE_LIMIT,
  awareness: 'all',
  shareActivity: true,
  autoTeamContext: true,
  browserEval: false,
  superWake: true,
  superMaxWakesPerHour: 6,
  superQuietFrom: '22:00',
  superQuietTo: '08:00',
  superNotify: true,
  superDailyBudgetUsd: 10,
  superMaxCreatesPerDay: 25,
};

export interface ModelOption {
  value: string;
  label: string;
  description: string;
  efforts: string[]; // supported reasoning efforts, empty if unknown
  /** Where the model comes from, for engines with several providers (OrcaCode); pickers group by it. */
  group?: string;
  /** Faster (or cheaper) tiers the model offers beyond Standard. */
  serviceTiers?: ServiceTier[];
}

export interface ServiceTier {
  /** What the engine is sent: Codex's catalog id (`priority`), or `fast` for Claude's fast mode. */
  id: string;
  name: string;
  description?: string;
}

/** One of an engine's model providers (OrcaCode): set up means it has a key, a login or needs none. */
export interface ModelProvider {
  id: string;
  name: string;
  configured: boolean;
  /** Set up, but its model list could not be fetched: why, in a few words. */
  problem?: string;
}

export interface EngineModels {
  /** What "Default" resolves to, e.g. "Opus 5.5" (from the CLI config or account). */
  defaultLabel: string;
  defaultEffort: string | null;
  models: ModelOption[];
  efforts: string[]; // every effort any model supports
  discovered: boolean; // false while loading or if the CLI could not be asked
  /** Every provider the engine knows, set up or not (OrcaCode only). */
  providers?: ModelProvider[];
}

export interface EngineInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  /** OrcaCode only: this binary takes --add-dir, so an agent with no project can reach every project. */
  addDir?: boolean;
}

/** One subscription limit window of an engine's account: its 5-hour limit, say, or its weekly one. */
export interface UsageWindow {
  usedPercent: number;
  /** The window's length: 300 for five hours, 10080 for a week. */
  minutes: number;
  /** When it resets, epoch ms. */
  resetsAt?: number;
  /**
   * The model this limit counts alone, as the service names it ("Opus", "Fable",
   * "GPT-5.3-Codex-Spark"); unset for a limit every model counts against.
   */
  model?: string;
}

/** An engine's subscription usage, as the footer shows it. Read from the CLI's own login; no credentials leave the server. */
export interface EngineUsage {
  windows: UsageWindow[];
  /** When the windows were read, epoch ms. */
  updatedAt?: number;
  /** Why the latest read failed. Windows still listed are from the read before it. */
  error?: string;
  /** Signed out, or the account has no subscription usage: nothing to show until that changes. */
  unavailable?: boolean;
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
  /** What Podcode knows about the user (user.md), and what waits for approval. */
  profile: UserProfile;
  /** The SuperAgent: which agent it is, what it asks the user, and what it did. */
  super: SuperState;
}

/**
 * A shell in the bottom terminal panel. It runs on the server in its project's folder and lives
 * until it exits, is closed, its project is removed or Podcode stops; reloading the page
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
  /** An agent's memory changed: every entry, oldest first. */
  | { type: 'memory'; agentId: string; entries: MemoryEntry[] }
  /** A dream finished, or its record changed (undone, soul accepted or rejected). */
  | { type: 'dream'; agentId: string; dream: DreamRecord }
  /** A soul proposal is waiting, or (null) none is any more. */
  | { type: 'soulProposal'; agentId: string; proposal: SoulProposal | null }
  /** user.md or its waiting proposals changed. */
  | { type: 'profile'; profile: UserProfile }
  /** The SuperAgent's asks or decision log changed, or it was set up. */
  | { type: 'super'; super: SuperState }
  | { type: 'project'; project: Project }
  | { type: 'projectRemoved'; id: string }
  | { type: 'entry'; entry: Entry }
  /** A note or decision was added (server/projectRefs.ts); the Notes tab and id chips read them again. */
  | { type: 'refs' }
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
  /**
   * null creates an agent with no project, working across every project; it cannot have a worktree.
   * A list chooses projects, the first being its start folder (the worktree's, with worktree).
   */
  projectIds?: string[] | null;
  /** The older single-project form: an id is [id]. Used when projectIds is absent. */
  projectId?: string | null;
  model?: string;
  effort?: string;
  autonomy?: Autonomy;
  useMcp?: boolean;
  role?: AgentRole;
  instructions?: string;
  /** The look picked in the new-agent dialog; absent, a free one (shared/avatar.ts). */
  avatar?: AvatarLook;
  worktree?: boolean;
  branch?: string;
  task?: string;
  /** For the first task: which agent or project the user picked where two share a name. */
  mentionHints?: MentionHint[];
}

export interface AgentPatch {
  name?: string;
  autonomy?: Autonomy;
  model?: string;
  effort?: string;
  /** '' is Standard. */
  serviceTier?: string;
  role?: AgentRole;
  /** Rewrites the agent's soul.md. */
  instructions?: string;
  dreaming?: boolean;
  /** Its avatar's shape, colour and eyes (shared/avatar.ts). */
  avatar?: AvatarLook;
  /** Its projects: null for all, else the chosen ones with the start folder first (shared/agentProjects.ts). */
  projectIds?: string[] | null;
}

/** A change to one memory entry from the app. */
export interface MemoryPatch {
  text: string;
  why?: string;
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

// ---- walkthroughs ---------------------------------------------------------------

export type WalkthroughStepKind = 'note' | 'code' | 'diff' | 'command' | 'image' | 'diagram';

/** Where a step's file can be opened again: an agent's workspace or a project folder (the web's Root). */
export type WalkthroughRoot = { agent: string } | { project: string };

/**
 * One stop on a walkthrough. Code and diff steps keep what the file looked like when the walkthrough
 * was made, so the tour still reads after later edits; the viewer compares it with the file today.
 */
export interface WalkthroughStep {
  kind: WalkthroughStepKind;
  title: string;
  /** Markdown: what to notice here and why. */
  body: string;
  /** code and diff: the file, relative to `root`. */
  path?: string;
  root?: WalkthroughRoot | null;
  startLine?: number;
  endLine?: number;
  /** code: the lines as they were; diff: the diff as it was. */
  excerpt?: string;
  /** command: what ran and what it printed, as the agent reported them. */
  command?: string;
  output?: string;
  /** diagram: Mermaid source (flowchart, sequenceDiagram, architecture-beta, classDiagram, erDiagram, ...). */
  source?: string;
  /** image: a file in the walkthrough's folder. */
  image?: { file: string; mediaType: ImageMediaType };
}

/** A walkthrough as lists show it. */
export interface WalkthroughSummary {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  summary: string;
  stepCount: number;
  createdAt: number;
  /** The project and branch it covers, and the commit checked out when it was made. */
  projectId: string | null;
  branch: string | null;
  commit: string | null;
}

/** A narrated tour of work an agent did, made when the user asks. Kept in the agent's folder. */
export interface Walkthrough extends WalkthroughSummary {
  steps: WalkthroughStep[];
}
