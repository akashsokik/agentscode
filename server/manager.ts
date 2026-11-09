import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Agent,
  type AgentPatch,
  type AgentTask,
  type Approval,
  type ApprovalDecision,
  type Autonomy,
  type Channel,
  type ChannelInput,
  type ChannelPost,
  type Conversation,
  type CreateAgentRequest,
  type AgentDreams,
  type DreamRecord,
  type DreamStatsReport,
  ENGINE_LABELS,
  ENGINES,
  type EngineInfo,
  type EngineKind,
  type EngineModels,
  type Entry,
  type ImageAttachment,
  type MemoryEntry,
  type MemoryPatch,
  type PeerMessage,
  type ProfileEntry,
  type Project,
  type Settings,
  type Snapshot,
  type SuperAction,
  type SuperAsk,
  type SuperGoal,
  type SuperState,
  type TurnMeta,
  type UserProfile,
  type Worktree,
  type WorktreeCleanup,
} from '../shared/types.ts';
import { ROLES, rolePreset, SUPER_PRESET } from '../shared/roles.ts';
import { engineProblem, serviceTiers } from '../shared/engines.ts';
import { isIdeCommand } from '../shared/commands.ts';
import { injectSkillPrompt, skillNamesInText, type ComposerCommand } from '../shared/composer.ts';
import { commandBody, commandsFor, type DiscoveredCommand } from './skills.ts';
import { dropContextWindow, mergeContextUsage, sameContextUsage } from '../shared/contextUsage.ts';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import { OrcacodeRunner } from './agents/orcacode.ts';
import { clip } from './agents/describe.ts';
import {
  agentContext, CONTEXT_SECTIONS, contextSections, fullContext, memorySection, profileSection, refreshedContext, systemInstructions,
  type ContextSection, type EntryDraft, type PromptContext, type Runner, type RunnerContext, type RunnerHooks, type RunnerImage, type TurnResult,
} from './agents/runner.ts';
import { AgentHomes, capMemory, MEMORY_TEXT_LIMIT, MEMORY_WHY_LIMIT, SOUL_LIMIT, workspacePath } from './agentHome.ts';
import { Attachments } from './attachments.ts';
import { ScopedRunner, type ExecutionContext } from './agents/scoped.ts';
import { Channels } from './comms/channels.ts';
import { Mailbox } from './comms/mailbox.ts';
import {
  addGoalInput, agentCommandInput, proposeRoutineInput, askUserInput, completeGoalInput, updateGoalInput, BROWSER_TOOLS, browserInputs, COMMS_TOOLS, createAgentInput, createChannelInput, readTranscriptInput, SUPER_BROWSER_TOOLS,
  SUPER_TOOLS, updateAgentInput, updateChannelInput, walkthroughInput, type BrowserTool, delegationInput, forgetInput, postInput, readChannelInput,
  rememberInput, replyInput, reportInput, sendInput, summaryInput, type CommsTool, type SuperTool,
  appScreenshotInput, EYES_TOOLS, runCheckInput, ghIssuesInput, ghPrInput, ghPrsInput, ghRunInput, ghRunsInput, hasEyes, type EyesTool,
} from './comms/tools.ts';
import { capJson, GH_UNTRUSTED, GhError, ghArgs, logTail, repoFromRemote, runGh, type Exec } from './github.ts';
import { CheckError, runCheck, type CheckExec } from './checks.ts';
import { IDLE_PROCESS_MS, PORT } from './config.ts';
import { defaultDreamEngine, Dreamer, type DreamEngine } from './dream.ts';
import { capProfile, findPromotions, ProfileStore } from './userProfile.ts';
import { scheduleText, STUCK_WAITING_MS, STUCK_WORKING_MS, SUPER_NAME, SuperStore, SuperWatcher, validQuietTime } from './superAgent.ts';
import { HttpError } from './errors.ts';
import type { Broadcaster } from './hub.ts';
import { discoverClaudeModels, discoverCodexModels, discoverOrcacodeModels, emptyModels } from './models.ts';
import { gitRun, isDirectory, isInsideGitRepo, normalizeDir } from './projects.ts';
import { locate, type Place } from './whereabouts.ts';
import { openuiGuide } from './openuiGuide.ts';
import { BrowserBridge, BROWSER_WRITE_OPS, compactConsole, type BrowserOp } from './browserBridge.ts';
import { blockedReason, normalizeAddress } from '../shared/browser.ts';
import { createWalkthrough, deleteWalkthrough, listWalkthroughs, readWalkthrough, summaryOf, walkthroughImage, walkthroughMarkdown, type StepRoot } from './walkthroughs.ts';
import type { Store } from './store.ts';
import { createWorktree, removeWorktree } from './worktrees.ts';

const AUTONOMIES: Autonomy[] = ['readonly', 'ask', 'edits', 'full'];

function validEffort(value: unknown): string {
  const effort = String(value ?? '').trim().toLowerCase();
  if (effort && !/^[a-z]{2,12}$/.test(effort)) throw new HttpError(400, 'Unknown effort level.');
  return effort;
}

function canonicalDirectory(dir: string): string {
  try {
    if (fs.statSync(dir).isDirectory()) return fs.realpathSync(dir);
  } catch { /* report a stable API error */ }
  throw new HttpError(409, `The workspace folder is missing: ${dir}.`);
}

/** Identifies one version of a section of an agent's instructions. */
function sectionKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function sectionKeys(sections: Record<ContextSection, string>): Record<ContextSection, string> {
  return Object.fromEntries(CONTEXT_SECTIONS.map(name => [name, sectionKey(sections[name])])) as Record<ContextSection, string>;
}

/** The last paragraph of a reply is the summary the agent was asked to end with. */
function summarize(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('```'));
  const last = paragraphs.at(-1) ?? '';
  return clip(last.replace(/[#*`>]+/g, '').replace(/^[-\s]+/, ''), 280);
}

interface PendingApproval {
  approval: Approval;
  finish: (decision: ApprovalDecision) => void;
  /** Remove the card without logging a decision (the process that asked is gone). */
  drop: () => void;
}

export interface ManagerOptions {
  createRunner?: (ctx: RunnerContext) => Runner;
  worktreesRoot?: string;
  /** The model call a dream makes; tests pass a fake. Defaults to each agent's own CLI. */
  dreamEngine?: DreamEngine;
  /** How long an idle agent's process stays open (and when the idle dream may run). */
  idleProcessMs?: number;
  /** The bridge to the desktop app's browser; tests pass one wired to a fake. */
  browser?: BrowserBridge;
  /** How gh runs (tests pass a fake), and how a project's git remote is read. */
  ghExec?: Exec;
  gitRemote?: (projectPath: string) => Promise<string | null>;
  /** How run_check runs its commands; tests pass a fake. */
  checkExec?: CheckExec;
}

/** Longest model id kept; OrcaCode's `provider::vendor/model:variant` ids run long. */
const MODEL_MAX = 200;

/** The runner for an agent's engine. */
function createEngineRunner(ctx: RunnerContext): Runner {
  const engine = ctx.agent().engine;
  if (engine === 'claude') return new ClaudeRunner(ctx);
  if (engine === 'orcacode') return new OrcacodeRunner(ctx);
  return new CodexRunner(ctx);
}

/** Owns agents, projects and the runners behind them; every change is persisted and broadcast. */
export class AgentManager {
  private store: Store;
  private hub: Broadcaster;
  private engines: Record<EngineKind, EngineInfo>;
  private runners = new Map<string, ScopedRunner>();
  private approvals = new Map<string, PendingApproval>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private tokens = new Map<string, string>();
  private mailbox: Mailbox;
  private channels: Channels;
  private worktreesRoot: string;
  /** Images pasted or attached to user messages, one folder per agent. */
  private attachments: Attachments;
  /** Images the user attaches to channel posts, one folder per channel. */
  private channelAttachments: Attachments;
  /** Each agent's private folder: soul.md, memory.md, and the workspace of an agent with no project. */
  private homes: AgentHomes;
  /** The memory each agent's app view was last sent, to notice memory.md changing on disk. */
  private memoryVersions = new Map<string, string>();
  /** Dreaming: the gate, triggers, records, undo, soul proposals and the numbers. */
  private dreamer: Dreamer;
  /** What AgentsCode knows about the user (user.md), shared by every agent, and its proposals. */
  private profile: ProfileStore;
  /** The profile the app was last sent, to notice user.md changing on disk. */
  private profileVersion: string | undefined;
  /** How many profile proposals waited when last published, to tell the SuperAgent of new ones. */
  private profileWaiting = 0;
  /** The SuperAgent's asks and decision log, and the watcher that wakes it. */
  private superStore: SuperStore;
  private watcher: SuperWatcher;
  private superTimer: NodeJS.Timeout | null = null;
  /** Stuck agents already reported, by turn or approval, so each is news once. */
  private stuckNoted = new Set<string>();
  private idleProcessMs: number;
  private createRunner: (ctx: RunnerContext) => Runner;
  private models: Record<EngineKind, EngineModels> = { claude: emptyModels('claude'), codex: emptyModels('codex'), orcacode: emptyModels('orcacode') };
  /** Claude reports cost cumulatively per process; remember the last figure to get each turn's share. */
  private processCost = new Map<string, number>();
  private shuttingDown = false;

  /** The desktop app's browser, for agents' browser_* tools (server/browserBridge.ts). */
  readonly browser: BrowserBridge;
  private ghExec: Exec | undefined;
  private checkExec: CheckExec | undefined;
  private gitRemote: (projectPath: string) => Promise<string | null>;

  constructor(store: Store, hub: Broadcaster, engines: Record<EngineKind, EngineInfo>, options: ManagerOptions = {}) {
    this.store = store;
    this.hub = hub;
    this.engines = engines;
    this.worktreesRoot = options.worktreesRoot ?? path.join(store.dataDir, 'worktrees');
    this.attachments = new Attachments(path.join(store.dataDir, 'attachments'));
    this.channelAttachments = new Attachments(path.join(store.dataDir, 'channel-attachments'));
    this.homes = new AgentHomes(path.join(store.dataDir, 'agents'));
    this.profile = new ProfileStore(store.dataDir);
    this.superStore = new SuperStore(store.dataDir);
    this.watcher = new SuperWatcher({
      superId: () => this.superId(),
      idle: () => {
        const id = this.superId();
        const agent = id ? this.store.agents.get(id) : undefined;
        return Boolean(agent) && !this.runners.get(id!)?.busy && agent!.status !== 'working' && agent!.status !== 'waiting';
      },
      settings: () => this.store.settings,
      mailQueued: messageId => this.store.messages.some(m => m.id === messageId && m.status === 'queued'),
      store: this.superStore,
      deliver: (prompt, events) => this.wakeSuper(prompt, `Update: ${events.map(e => e.text).join('; ')}`),
    });
    this.createRunner = options.createRunner ?? (ctx => createEngineRunner(ctx));
    this.idleProcessMs = options.idleProcessMs ?? IDLE_PROCESS_MS;
    this.browser = options.browser ?? new BrowserBridge();
    this.ghExec = options.ghExec;
    this.checkExec = options.checkExec;
    this.gitRemote = options.gitRemote ?? (async dir => {
      const result = await gitRun(dir, ['remote', 'get-url', 'origin'], 5000);
      return result.ok ? result.stdout.trim() : null;
    });
    this.dreamer = new Dreamer({
      homes: this.homes,
      agent: id => this.store.agents.get(id),
      entries: id => this.store.readEntries(id, 5000),
      busy: id => {
        const agent = this.store.agents.get(id);
        return Boolean(this.runners.get(id)?.busy) || agent?.status === 'working' || agent?.status === 'waiting';
      },
      engine: options.dreamEngine ?? defaultDreamEngine({ claude: engines.claude.path, codex: engines.codex.path, orcacode: engines.orcacode.path }),
      broadcast: event => this.hub.broadcast(event),
      note: (agentId, text) => this.addEntry(agentId, { id: randomUUID(), kind: 'system', text }),
      memoryChanged: (agent, entries) => this.publishMemory(agent.id, entries),
      soulChanged: (agent, soul) => {
        agent.instructions = soul;
        this.emitAgent(agent);
      },
      profile: this.profile,
      profileChanged: () => this.publishProfile(),
      dreamed: (_agent, record) => {
        // New memory may now say what another agent's memory says: offer it for the profile.
        if (record.status === 'applied' && record.ops.some(o => o.result === 'applied')) this.promote();
      },
    });
    this.mailbox = new Mailbox(store, {
      ready: id => this.store.agents.has(id) && !this.runners.get(id)?.busy,
      send: (id, text, task) => {
        this.clearIdleTimer(id);
        // A turn started by mail about work the SuperAgent began on its own counts against its wake
        // budget like an update; mail about work you asked for does not.
        if (id === this.superId() && !this.userWork(task.messageId)) this.superStore.noteWake();
        this.runnerFor(this.agent(id)).send(text, task);
      },
      // Mail to the SuperAgent waits while it may not take a turn. Work you asked for (a conversation it
      // began in a turn you gave it) waits only on the daily budget; the rest on every wake-up limit.
      // Your own messages never go through here, so they never wait.
      hold: (id, message, conversation) => {
        if (id !== this.superId()) return null;
        const reason = this.mailHold(conversation);
        if (reason) this.watcher.noteHeld(message.id, reason);
        return reason;
      },
      userTurn: id => this.store.agents.get(id)?.role === 'super' && this.store.agents.get(id)?.currentTask?.source === 'user',
      changed: message => this.publishMessage(message),
      conversationChanged: conversation => this.hub.broadcast({ type: 'conversation', conversation }),
      inChannel: (channelId, agentId) => this.channels.isMember(channelId, agentId),
      channelPrompt: message => this.channels.mentionPrompt(message),
    });
    this.channels = new Channels(store, this.mailbox, {
      broadcast: event => this.hub.broadcast(event),
      // Each recipient gets its own copy, so its transcript shows the images and outlives the channel.
      startUserTask: (agentId, text, prompt, task, channel, images) =>
        this.startUserTask(agentId, text, prompt, task, channel, images.map(image => this.attachments.adopt(this.agent(agentId).id, image))),
    });
  }

  /** Nothing is running after a restart; settle agents that were mid-turn. */
  init(): void {
    this.mailbox.recover();
    this.channels.recover();
    for (const agent of this.store.agents.values()) {
      // Agents from before homes existed get one, with soul.md seeded from their instructions.
      if (agent.projectId === undefined) agent.projectId = null;
      // Kept in the home now (.prompt.json), not on the agent the app sees.
      delete (agent as Agent & { promptKey?: string }).promptKey;
      // Dreaming is on unless you turned it off.
      if (typeof agent.dreaming !== 'boolean') agent.dreaming = true;
      // The SuperAgent never edits, whatever a hand-edited state file says.
      if (agent.role === 'super') agent.autonomy = 'readonly';
      agent.home = this.homes.path(agent.id);
      try {
        this.homes.ensure(agent);
        agent.instructions = this.homes.readSoul(agent);
        if (agent.projectId === null) this.moveToWorkspace(agent);
      } catch (err) {
        console.error(`[agents] could not prepare ${agent.home}:`, (err as Error).message);
      }
      if (agent.status === 'working' || agent.status === 'waiting') {
        this.addEntry(agent.id, { id: randomUUID(), kind: 'system', text: 'AgentsCode restarted while this turn was running. Send a message to pick it back up.' });
        agent.status = 'idle';
      }
      agent.activity = '';
      agent.currentTask = null;
      agent.queued = 0;
      agent.turnStartedAt = null;
    }
    this.refreshProjects();
    this.store.save();
    // Mail that outlived a restart (see Mailbox.recover) goes now.
    setImmediate(() => this.mailbox.drainAll());
    // The SuperAgent's minute: updates that waited for it to be idle, and agents stuck too long.
    this.superTimer = setInterval(() => this.superTick(), 60_000);
    this.superTimer.unref?.();
  }

  private refreshProjects(): void {
    for (const project of this.store.projects.values()) {
      project.exists = isDirectory(project.path);
      project.isGit = project.exists && isInsideGitRepo(project.path);
    }
  }

  /** Which engine CLIs are installed, and where. */
  engineInfo(): Record<EngineKind, EngineInfo> {
    return this.engines;
  }

  snapshot(): Snapshot {
    this.refreshProjects();
    return {
      agents: [...this.store.agents.values()],
      projects: [...this.store.projects.values()],
      approvals: [...this.approvals.values()].map((p) => p.approval),
      messages: this.store.messages.slice(-500),
      conversations: this.store.conversations.slice(-200),
      channels: this.channels.list(),
      settings: this.store.settings,
      engines: this.engines,
      models: this.models,
      home: os.homedir(),
      platform: process.platform,
      profile: this.profileView(),
      super: this.superView(),
    };
  }

  /** Ask both CLIs for their model lists; each engine updates independently. */
  async refreshModels(): Promise<Record<EngineKind, EngineModels>> {
    const discover = async (engine: EngineKind) => {
      if (!this.engines[engine].available) return;
      try {
        const found = engine === 'claude' ? await discoverClaudeModels(this.engines.claude.path)
          : engine === 'orcacode' ? await discoverOrcacodeModels(this.engines.orcacode.path)
          : await discoverCodexModels(this.engines.codex.path);
        this.models = { ...this.models, [engine]: found };
        this.hub.broadcast({ type: 'models', models: this.models });
      } catch (err) {
        console.error(`[models] could not list ${engine} models:`, (err as Error).message);
      }
    };
    await Promise.all(ENGINES.map(discover));
    return this.models;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.watcher.stop();
    if (this.superTimer) clearInterval(this.superTimer);
    this.mailbox.shutdown();
    this.dreamer.abort();
    this.tokens.clear();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const pending of [...this.approvals.values()]) pending.finish({ allow: false, message: 'AgentsCode is closing.' });
    const closing = [...this.runners.values()].map(runner => runner.dispose());
    this.runners.clear();
    for (const agent of this.store.agents.values()) {
      if (agent.status === 'working' || agent.status === 'waiting') agent.status = 'idle';
      agent.currentTask = null;
    }
    this.store.flush();
    await Promise.all(closing);
  }

  // ---- agents ------------------------------------------------------------

  private agent(id: string): Agent {
    const agent = this.store.agents.get(id);
    if (!agent) throw new HttpError(404, 'No agent with that id.');
    return agent;
  }

  private emitAgent(agent: Agent): void {
    this.store.save();
    this.hub.broadcast({ type: 'agent', agent });
  }

  private agentName(raw: unknown, except?: string): string {
    const name = clip(String(raw ?? '').trim(), 24);
    if (!name) throw new HttpError(400, 'Give the agent a name.');
    const taken = [...this.store.agents.values()].find(a => a.id !== except && a.name.toLowerCase() === name.toLowerCase());
    // Teammates read names in messages, so keep them unique.
    if (taken) throw new HttpError(409, `There is already an agent called ${taken.name}.`);
    return name;
  }

  async create(req: CreateAgentRequest, options: { super?: boolean } = {}): Promise<Agent> {
    const engine = req.engine;
    if (!ENGINES.includes(engine)) throw new HttpError(400, 'Pick Claude Code, Codex or OrcaCode.');
    const problem = engineProblem(engine, this.engines[engine], req.projectId === null);
    if (problem) throw new HttpError(400, problem);
    // null is an agent with no project: it works across every project, from its own home.
    let project: Project | null = null;
    if (req.projectId === null) {
      if (req.worktree) throw new HttpError(400, 'An agent with no project cannot have its own worktree. Pick a project, or turn the worktree off.');
    } else {
      const found = this.store.projects.get(String(req.projectId ?? ''));
      if (!found) throw new HttpError(400, 'Pick a project for this agent.');
      if (!isDirectory(found.path)) throw new HttpError(400, `The project folder ${found.path} does not exist.`);
      project = found;
    }
    const name = this.agentName(req.name);
    const role = options.super ? 'super' : req.role ?? 'dev';
    // The SuperAgent is set up on its own (createSuper), never picked as a role.
    if (!options.super && !ROLES.some(r => r.id === role)) throw new HttpError(400, 'Unknown agent role.');
    const preset = rolePreset(role);
    const task = String(req.task ?? '').trim();
    if (task.length > 100_000) throw new HttpError(400, 'The first task is too long.');
    const autonomy = options.super ? 'readonly' : AUTONOMIES.includes(req.autonomy as Autonomy) ? (req.autonomy as Autonomy) : preset.autonomy;

    // Last fallible step before the agent exists, so a failure leaves nothing behind.
    let worktree: Worktree | null = null;
    if (project && req.worktree) worktree = await createWorktree(project.path, name, req.branch, this.worktreesRoot);
    try {
      this.agentName(name);
    } catch (error) {
      if (worktree) await removeWorktree(worktree, true).catch(() => {});
      throw error;
    }

    const now = Date.now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name,
      engine,
      projectId: project?.id ?? null,
      worktree,
      home: this.homes.path(id),
      dreaming: true,
      model: clip(String(req.model ?? '').trim(), MODEL_MAX),
      effort: validEffort(req.effort),
      autonomy,
      useMcp: engine === 'claude' && Boolean(req.useMcp),
      role,
      instructions: String(req.instructions ?? preset.instructions).trim().slice(0, SOUL_LIMIT),
      status: 'idle',
      activity: '',
      currentTask: null,
      sessionId: null,
      createdAt: now,
      lastActiveAt: now,
      turnStartedAt: null,
      unread: false,
      costUsd: 0,
      tokens: 0,
      turns: 0,
      queued: 0,
      lastSummary: '',
      error: null,
    };
    try {
      this.homes.ensure(agent);
      if (!project) this.homes.workspace(agent);
    } catch (error) {
      if (worktree) await removeWorktree(worktree, true).catch(() => {});
      throw error;
    }
    this.store.agents.set(agent.id, agent);
    this.addEntry(agent.id, {
      id: randomUUID(),
      kind: 'system',
      sessionStart: true,
      text: !project
        ? `${agent.name} works across all projects from ${workspacePath(agent.home)}.`
        : worktree
          ? `${agent.name} works on ${project.name} in its own worktree on branch ${worktree.branch} (from ${worktree.base}) at ${worktree.cwd}.`
          : `${agent.name} works on ${project.name} at ${project.path}.`,
    });
    this.emitAgent(agent);
    if (task) {
      try {
        this.send(agent.id, task);
      } catch (err) {
        this.addEntry(agent.id, { id: randomUUID(), kind: 'error', text: `Could not start the first task: ${(err as Error).message}` });
      }
    }
    return agent;
  }

  async update(id: string, patch: AgentPatch): Promise<Agent> {
    const agent = this.agent(id);
    const name = patch.name === undefined ? undefined : this.agentName(patch.name, id);
    if (patch.autonomy !== undefined && !AUTONOMIES.includes(patch.autonomy)) throw new HttpError(400, 'Unknown autonomy level.');
    if (patch.role !== undefined && !ROLES.some(r => r.id === patch.role) && !(agent.role === 'super' && patch.role === 'super')) throw new HttpError(400, 'Unknown agent role.');
    // The SuperAgent stays what it is: read-only, and the only one of its role.
    if (agent.role === 'super' && patch.role !== undefined && patch.role !== 'super') throw new HttpError(400, 'The SuperAgent keeps its role. Remove it to stop using it.');
    if (agent.role === 'super' && patch.autonomy !== undefined && patch.autonomy !== 'readonly') throw new HttpError(400, 'The SuperAgent never edits, so it stays read-only.');
    if (patch.dreaming !== undefined && typeof patch.dreaming !== 'boolean') throw new HttpError(400, 'Dreaming is on or off: true or false.');
    const model = patch.model === undefined ? undefined : clip(String(patch.model).trim(), MODEL_MAX);
    const effort = patch.effort === undefined ? undefined : validEffort(patch.effort);
    const tier = patch.serviceTier === undefined ? undefined : String(patch.serviceTier).trim().slice(0, 40);
    // A tier is kept only while the agent's model offers it, so a model switch never sends one it
    // lacks. Before the model list has loaded, nothing is known, so nothing is dropped or refused.
    const catalog = this.models[agent.engine];
    const offered = catalog.discovered ? serviceTiers({ model: model ?? agent.model }, catalog) : null;
    if (tier && offered && !offered.some(t => t.id === tier)) throw new HttpError(400, `${(model ?? agent.model) || 'This model'} has no "${tier}" service tier.`);
    const nextTier = tier ?? agent.serviceTier ?? '';
    const keptTier = !nextTier || !offered || offered.some(t => t.id === nextTier) ? nextTier : '';
    const runner = this.runners.get(id);
    if (name !== undefined) agent.name = name;
    // soul.md is the source of truth; the agent sees the change at its next turn.
    if (patch.instructions !== undefined) {
      agent.instructions = this.homes.writeSoul(agent, String(patch.instructions));
      // A soul proposal waiting for the user is now against an older soul.md.
      this.dreamer.soulEdited(agent);
    }
    if (patch.role !== undefined) agent.role = patch.role;
    if (patch.dreaming !== undefined && patch.dreaming !== agent.dreaming) {
      agent.dreaming = patch.dreaming;
      this.dreamer.toggled(agent, patch.dreaming);
      // Off means no dream runs: stop one that is thinking now; it writes nothing.
      if (!patch.dreaming) this.dreamer.abort(id);
    }
    if (patch.autonomy !== undefined && patch.autonomy !== agent.autonomy) {
      // Keep the picker in sync with the provider, and let failed changes be retried.
      await runner?.setAutonomy(patch.autonomy);
      agent.autonomy = patch.autonomy;
    }
    if (model !== undefined && model !== agent.model) {
      agent.model = model;
      // The window belongs to the model; the level still describes the transcript.
      agent.context = dropContextWindow(agent.context);
      await runner?.setModel(model).catch(() => {});
    }
    if (effort !== undefined && effort !== agent.effort) {
      agent.effort = effort;
      await runner?.setEffort(effort).catch(() => {});
    }
    if (keptTier !== (agent.serviceTier ?? '')) {
      if (keptTier) agent.serviceTier = keptTier;
      else delete agent.serviceTier;
      await runner?.setServiceTier?.(keptTier).catch(() => {});
    }
    this.emitAgent(agent);
    return agent;
  }

  async remove(id: string, cleanup: WorktreeCleanup = 'keep'): Promise<void> {
    const agent = this.agent(id);
    this.mailbox.stop(id);
    this.tokens.delete(id);
    this.cancelApprovals(id, 'The agent was removed.');
    this.dreamer.abort(id);
    await this.runners.get(id)?.dispose();
    this.runners.delete(id);
    this.clearIdleTimer(id);
    // If removal fails (e.g. uncommitted changes without "discard"), the agent stays.
    if (cleanup !== 'keep' && agent.worktree) await removeWorktree(agent.worktree, cleanup === 'discard');
    this.channels.agentRemoved(id);
    this.browser.agentRemoved(id);
    this.mailbox.forget(id);
    this.store.agents.delete(id);
    this.store.deleteTranscript(id);
    this.attachments.remove(id);
    this.homes.remove(id);
    this.memoryVersions.delete(id);
    this.store.save();
    this.hub.broadcast({ type: 'agentRemoved', id });
  }

  send(id: string, rawText: unknown, rawImages?: unknown): void {
    this.agent(id);
    const text = String(rawText ?? '').trim();
    const images = this.attachments.resolve(id, rawImages);
    if (!text && !images.length) throw new HttpError(400, 'Message is empty.');
    if (text.length > 100_000) throw new HttpError(400, 'Message is too long.');
    if (isIdeCommand(text)) throw new HttpError(400, 'Use New session to clear the conversation.');
    const pictures = images.length === 1 ? 'an image' : `${images.length} images`;
    // The engines need some text with an image: Claude refuses an empty text block, Codex an empty prompt.
    const prompt = this.withSkills(id, text) || `(The user sent ${pictures} with no text.)`;
    const summary = text ? clip(text.replace(/\s+/g, ' '), 280) : `Sent ${pictures}`;
    this.startUserTask(id, text, prompt, { summary, source: 'user' }, undefined, images);
  }

  /** Store an image for this agent's next message; the message names it by the returned id. */
  saveAttachment(id: string, body: unknown, name?: unknown): ImageAttachment {
    return this.attachments.save(this.agent(id).id, body, name);
  }

  attachmentFile(id: string, file: unknown): { path: string; mediaType: ImageAttachment['mediaType'] } {
    return this.attachments.file(this.agent(id).id, file);
  }

  /** Queue a user task: the transcript shows `text`, the engine gets `prompt`. */
  private startUserTask(
    id: string,
    text: string,
    prompt: string,
    task: AgentTask,
    channel?: { id: string; postId: string },
    images: { attachment: ImageAttachment; path: string }[] = [],
  ): void {
    const agent = this.agent(id);
    if (this.runners.get(id)?.accepting === false) throw new HttpError(409, 'The agent session is closing. Try again in a moment.');
    this.clearIdleTimer(id);
    const entryId = randomUUID();
    this.addEntry(id, { id: entryId, kind: 'user', text, channel, images: images.length ? images.map(i => i.attachment) : undefined });
    this.mailbox.userTask(id);
    const runner = this.runnerFor(agent);
    agent.unread = false;
    agent.lastActiveAt = Date.now();
    const files: RunnerImage[] = images.map(i => ({ path: i.path, mediaType: i.attachment.mediaType }));
    runner.send(prompt, { ...task, entryId }, files.length ? files : undefined);
    agent.queued = runner.queuedUserTasks + this.mailbox.pending(id);
    this.emitAgent(agent);
  }

  async stop(id: string): Promise<void> {
    const agent = this.agent(id);
    this.mailbox.stop(id);
    this.cancelApprovals(id, 'The user pressed stop.');
    this.tokens.delete(id);
    await this.runners.get(id)?.interrupt();
    agent.queued = this.mailbox.pending(id);
    this.emitAgent(agent);
  }

  seen(id: string): void {
    const agent = this.agent(id);
    if (!agent.unread) return;
    agent.unread = false;
    this.emitAgent(agent);
  }

  /** Forget the conversation; the next message starts a brand new session. */
  async newSession(id: string): Promise<void> {
    const agent = this.agent(id);
    if (this.runners.get(id)?.busy) throw new HttpError(409, `${agent.name} is busy. Stop the current turn first.`);
    // Collaborations built on the old context end, but teammates can reach the agent again.
    this.mailbox.stop(id);
    this.mailbox.userTask(id);
    this.tokens.delete(id);
    await this.runners.get(id)?.dispose();
    this.runners.delete(id);
    agent.sessionId = null;
    delete agent.context;
    delete agent.threadUsage;
    agent.currentTask = null;
    agent.status = 'idle';
    agent.activity = '';
    agent.error = null;
    this.addEntry(id, { id: randomUUID(), kind: 'system', text: 'Started a fresh session. Earlier context is cleared.', sessionStart: true });
    this.emitAgent(agent);
    // The session that just ended is worth a dream, if the gate allows one.
    this.dream(id, 'session-end');
  }

  entries(id: string): Entry[] {
    this.agent(id);
    return this.store.readEntries(id);
  }

  /**
   * The skills and commands the composer's `/` picker offers for this agent. A running Claude
   * session names them exactly; the files on disk fill in where each comes from, and stand in
   * when no session is running.
   */
  async commands(id: string): Promise<ComposerCommand[]> {
    const agent = this.agent(id);
    const found = commandsFor(agent.engine, this.workspaceOf(id).root, os.homedir());
    const live = await this.runners.get(id)?.commands().catch(() => undefined);
    const strip = ({ path: _path, ...command }: DiscoveredCommand): ComposerCommand => command;
    if (!live?.length) return found.map(strip);
    const byName = new Map(found.map(command => [command.name, command]));
    return live.map(command => {
      const known = byName.get(command.name);
      if (known) return { ...strip(known), description: command.description || known.description, argumentHint: command.argumentHint ?? known.argumentHint };
      const plugin = command.name.includes(':') ? command.name.slice(0, command.name.indexOf(':')) : undefined;
      return { ...command, scope: plugin ? 'plugin' : 'user', source: plugin ?? agent.engine };
    });
  }

  /**
   * Codex does not run skills itself, and OrcaCode only knows $name, so a message naming one with
   * /name carries the skill's instructions to it (MonoCode's injectSkillPrompt). Claude Code runs them as typed.
   */
  private withSkills(id: string, text: string): string {
    const agent = this.agent(id);
    if (agent.engine === 'claude' || !text.includes('/')) return text;
    const names = skillNamesInText(text);
    if (!names.length) return text;
    let catalog: DiscoveredCommand[];
    try {
      catalog = commandsFor(agent.engine, this.workspaceOf(id).root, os.homedir());
    } catch {
      return text;
    }
    const skills = names.flatMap(name => {
      const skill = catalog.find(command => command.name === name);
      return skill ? [{ name, body: commandBody(skill) }] : [];
    });
    return injectSkillPrompt(text, skills);
  }

  /**
   * An agent with no project used to work from its home itself, where its edit tools could rewrite
   * soul.md and memory.md. It works from home/workspace now. Claude Code keeps a session per working
   * folder, so a Claude session that started anywhere else (sessionCwd; a session from before it was
   * recorded started in the home) cannot resume: it is ended here, with a note. Whether a workspace
   * folder already existed does not matter. Codex threads resume from any folder; an OrcaCode session
   * resumes in the folder it recorded, so it is ended like Claude's. Files the agent saved
   * before stay in its home, where it can still edit them (only AgentsCode's own files are guarded).
   */
  private moveToWorkspace(agent: Agent): void {
    const workspace = fs.realpathSync(this.homes.workspace(agent));
    if (agent.engine === 'codex' || !agent.sessionId || agent.sessionCwd === workspace) return;
    agent.sessionId = null;
    delete agent.sessionCwd;
    delete agent.context;
    delete agent.threadUsage;
    this.addEntry(agent.id, {
      id: randomUUID(),
      kind: 'system',
      sessionStart: true,
      text: `${agent.name} now works from ${workspacePath(agent.home)}, so soul.md and memory.md are outside its working folder. The next message starts a fresh session; files saved before are still in ${agent.home}, and it can still edit them there.`,
    });
  }

  /** The folder an agent works in: its worktree, its project, or (with no project) the workspace in its home. */
  workspaceOf(id: string): { root: string; baseCommit?: string } {
    const agent = this.agent(id);
    const root = agent.worktree?.cwd ?? (agent.projectId === null ? this.homes.workspace(agent) : this.project(agent.projectId).path);
    if (!isDirectory(root)) throw new HttpError(409, `The workspace folder is missing: ${root}.`);
    return { root, baseCommit: agent.worktree?.baseCommit };
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new HttpError(404, 'That request was already answered.');
    pending.finish({
      allow: Boolean(decision.allow),
      always: Boolean(decision.always),
      message: decision.message ? String(decision.message).slice(0, 4000) : undefined,
      answers: decision.answers && typeof decision.answers === 'object' ? decision.answers : undefined,
    });
  }

  stopConversation(id: string): Conversation {
    return this.mailbox.stopConversation(id);
  }

  // ---- channels ----------------------------------------------------------

  createChannel(input: ChannelInput): Channel { return this.channels.create(input ?? {}); }
  updateChannel(id: string, input: ChannelInput): Channel { return this.channels.update(id, input ?? {}); }
  removeChannel(id: string): void {
    const channel = this.channels.get(id);
    this.channels.remove(channel.id);
    this.channelAttachments.remove(channel.id);
  }
  channelPosts(id: string): ChannelPost[] { return this.channels.posts(id); }
  postToChannel(id: string, text: unknown, mentions: unknown, threadId?: unknown, images?: unknown): ChannelPost {
    const channel = this.channels.get(id);
    return this.channels.postAsUser(channel.id, text, mentions, threadId, this.channelAttachments.resolve(channel.id, images));
  }
  /** Store an image for the user's next post in this channel; the post names it by the returned id. */
  saveChannelAttachment(id: string, body: unknown, name?: unknown): ImageAttachment {
    return this.channelAttachments.save(this.channels.get(id).id, body, name);
  }
  channelAttachmentFile(id: string, file: unknown): { path: string; mediaType: ImageAttachment['mediaType'] } {
    return this.channelAttachments.file(this.channels.get(id).id, file);
  }
  channelSeen(id: string): void { this.channels.seen(id); }

  // ---- comms tools -------------------------------------------------------

  /** Identity comes from the per-process token, never from caller-supplied agent IDs. */
  async commsTool(token: string, tool: unknown, rawArgs: unknown): Promise<unknown> {
    const id = token ? [...this.tokens].find(([, value]) => value === token)?.[0] : undefined;
    if (!id) throw new HttpError(401, 'Agent credentials expired.');
    if (typeof tool !== 'string' || !(COMMS_TOOLS.includes(tool as CommsTool) || SUPER_TOOLS.includes(tool as SuperTool) || EYES_TOOLS.includes(tool as EyesTool))) throw new HttpError(400, 'Unknown comms tool.');
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
    const caller = this.agent(id);
    const isSuper = caller.role === 'super';
    // The SuperAgent's commands are its alone, whatever an MCP server registered; and it only looks at pages.
    if (SUPER_TOOLS.includes(tool as SuperTool) && !isSuper) throw new HttpError(403, 'Only the SuperAgent can run that command.');
    if (isSuper && BROWSER_TOOLS.includes(tool as BrowserTool) && !SUPER_BROWSER_TOOLS.includes(tool as BrowserTool)) {
      throw new HttpError(403, 'The SuperAgent only looks at pages; it never clicks, types or runs scripts in them.');
    }
    if (tool === 'read_transcript') return this.readTranscript(args);
    // Looking only (GitHub, CI, the app's window): the SuperAgent, reviewers and testers.
    if (EYES_TOOLS.includes(tool as EyesTool)) {
      if (!hasEyes(caller.role)) throw new HttpError(403, 'Only the SuperAgent, reviewers and testers have the GitHub, CI and screenshot tools.');
      return this.eyesTool(caller, tool as EyesTool, args);
    }
    if (tool === 'list_agents') return this.mailbox.teammates(id);
    if (tool === 'read_messages') return this.mailbox.history(id);
    if (tool === 'list_delegations') return this.mailbox.delegations(id);
    if (tool === 'list_channels') return this.channels.forAgent(id);
    if (tool === 'openui_guide') return { guide: openuiGuide() };
    if (tool === 'read_channel') {
      const parsed = readChannelInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide a channel id or name, and a limit from 1 to 100.');
      return this.channels.read(id, parsed.data.channel, parsed.data.limit, parsed.data.thread);
    }
    if (!this.runners.get(id)?.busy) throw new HttpError(409, 'Messages can only be sent during an active turn.');
    const agent = this.agent(id);
    if (tool === 'set_task_summary') {
      const parsed = summaryInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Task summary must contain 1 to 280 characters.');
      if (!agent.currentTask) throw new HttpError(409, 'There is no active task to describe.');
      agent.currentTask = { ...agent.currentTask, summary: parsed.data.summary.replace(/\s+/g, ' ') };
      agent.lastActiveAt = Date.now();
      this.emitAgent(agent);
      return agent.currentTask;
    }
    // Memory is the agent's own, so plan-only agents may learn too.
    if (tool === 'remember') {
      const parsed = rememberInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, `Say what to remember in 1 to ${MEMORY_TEXT_LIMIT} characters, with an optional why of up to ${MEMORY_WHY_LIMIT}, and scope "agent" or "user".`);
      if (parsed.data.scope === 'user') {
        const before = this.profile.entries();
        // Checked like a dream's: nothing the profile already says, nothing the user rejected.
        const { entry, added, entries } = this.profile.learn(parsed.data.text, parsed.data.why, { agentId: agent.id, from: agent.name });
        if (added) {
          this.publishProfile();
          this.sawOwnProfile(agent, before, entries);
        }
        return added
          ? { remembered: entry, scope: 'user', note: 'Saved to user.md; every agent gets it on its next turn, and the user can edit or delete it in AgentsCode.' }
          : { remembered: entry, scope: 'user', duplicate: 'The user profile already says that; nothing was added.' };
      }
      const before = this.homes.memory(agent);
      const { entry, added, entries } = this.homes.remember(agent, parsed.data.text, parsed.data.why);
      if (added) {
        this.publishMemory(agent.id, entries);
        this.sawOwnMemory(agent, before, entries);
      }
      return added ? { remembered: entry } : { remembered: entry, duplicate: 'Already in memory; nothing was added.' };
    }
    if (tool === 'forget') {
      const parsed = forgetInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Give the id of the entry to forget, and scope "agent" or "user".');
      if (parsed.data.scope === 'user') {
        const before = this.profile.entries();
        const target = before.find(e => e.id === parsed.data.id);
        if (!target) throw new HttpError(404, 'No profile entry with that id.');
        // The profile is everyone's: an agent removes only what it saved itself; the rest is the user's call.
        if (target.agentId !== agent.id) throw new HttpError(403, 'You can only forget profile entries you saved. Ask the user to change this one in AgentsCode (About you, in the sidebar).');
        const { entry, entries } = this.profile.forget(target.id);
        this.publishProfile();
        this.sawOwnProfile(agent, before, entries);
        return { forgot: entry, scope: 'user' };
      }
      const before = this.homes.memory(agent);
      const { entry, entries } = this.homes.forget(agent, parsed.data.id);
      this.publishMemory(agent.id, entries);
      this.sawOwnMemory(agent, before, entries);
      return { forgot: entry };
    }
    // A walkthrough only describes work, so plan-only agents may make one too.
    if (tool === 'create_walkthrough') {
      const parsed = walkthroughInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, `Give a title, a summary and 1 to 30 steps, each with a kind and a title. ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const walkthrough = await createWalkthrough({
        agentId: agent.id,
        agentName: agent.name,
        dir: this.walkthroughDir(agent.id),
        cwd: this.cwdOf(agent),
        home: os.homedir(),
        rootOf: (target) => this.stepRoot(agent, target),
        fallback: { projectId: agent.workingIn?.projectId ?? agent.projectId, root: agent.workingIn?.root ?? null, branch: agent.workingIn?.branch ?? null },
      }, parsed.data);
      return { created: summaryOf(walkthrough), folder: path.join(this.walkthroughDir(agent.id), walkthrough.id), note: 'The user can open it from your transcript in AgentsCode.' };
    }
    if (BROWSER_TOOLS.includes(tool as BrowserTool)) return this.browserTool(agent, tool as BrowserTool, args);
    if (isSuper && SUPER_TOOLS.includes(tool as SuperTool)) return this.superCommand(agent, tool as SuperTool, args);
    // The SuperAgent is read-only so it can never edit, but sending work to agents is its job.
    if (agent.autonomy === 'readonly' && !isSuper && (tool === 'send_message' || tool === 'delegate_task' || (tool === 'reply' && args.expects_reply === true))) {
      throw new HttpError(403, 'Plan-only agents can reply with findings, but need the user\'s approval before sending work to teammates.');
    }
    if (tool === 'post_to_channel') {
      const parsed = postInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide a channel id or name, 1 to 10,000 characters of text, and member ids to mention.');
      const input = parsed.data;
      if (agent.autonomy === 'readonly' && !isSuper && input.mention_agent_ids.length) {
        throw new HttpError(403, 'Plan-only agents can post findings, but need the user\'s approval before starting teammates. Post without mentions.');
      }
      return this.channels.postAsAgent(id, input.channel, input.text, input.mention_agent_ids, input.expects_reply, input.thread_id);
    }
    if (tool === 'delegate_task') {
      const parsed = delegationInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide a recipient, task kind, task and acceptance criteria within the tool limits.');
      const input = parsed.data;
      const receipt = this.mailbox.delegate(id, input.to_agent_id, { kind: input.kind, task: input.task, acceptanceCriteria: input.acceptance_criteria, context: input.context });
      if (isSuper) this.recordSuper({ tool, summary: `Delegated ${input.kind} to ${this.store.agents.get(input.to_agent_id)?.name ?? 'an agent'}: ${clip(input.task.replace(/\s+/g, ' '), 160)}`, why: clip(input.context ?? input.acceptance_criteria, 300) });
      return receipt;
    }
    if (tool === 'report_result') {
      const parsed = reportInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide the request message ID, outcome, summary and evidence within the tool limits.');
      const { message_id, ...report } = parsed.data;
      return this.mailbox.report(id, message_id, report);
    }
    if (tool === 'send_message') {
      const parsed = sendInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide a recipient ID and 1 to 10,000 characters of text.');
      const receipt = this.mailbox.send(id, parsed.data.to_agent_id, parsed.data.text, parsed.data.expects_reply);
      if (isSuper) this.recordSuper({ tool, summary: `Messaged ${this.store.agents.get(parsed.data.to_agent_id)?.name ?? 'an agent'}: ${clip(parsed.data.text.replace(/\s+/g, ' '), 160)}`, why: '' });
      return receipt;
    }
    const parsed = replyInput.safeParse(args);
    if (!parsed.success) throw new HttpError(400, 'Provide the message ID and 1 to 10,000 characters of text.');
    // Replying to a channel mention answers in the channel, where the user follows along.
    const original = this.store.messages.find(m => m.id === parsed.data.message_id);
    if (original?.channelId && original.toAgentId === id && this.store.channels.has(original.channelId)) {
      return this.channels.replyInChannel(id, original, parsed.data.text, parsed.data.expects_reply);
    }
    return this.mailbox.reply(id, parsed.data.message_id, parsed.data.text, parsed.data.expects_reply);
  }

  private publishMessage(message: PeerMessage): void {
    // Mail to or from the SuperAgent changes what waits for it.
    if (message.toAgentId === this.superId()) setImmediate(() => this.publishSuper());
    this.channels.messageChanged(message);
    // Channel messages show in the channel; the sender's transcript has its post_to_channel call.
    const parties = message.channelId ? [message.toAgentId] : [message.fromAgentId, message.toAgentId];
    for (const id of parties) {
      const agent = this.store.agents.get(id);
      if (!agent) continue;
      this.addEntry(id, { id: `peer:${message.id}`, kind: 'peer', text: message.text, peer: { ...message }, ts: message.ts });
      agent.queued = (this.runners.get(id)?.queuedUserTasks ?? 0) + this.mailbox.pending(id);
      if (id === message.toAgentId && message.status === 'queued') agent.unread = true;
      this.emitAgent(agent);
    }
    this.hub.broadcast({ type: 'message', message });
  }

  // ---- runners -----------------------------------------------------------

  private runnerFor(agent: Agent): ScopedRunner {
    const existing = this.runners.get(agent.id);
    if (existing?.accepting) return existing;
    const id = agent.id;
    const runner = new ScopedRunner({
      resolve: () => this.execution(id),
      create: context => this.createRunner(context),
      hooks: this.hooksFor(id),
      retired: () => { this.tokens.delete(id); this.processCost.delete(id); },
      cancelled: (task, reason) => {
        this.addEntry(id, { id: randomUUID(), kind: 'system', text: `Queued message cancelled: ${reason}` });
        this.channels.cancelled(id, task, reason);
      },
    });
    this.runners.set(id, runner);
    return runner;
  }

  /** The folder an agent's sessions run in, by its real path: its worktree, its project, or (no project) the workspace in its home, never the home itself. */
  private cwdOf(agent: Agent): string {
    const project = agent.projectId === null ? null : this.project(agent.projectId);
    return canonicalDirectory(agent.worktree?.cwd ?? project?.path ?? this.homes.workspace(agent));
  }

  private execution(agentId: string): ExecutionContext {
    const agent = this.agent(agentId);
    const project = agent.projectId === null ? null : this.project(agent.projectId);
    const cwd = this.cwdOf(agent);
    const projectPath = project ? canonicalDirectory(project.path) : null;
    // The project as the prompt names it, read live so a rename shows.
    const view = (): Project | null => (project && projectPath ? { ...this.project(project.id), path: projectPath } : null);
    return {
      cwd,
      context: hooks => {
        const commsToken = randomUUID() + randomUUID();
        this.tokens.set(agentId, commsToken);
        return {
          agent: () => this.agent(agentId),
          project: view(),
          cwd,
          binPath: this.engines[agent.engine].path,
          commsToken,
          // Fresh team context, and any section of the instructions that changed since the session saw it.
          preparePrompt: text => {
            const prepared = this.mailbox.preparePrompt(agentId, text);
            const live = this.agent(agentId);
            const context = this.promptContext(live);
            const sections = contextSections(live, view(), context);
            const keys = sectionKeys(sections);
            const seen = this.homes.seen(live);
            // A section the session never saw that is still empty (a profile nobody has written yet) tells it nothing.
            const changed = CONTEXT_SECTIONS.filter(name => seen[name] !== keys[name] && !(seen[name] === undefined && !sections[name]));
            if (!changed.length) return prepared;
            this.homes.setSeen(live, keys);
            // A session from before sections were tracked has seen none of them, nor the memory guidance.
            if (!Object.keys(seen).length) return fullContext(agentContext(live, view(), context), prepared);
            return refreshedContext(Object.fromEntries(changed.map(name => [name, sections[name]])), prepared);
          },
          instructions: () => {
            const live = this.agent(agentId);
            const context = this.promptContext(live);
            this.homes.setSeen(live, sectionKeys(contextSections(live, view(), context)));
            return systemInstructions(live, view(), context);
          },
          directories: () => (this.agent(agentId).projectId === null ? this.projectFolders().map(p => p.path) : []),
          hooks,
        };
      },
    };
  }

  /** Every project whose folder exists, by its real path: where an agent with no project may work. */
  private projectFolders(): { name: string; path: string }[] {
    return [...this.store.projects.values()].flatMap(p => {
      try {
        return [{ name: p.name, path: canonicalDirectory(p.path) }];
      } catch {
        return [];
      }
    });
  }

  /**
   * What the agent's instructions are built from, read fresh: soul.md (a hand edit is mirrored into
   * the agent here), memory.md (cut to its limit, and announced to the app if it changed on disk),
   * and for an agent with no project, the project list.
   */
  private promptContext(agent: Agent): PromptContext {
    try {
      const soul = this.homes.readSoul(agent);
      if (soul !== agent.instructions) {
        agent.instructions = soul;
        this.emitAgent(agent);
        this.dreamer.soulEdited(agent);
      }
    } catch (err) {
      console.error(`[agents] could not read ${agent.name}'s soul.md:`, (err as Error).message);
    }
    const { entries, omitted } = capMemory(agent.name, this.readMemory(agent));
    const profile = capProfile(this.readProfile());
    return {
      memory: entries,
      memoryOmitted: omitted,
      profile: profile.entries,
      profileOmitted: profile.omitted,
      projects: agent.projectId === null ? this.projectFolders() : undefined,
    };
  }

  /** user.md as it is now; a change made outside the app (a hand edit) is sent to the app. */
  private readProfile(): ProfileEntry[] {
    const entries = this.profile.entries();
    const version = JSON.stringify(entries);
    const known = this.profileVersion;
    this.profileVersion = version;
    if (known !== undefined && known !== version) this.hub.broadcast({ type: 'profile', profile: this.profile.view() });
    return entries;
  }

  /**
   * The agent changed the profile itself, so it already knows. If its session was up to date, mark
   * the new profile as seen for it alone; every other agent gets it on its next turn.
   */
  private sawOwnProfile(agent: Agent, before: ProfileEntry[], after: ProfileEntry[]): void {
    const seen = this.homes.seen(agent);
    const key = (entries: ProfileEntry[]) => {
      const { entries: kept, omitted } = capProfile(entries);
      return sectionKey(profileSection(kept, omitted));
    };
    // A session that never saw the section has seen it empty, which is what an empty profile says.
    const was = seen.user ?? (before.length ? undefined : key([]));
    if (was !== key(before)) return;
    this.homes.setSeen(agent, { ...seen, user: key(after) });
  }

  /** memory.md as it is now; a change made outside the app (a hand edit) is sent to the app. */
  private readMemory(agent: Agent): MemoryEntry[] {
    const entries = this.homes.memory(agent);
    const version = JSON.stringify(entries);
    const known = this.memoryVersions.get(agent.id);
    this.memoryVersions.set(agent.id, version);
    if (known !== undefined && known !== version) this.hub.broadcast({ type: 'memory', agentId: agent.id, entries });
    return entries;
  }

  /**
   * The agent changed its own memory with remember or forget, so it already knows. If its session
   * was up to date, mark the new memory as seen; an earlier change by the user still goes out.
   */
  private sawOwnMemory(agent: Agent, before: MemoryEntry[], after: MemoryEntry[]): void {
    const seen = this.homes.seen(agent);
    const key = (entries: MemoryEntry[]) => {
      const { entries: kept, omitted } = capMemory(agent.name, entries);
      return sectionKey(memorySection(kept, omitted));
    };
    if (seen.memory !== key(before)) return;
    this.homes.setSeen(agent, { ...seen, memory: key(after) });
  }

  // ---- memory ------------------------------------------------------------

  memory(id: string): MemoryEntry[] {
    return this.readMemory(this.agent(id));
  }

  updateMemory(id: string, entryId: string, patch: Partial<MemoryPatch>): MemoryEntry {
    const agent = this.agent(id);
    const old = this.homes.memory(agent).find(e => e.id === entryId);
    const { entry, entries } = this.homes.update(agent, entryId, patch?.text, patch?.why);
    // Your edit of an entry a dream wrote counts against that dream.
    if (old && (old.text !== entry.text || old.why !== entry.why)) this.dreamer.noteRevert(agent, old, 'edited');
    this.publishMemory(agent.id, entries);
    return entry;
  }

  forgetMemory(id: string, entryId: string): MemoryEntry {
    const agent = this.agent(id);
    const { entry, entries } = this.homes.forget(agent, entryId);
    this.dreamer.noteRevert(agent, entry, 'deleted');
    this.publishMemory(agent.id, entries);
    return entry;
  }

  // ---- dreaming ----------------------------------------------------------

  /** A trigger fired: dream in the background if the gate allows. */
  private dream(agentId: string, reason: 'session-end' | 'idle'): void {
    this.dreamer.maybe(agentId, reason).catch(err => console.error(`[dream] ${reason} dream failed:`, (err as Error).message));
  }

  dreams(id: string): AgentDreams {
    const agent = this.agent(id);
    return { dreams: this.dreamer.list(agent), stats: this.dreamer.stats(agent), proposal: this.dreamer.proposal(agent) };
  }

  /** Dream now: throws 409 when off, busy or already dreaming; otherwise resolves when the dream is done. */
  dreamNow(id: string): Promise<DreamRecord | null> {
    return this.dreamer.dreamNow(this.agent(id).id);
  }

  undoDream(id: string, dreamId: unknown): DreamRecord {
    return this.dreamer.undo(this.agent(id), String(dreamId ?? ''));
  }

  decideSoul(id: string, action: unknown): void {
    if (action !== 'accept' && action !== 'reject') throw new HttpError(400, 'Accept or reject the proposal.');
    this.dreamer.decide(this.agent(id), action);
  }

  dreamStats(): DreamStatsReport {
    const agents = [...this.store.agents.values()];
    return {
      agents: Object.fromEntries(agents.map(a => [a.id, this.dreamer.stats(a)])),
      // Every agent, each session counted with the setting it had at the time.
      dreamingOn: this.dreamer.groupStats(agents, 'on'),
      dreamingOff: this.dreamer.groupStats(agents, 'off'),
    };
  }

  // ---- the SuperAgent ------------------------------------------------------

  /** The SuperAgent's agent id, or null before it is set up. */
  superId(): string | null {
    return [...this.store.agents.values()].find(a => a.role === 'super')?.id ?? null;
  }

  superView(): SuperState {
    return { ...this.superStore.view(this.superId()), held: this.heldMail() };
  }

  /** The SuperAgent view last sent to the app, so an unchanged one is not sent again (the minute tick). */
  private superSent = '';

  private publishSuper(): SuperState {
    const view = this.superView();
    const key = JSON.stringify(view);
    if (key !== this.superSent) {
      this.superSent = key;
      this.hub.broadcast({ type: 'super', super: view });
    }
    return view;
  }

  private recordSuper(action: Omit<SuperAction, 'id' | 'at'>): SuperAction {
    const entry = this.superStore.record({ ...action, why: clip(action.why.replace(/\s+/g, ' ').trim(), 500) });
    this.publishSuper();
    return entry;
  }

  /**
   * Set up the SuperAgent: one per install, with no project, read-only on every engine. Claude by
   * default; the user may pick another engine and model.
   */
  async createSuper(req: { engine?: unknown; model?: unknown } = {}): Promise<Agent> {
    if (this.superId()) throw new HttpError(409, 'There is already a SuperAgent.');
    const engine = (ENGINES.includes(req.engine as EngineKind) ? req.engine : 'claude') as EngineKind;
    const agent = await this.create({
      name: SUPER_NAME, engine, projectId: null, role: 'super', model: typeof req.model === 'string' ? req.model : undefined, instructions: SUPER_PRESET.instructions,
    }, { super: true });
    this.publishSuper();
    return agent;
  }

  /** An agent the SuperAgent names by id or name; never itself, for commands that act on an agent. */
  private teammate(ref: unknown): Agent {
    const key = String(ref ?? '').trim();
    const agent = this.store.agents.get(key) ?? [...this.store.agents.values()].find(a => a.name.toLowerCase() === key.toLowerCase());
    if (!agent) throw new HttpError(404, `No agent called ${key}.`);
    if (agent.role === 'super') throw new HttpError(400, 'The SuperAgent cannot run that command on itself.');
    return agent;
  }

  private channelByRef(ref: string): Channel {
    const key = ref.trim().replace(/^#/, '').toLowerCase();
    const channel = this.channels.list().find(c => c.id === ref.trim() || c.name === key);
    if (!channel) throw new HttpError(404, `No channel called ${ref}.`);
    return channel;
  }

  /** The latest of any agent's transcript, for the SuperAgent: short, oldest first. */
  private readTranscript(args: Record<string, unknown>): unknown {
    const parsed = readTranscriptInput.safeParse(args);
    if (!parsed.success) throw new HttpError(400, 'Give an agent id or name, and a limit from 1 to 50.');
    const agent = this.teammateOrSelf(parsed.data.agent_id);
    const shown = this.store.readEntries(agent.id, 400).filter(e => e.kind !== 'turn').slice(-parsed.data.limit);
    return {
      agent: { id: agent.id, name: agent.name, status: agent.status, activity: agent.activity, lastSummary: agent.lastSummary },
      entries: shown.map(e => ({
        at: new Date(e.ts).toISOString(), kind: e.kind,
        ...(e.tool ? { tool: e.tool.name, summary: clip(e.tool.summary, 200), status: e.tool.status } : { text: clip(e.text, 600) }),
      })),
    };
  }

  private teammateOrSelf(ref: unknown): Agent {
    const key = String(ref ?? '').trim();
    const agent = this.store.agents.get(key) ?? [...this.store.agents.values()].find(a => a.name.toLowerCase() === key.toLowerCase());
    if (!agent) throw new HttpError(404, `No agent called ${key}.`);
    return agent;
  }

  /**
   * The SuperAgent's commands, each checked here whatever its MCP server offered: agents it creates
   * get their role's default permissions (never Full access) and no instructions of its own, it
   * changes no one's permissions or soul, and it creates at most superMaxCreatesPerDay agents a day.
   * Each lands in the decision log with how to undo it.
   */
  private async superCommand(caller: Agent, tool: SuperTool, args: Record<string, unknown>): Promise<unknown> {
    const fail = (message: string) => { throw new HttpError(400, message); };
    if (tool === 'ask_user') {
      const parsed = askUserInput.safeParse(args);
      if (!parsed.success) return fail('Ask one question of up to 300 characters, with 1 to 4 options of up to 80 characters each.');
      const ask = this.superStore.ask(parsed.data);
      this.publishSuper();
      return { asked: ask, note: 'The user sees it in AgentsCode; their answer arrives as a later turn. Do not wait or ask again.' };
    }
    if (tool === 'list_goals') return { goals: this.superStore.goals() };
    if (tool === 'list_routines') return { routines: this.superStore.routines() };
    if (tool === 'propose_routine') {
      const parsed = proposeRoutineInput.safeParse(args);
      if (!parsed.success) return fail('Give a name, a schedule (daily at "HH:MM", or every 1 to 168 hours), an optional project, the instruction and a why.');
      const input = parsed.data;
      const routine = this.superStore.addRoutine({ name: input.name, instruction: input.instruction, projectId: input.project ? this.projectRef(input.project).id : null, schedule: input.schedule, why: input.why }, 'super');
      this.recordSuper({ tool, why: input.why, undo: { kind: 'routine', routineId: routine.id }, summary: `Proposed the routine "${routine.name}" (${scheduleText(routine.schedule)})` });
      return { proposed: routine, note: 'It waits for the user to confirm it in the Routines tab; it never runs before that.' };
    }
    if (tool === 'add_goal') {
      const parsed = addGoalInput.safeParse(args);
      if (!parsed.success) return fail('Give the goal in up to 500 characters, an optional project, and a why.');
      const goal = this.superStore.addGoal({ text: parsed.data.text, projectId: parsed.data.project ? this.projectRef(parsed.data.project).id : null, by: 'super' });
      this.recordSuper({ tool, why: parsed.data.why, undo: { kind: 'goal', goalId: goal.id, before: null }, summary: `Added the goal "${clip(goal.text, 120)}"` });
      return { added: goal };
    }
    if (tool === 'update_goal' || tool === 'complete_goal') {
      const parsed = tool === 'update_goal' ? updateGoalInput.safeParse(args) : completeGoalInput.safeParse(args);
      if (!parsed.success) return fail('Give the goal id, what to change (status, text, agent_id, delegation_id or notes), and a why.');
      const input = parsed.data as { goal_id: string; status?: SuperGoal['status']; text?: string; agent_id?: string; delegation_id?: string; notes?: string; why: string };
      if (tool === 'update_goal' && [input.status, input.text, input.agent_id, input.delegation_id, input.notes].every(v => v === undefined)) {
        return fail('Say what to change: status, text, agent_id, delegation_id or notes.');
      }
      // Goals are handed out only in update turns. Mail about work you asked for skips the wake limits,
      // so a goal started from it would skip them too: starting one (in progress, or given to an agent) there is refused.
      if (tool === 'update_goal' && (input.status === 'in_progress' || input.agent_id) && this.inUserWorkMail(caller.id)) {
        throw new HttpError(409, 'Hand out goals only in update turns, not while handling a report or reply on work the user asked for. Finish this turn; the next update lists the queued goals.');
      }
      const before = this.superStore.goal(input.goal_id);
      const agentId = input.agent_id === undefined ? undefined : input.agent_id === '' ? '' : this.teammate(input.agent_id).id;
      const goal = this.superStore.updateGoal(before.id, {
        ...(tool === 'complete_goal' ? { status: 'done' as const } : input.status ? { status: input.status } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(input.delegation_id !== undefined ? { delegationId: input.delegation_id } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      const who = goal.agentId ? this.store.agents.get(goal.agentId)?.name : undefined;
      const summary = tool === 'complete_goal' ? `Completed the goal "${clip(goal.text, 120)}"`
        : `Goal "${clip(goal.text, 100)}": ${[goal.status !== before.status && goal.status.replace('_', ' '), who && goal.agentId !== before.agentId && `given to ${who}`, input.text !== undefined && 'reworded', input.notes !== undefined && 'notes'].filter(Boolean).join(', ') || 'updated'}`;
      this.recordSuper({ tool, why: input.why, undo: { kind: 'goal', goalId: goal.id, before }, summary });
      return { updated: goal };
    }
    if (tool === 'create_agent') {
      const parsed = createAgentInput.safeParse(args);
      if (!parsed.success) return fail('Give a name, engine, role, an optional project, model, worktree and first task, and a why.');
      const input = parsed.data;
      // The cap stops only agents it creates on its own: in a turn you gave it, or on mail about work
      // you asked for, it creates what the work needs.
      const forUser = caller.currentTask?.source === 'user' || this.inUserWorkMail(caller.id);
      const cap = this.store.settings.superMaxCreatesPerDay;
      if (!forUser && this.superStore.createdSince(Date.now() - 86_400_000) >= cap) {
        throw new HttpError(429, `You created ${cap} agents in the last day, the most the user allows (Settings, SuperAgent). Ask the user before creating more.`);
      }
      const projectId = input.project ? this.projectRef(input.project).id : null;
      const agent = await this.create({ name: input.name, engine: input.engine, projectId, role: input.role, model: input.model, worktree: input.worktree, task: input.task });
      this.recordSuper({
        tool, why: input.why, undo: { kind: 'removeAgent', agentId: agent.id }, ...(forUser ? { forUser: true } : {}),
        summary: `Created ${agent.name} (${rolePreset(agent.role).name}, ${ENGINE_LABELS[agent.engine]}) ${projectId ? `on ${this.store.projects.get(projectId)?.name}` : 'across all projects'}${input.task ? `, first task: ${clip(input.task.replace(/\s+/g, ' '), 120)}` : ''}`,
      });
      return { created: { id: agent.id, name: agent.name, role: agent.role, autonomy: agent.autonomy, projectId: agent.projectId } };
    }
    if (tool === 'update_agent') {
      const parsed = updateAgentInput.safeParse(args);
      if (!parsed.success) return fail('Give the agent and what to change (name, role, model or effort), and a why.');
      const input = parsed.data;
      const agent = this.teammate(input.agent_id);
      const before = { name: agent.name, role: agent.role, model: agent.model, effort: agent.effort };
      await this.update(agent.id, { ...(input.name ? { name: input.name } : {}), ...(input.role ? { role: input.role } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) });
      const changes = [input.name && `name ${before.name} to ${agent.name}`, input.role && `role to ${rolePreset(agent.role).name}`, input.model !== undefined && `model to ${agent.model || 'default'}`, input.effort !== undefined && `effort to ${agent.effort || 'default'}`].filter(Boolean);
      this.recordSuper({ tool, why: input.why, undo: { kind: 'agent', agentId: agent.id, before }, summary: `Changed ${agent.name}: ${changes.join(', ') || 'nothing'}` });
      return { updated: { id: agent.id, name: agent.name, role: agent.role, model: agent.model, effort: agent.effort } };
    }
    if (tool === 'new_session' || tool === 'stop_agent') {
      const parsed = agentCommandInput.safeParse(args);
      if (!parsed.success) return fail('Give the agent id or name, and a why.');
      const agent = this.teammate(parsed.data.agent_id);
      // A fresh session would lift a Stop the user pressed: only the user restarts a stopped agent.
      if (tool === 'new_session' && this.mailbox.stopped(agent.id)) {
        throw new HttpError(409, `The user stopped ${agent.name}. Only the user restarts it: ask them with ask_user instead.`);
      }
      if (tool === 'new_session') await this.newSession(agent.id);
      else await this.stop(agent.id);
      this.recordSuper({ tool, why: parsed.data.why, summary: tool === 'new_session' ? `Started a fresh session for ${agent.name}` : `Stopped ${agent.name}'s turn` });
      return { done: true, agent: agent.name };
    }
    const memberIds = (refs: string[]) => refs.map(ref => this.teammateOrSelf(ref).id);
    if (tool === 'create_channel') {
      const parsed = createChannelInput.safeParse(args);
      if (!parsed.success) return fail('Give a channel name, an optional topic, member agent ids, and a why.');
      const input = parsed.data;
      const channel = this.createChannel({ name: input.name, topic: input.topic, memberIds: memberIds(input.member_ids) });
      this.recordSuper({ tool, why: input.why, undo: { kind: 'removeChannel', channelId: channel.id }, summary: `Created #${channel.name} with ${this.names(channel.memberIds)}` });
      return { created: channel };
    }
    const parsed = updateChannelInput.safeParse(args);
    if (!parsed.success) return fail('Give the channel, what to change (name, topic, members to add or remove), and a why.');
    const input = parsed.data;
    const channel = this.channelByRef(input.channel);
    const before = { name: channel.name, topic: channel.topic, memberIds: [...channel.memberIds] };
    const add = memberIds(input.add_member_ids);
    const remove = new Set(memberIds(input.remove_member_ids));
    const members = [...new Set([...before.memberIds, ...add])].filter(m => !remove.has(m));
    const updated = this.updateChannel(channel.id, { ...(input.name ? { name: input.name } : {}), ...(input.topic !== undefined ? { topic: input.topic } : {}), memberIds: members });
    const changes = [
      input.name && `renamed to #${updated.name}`, input.topic !== undefined && 'new topic',
      add.length && `added ${this.names(add)}`, remove.size && `removed ${this.names([...remove])}`,
    ].filter(Boolean);
    this.recordSuper({ tool, why: input.why, undo: { kind: 'channel', channelId: channel.id, before }, summary: `Changed #${before.name}: ${changes.join(', ') || 'nothing'}` });
    return { updated };
  }

  /** A project the SuperAgent names by id or name. */
  private projectRef(ref: string): Project {
    const key = ref.trim().toLowerCase();
    const project = [...this.store.projects.values()].find(p => p.id === ref.trim() || p.name.toLowerCase() === key);
    if (!project) throw new HttpError(404, `No project called ${ref}. Adding a project needs the user: ask them.`);
    return project;
  }

  private names(ids: string[]): string {
    const names = ids.map(id => this.store.agents.get(id)?.name ?? 'a removed agent');
    return names.length ? names.join(', ') : 'no members';
  }

  /**
   * Start an update turn: AgentsCode's own words, never a user message. The transcript gets a short
   * system line; the SuperAgent reads the whole update.
   */
  private wakeSuper(prompt: string, line: string): void {
    const id = this.superId();
    if (!id) return;
    const agent = this.agent(id);
    this.clearIdleTimer(id);
    this.addEntry(id, { id: randomUUID(), kind: 'system', text: clip(line, 300) });
    const runner = this.runnerFor(agent);
    agent.lastActiveAt = Date.now();
    runner.send(prompt, { summary: 'Update from AgentsCode', source: 'system' });
    this.emitAgent(agent);
  }

  // The user's own changes to the backlog. A new goal is news for the SuperAgent; the rest it sees
  // in its next update's goal list.

  addGoal(body: { text?: unknown; projectId?: unknown }): SuperState {
    if (typeof body?.text !== 'string') throw new HttpError(400, 'Say what the goal is.');
    const goal = this.superStore.addGoal({ text: body.text, projectId: this.goalProject(body.projectId), by: 'user' });
    this.watcher.note({ agentId: 'user', key: `goal:${goal.id}`, text: `The user added a goal: "${goal.text}"` });
    return this.publishSuper();
  }

  updateGoal(id: string, body: { text?: unknown; projectId?: unknown; status?: unknown }): SuperState {
    if (body?.text !== undefined && typeof body.text !== 'string') throw new HttpError(400, 'A goal is text.');
    if (body?.status !== undefined && typeof body.status !== 'string') throw new HttpError(400, 'A goal is queued, in_progress, blocked or done.');
    this.superStore.updateGoal(id, {
      ...(typeof body?.text === 'string' ? { text: body.text } : {}),
      ...(body?.projectId !== undefined ? { projectId: this.goalProject(body.projectId) } : {}),
      ...(typeof body?.status === 'string' ? { status: body.status as SuperGoal['status'] } : {}),
    });
    return this.publishSuper();
  }

  /** A goal's project from the app: a project id, or null (or nothing) for none. */
  private goalProject(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') throw new HttpError(400, 'A project is given by its id.');
    return this.project(raw).id;
  }

  removeGoal(id: string): SuperState {
    this.superStore.removeGoal(id);
    return this.publishSuper();
  }

  moveGoal(id: string, to: unknown): SuperState {
    if (typeof to !== 'number' || !Number.isFinite(to)) throw new HttpError(400, 'Give the place to move it to, 0 first.');
    this.superStore.moveGoal(id, to);
    return this.publishSuper();
  }

  // The user's routines: add (on at once), change, confirm a proposal, turn on or off, remove.

  addRoutine(body: { name?: unknown; instruction?: unknown; projectId?: unknown; schedule?: unknown }): SuperState {
    this.superStore.addRoutine({ name: body?.name, instruction: body?.instruction, projectId: this.goalProject(body?.projectId), schedule: body?.schedule }, 'user');
    return this.publishSuper();
  }

  updateRoutine(id: string, body: { name?: unknown; instruction?: unknown; projectId?: unknown; schedule?: unknown; enabled?: unknown; confirm?: unknown }): SuperState {
    this.superStore.updateRoutine(id, { ...body, ...(body?.projectId !== undefined ? { projectId: this.goalProject(body.projectId) } : { projectId: undefined }) });
    return this.publishSuper();
  }

  removeRoutine(id: string): SuperState {
    this.superStore.removeRoutine(id);
    return this.publishSuper();
  }

  /**
   * The user answers a SuperAgent question: a click on an option, their own words, or (null) put
   * aside. An answer goes to the SuperAgent as the user's message, which it is.
   */
  answerSuper(askId: string, body: { answer?: unknown; dismiss?: unknown }): SuperState {
    const dismiss = body?.dismiss === true;
    const answer = dismiss ? null : String(body?.answer ?? '').trim();
    if (answer !== null && !answer) throw new HttpError(400, 'Pick an option or write an answer.');
    if (answer !== null && answer.length > 4000) throw new HttpError(400, 'That answer is too long.');
    const ask = this.superStore.answer(askId, answer);
    const id = this.superId();
    // The transcript keeps only the user's own words; the SuperAgent's question goes in the prompt,
    // so a dream never reads the question as something the user said.
    if (id && answer !== null) this.startUserTask(id, answer, `Answer to your question "${ask.question}": ${answer}`, { summary: clip(answer, 280), source: 'user' });
    return this.publishSuper();
  }

  /** Take back one of the SuperAgent's decisions, and tell it so it learns. */
  async undoSuper(actionId: string): Promise<SuperState> {
    const action = this.superStore.action(actionId);
    if (action.undoneAt) throw new HttpError(409, 'That was already undone.');
    const undo = action.undo;
    if (!undo) throw new HttpError(409, 'That cannot be undone from here.');
    if (undo.kind === 'removeAgent') {
      const agent = this.store.agents.get(undo.agentId);
      if (agent) {
        if (this.runners.get(agent.id)?.busy) throw new HttpError(409, `${agent.name} is working. Stop it first, then undo.`);
        await this.remove(agent.id, 'keep');
      }
    } else if (undo.kind === 'removeChannel') {
      if (this.store.channels.has(undo.channelId)) this.removeChannel(undo.channelId);
    } else if (undo.kind === 'channel') {
      if (!this.store.channels.has(undo.channelId)) throw new HttpError(409, 'That channel is gone.');
      this.updateChannel(undo.channelId, { ...undo.before, memberIds: undo.before.memberIds.filter(m => this.store.agents.has(m)) });
    } else if (undo.kind === 'goal') {
      this.superStore.restoreGoal(undo.goalId, undo.before);
    } else if (undo.kind === 'routine') {
      // Withdraw a proposal; one the user confirmed since is theirs now.
      const routine = this.superStore.routines().find(r => r.id === undo.routineId);
      if (!routine) throw new HttpError(409, 'That routine was removed since.');
      if (!routine.proposed) throw new HttpError(409, 'The user confirmed that routine, so it is theirs now. Change it in the Routines tab.');
      this.superStore.removeRoutine(routine.id);
    } else {
      if (!this.store.agents.has(undo.agentId)) throw new HttpError(409, 'That agent is gone.');
      await this.update(undo.agentId, undo.before);
    }
    this.superStore.markUndone(actionId);
    this.watcher.note({ agentId: 'user', key: `undo:${actionId}`, text: `The user undid your decision "${action.summary}". Take it as a preference.` });
    return this.publishSuper();
  }

  /**
   * An agent's turn ended: news for the SuperAgent's next update. Not its own turns, not turns the
   * user stopped, and not work it asked for itself (the reply or report reaches it anyway).
   */
  private noteForSuper(agent: Agent, task: AgentTask | null, result: TurnResult): void {
    const superId = this.superId();
    if (!superId || agent.id === superId || result.stopped) return;
    if (task?.source === 'agent' && task.fromAgentId === superId) return;
    // An agent came free (nothing queued for it) while goals wait: the SuperAgent picks the next one.
    // Not after a turn you started, which is yours, and only through the watcher, so the wake switch,
    // quiet hours, budgets and the idle check all apply.
    const free = (result.pending ?? 0) === 0 && this.mailbox.pending(agent.id) === 0;
    const queued = this.superStore.goals().filter(g => g.status === 'queued').length;
    if (queued && free && task?.source !== 'user') this.watcher.note({ agentId: agent.id, key: 'goals', text: `${agent.name} is free and ${queued} queued ${queued === 1 ? 'goal waits' : 'goals wait'}` });
    const asked = task?.summary ? `Task: ${clip(task.summary, 160).replace(/\.$/, '')}. ` : '';
    if (result.ok) this.watcher.note({ agentId: agent.id, key: `turn:${agent.id}`, text: `${agent.name} finished a turn`, untrusted: `${asked}Result: ${clip(summarize(result.summary) || 'Finished.', 400)}` });
    else this.watcher.note({ agentId: agent.id, key: `turn:${agent.id}`, text: `${agent.name} hit a problem`, untrusted: `${asked}Error: ${clip(result.error ?? 'Something went wrong.', 400)}` });
  }

  /** Why mail in this conversation may not start a SuperAgent turn now, or null. */
  private mailHold(conversation: Conversation | undefined): string | null {
    // Work you asked for always goes, past the daily budget too: the caps stop only what it starts on its own.
    return conversation?.userStarted ? null : this.watcher.held();
  }

  /** The SuperAgent is handling mail about work the user asked for (a report or reply in such a conversation). */
  private inUserWorkMail(superId: string): boolean {
    const message = this.mailbox.activeMessage(superId);
    return Boolean(message && this.store.conversations.find(c => c.id === message.conversationId)?.userStarted);
  }

  /** Whether a peer message belongs to work the user asked the SuperAgent for. */
  private userWork(messageId: string | undefined): boolean {
    const message = messageId ? this.store.messages.find(m => m.id === messageId) : undefined;
    return Boolean(message && this.store.conversations.find(c => c.id === message.conversationId)?.userStarted);
  }

  /** Mail to the SuperAgent waiting now, and why (the first reason), for the app. */
  private heldMail(): SuperState['held'] {
    const superId = this.superId();
    if (!superId) return null;
    let count = 0;
    let reason = '';
    for (const m of this.store.messages) {
      if (m.toAgentId !== superId || m.status !== 'queued') continue;
      const why = this.mailHold(this.store.conversations.find(c => c.id === m.conversationId));
      if (!why) continue;
      count++;
      reason ||= why;
    }
    return count ? { count, reason } : null;
  }

  /** Every minute: send what waits if it may go now, and report agents stuck in a turn or on the user. */
  private superTick(): void {
    const superId = this.superId();
    if (!superId) return;
    this.watcher.morning();
    // Routines that are due become updates, so every wake limit and the daily budget apply.
    for (const { routine, dueAt } of this.superStore.takeDueRoutines(new Date())) {
      const project = routine.projectId ? this.store.projects.get(routine.projectId)?.name : undefined;
      this.watcher.note({ agentId: 'routine', key: `routine:${routine.id}:${dueAt}`, text: `Routine "${routine.name}"${project ? ` for ${project}` : ''}, as the user set it up: ${routine.instruction}` });
    }
    const now = Date.now();
    for (const agent of this.store.agents.values()) {
      if (agent.role === 'super') continue;
      if (agent.status === 'working' && agent.turnStartedAt && now - agent.turnStartedAt > STUCK_WORKING_MS) {
        const key = `stuck:${agent.id}:${agent.turnStartedAt}`;
        if (!this.stuckNoted.has(key)) {
          this.stuckNoted.add(key);
          this.watcher.note({ agentId: agent.id, key, text: `${agent.name} has been working on one turn for ${Math.round((now - agent.turnStartedAt) / 60_000)} minutes (${agent.activity || 'no activity'})` });
        }
      }
    }
    for (const { approval } of this.approvals.values()) {
      const key = `waiting:${approval.id}`;
      if (now - approval.createdAt > STUCK_WAITING_MS && !this.stuckNoted.has(key)) {
        this.stuckNoted.add(key);
        const agent = this.store.agents.get(approval.agentId);
        if (agent) this.watcher.note({ agentId: agent.id, key, text: `${agent.name} has waited ${Math.round((now - approval.createdAt) / 60_000)} minutes for the user to answer`, untrusted: approval.title });
      }
    }
    // An update takes the wake slot first; held mail follows once that turn ends (its ready()
    // drain), or here on a later minute, so a mail backlog never crowds out the update about it.
    if (!this.watcher.flush()) this.mailbox.drain(superId);
    this.publishSuper();
  }

  // ---- the user profile ----------------------------------------------------

  profileView(): UserProfile {
    const view = this.profile.view();
    this.profileVersion = JSON.stringify(view.entries);
    return view;
  }

  /** The user adds an entry in the app. */
  addProfile(body: Partial<MemoryPatch>): UserProfile {
    const { added } = this.profile.add(body?.text, body?.why, {});
    if (!added) throw new HttpError(409, 'The profile already says that.');
    return this.publishProfile();
  }

  updateProfile(entryId: string, patch: Partial<MemoryPatch>): UserProfile {
    this.profile.update(entryId, patch?.text, patch?.why);
    return this.publishProfile();
  }

  forgetProfile(entryId: string): UserProfile {
    this.profile.forget(entryId);
    return this.publishProfile();
  }

  /**
   * Accept or reject a proposal. Accepting a promotion also removes the memory entries it replaces,
   * from each agent that still has them as they were: every agent reads the profile now.
   */
  decideProfile(proposalId: string, action: unknown): UserProfile {
    if (action !== 'accept' && action !== 'reject') throw new HttpError(400, 'Accept or reject the proposal.');
    const { proposal } = this.profile.decide(proposalId, action);
    if (action === 'accept') {
      for (const source of proposal.sources ?? []) {
        const agent = this.store.agents.get(source.agentId);
        const entry = agent ? this.homes.memory(agent).find(e => e.id === source.entryId) : undefined;
        if (!agent || !entry || entry.text !== source.text) continue;
        const { entries } = this.homes.forget(agent, entry.id);
        this.publishMemory(agent.id, entries);
      }
    }
    return this.publishProfile();
  }

  /**
   * Offer what two or more agents both remember as a profile proposal (see findPromotions). Plain
   * code, no model call; only agents with dreaming on take part, as they agreed to learn.
   */
  promote(): void {
    try {
      const memories = [...this.store.agents.values()]
        .filter(agent => agent.dreaming)
        .map(agent => ({ agentId: agent.id, agentName: agent.name, entries: this.homes.memory(agent) }))
        .filter(m => m.entries.length);
      if (memories.length < 2) return;
      let added = 0;
      for (const draft of findPromotions(memories, this.profile)) {
        try {
          this.profile.propose(draft);
          added++;
        } catch { /* full, or a secret: skip it */ }
      }
      if (added) this.publishProfile();
    } catch (err) {
      console.error('[profile] promotion failed:', (err as Error).message);
    }
  }

  private publishProfile(): UserProfile {
    const view = this.profile.view();
    if (view.proposals.length > this.profileWaiting) {
      this.watcher.note({ agentId: 'profile', key: 'profile-proposals', text: `${view.proposals.length} things learned about the user wait for their approval in About you` });
    }
    this.profileWaiting = view.proposals.length;
    this.profileVersion = JSON.stringify(view.entries);
    this.hub.broadcast({ type: 'profile', profile: view });
    return view;
  }

  private publishMemory(agentId: string, entries: MemoryEntry[]): void {
    this.memoryVersions.set(agentId, JSON.stringify(entries));
    this.hub.broadcast({ type: 'memory', agentId, entries });
  }

  private hooksFor(agentId: string): RunnerHooks {
    const live = () => this.store.agents.get(agentId);
    return {
      session: (sessionId) => {
        const agent = live();
        if (!agent) return;
        if (agent.sessionId !== sessionId) {
          // Where it started: a Claude session resumes only from the same folder (see moveToWorkspace).
          try {
            agent.sessionCwd = this.cwdOf(agent);
          } catch {
            delete agent.sessionCwd;
          }
        }
        agent.sessionId = sessionId;
        this.emitAgent(agent);
      },
      entry: (draft) => {
        if (live()) this.addEntry(agentId, draft);
      },
      activity: (text) => {
        const agent = live();
        if (!agent || agent.status !== 'working' || agent.activity === text) return;
        agent.activity = text;
        this.hub.broadcast({ type: 'agent', agent });
      },
      touched: (paths) => this.noteWhereabouts(agentId, paths),
      turnStart: (task) => {
        const agent = live();
        if (!agent) return;
        // Mark where the turn really begins and which prompt it runs; see TurnMarker.
        this.addEntry(agentId, {
          id: randomUUID(), kind: 'turn', text: '',
          turn: { source: task?.source ?? 'user', entryId: task?.entryId, messageId: task?.messageId },
        });
        this.channels.turnStarted(agentId, task);
        agent.status = 'working';
        agent.currentTask = task ? { ...task } : null;
        agent.queued = (this.runners.get(agentId)?.queuedUserTasks ?? 0) + this.mailbox.pending(agentId);
        agent.activity = 'Thinking';
        agent.turnStartedAt = Date.now();
        agent.lastActiveAt = agent.turnStartedAt;
        agent.error = null;
        this.seedWhereabouts(agent);
        this.emitAgent(agent);
      },
      turnEnd: (result) => this.onTurnEnd(agentId, result),
      context: (reading) => {
        const agent = live();
        if (!agent) return;
        const next = mergeContextUsage(agent.context, reading);
        // Streamed blocks of one reply repeat the same usage; only a change is news.
        if (sameContextUsage(agent.context, next)) return;
        agent.context = next;
        this.emitAgent(agent);
      },
      ready: () => { setImmediate(() => this.mailbox.drain(agentId)); },
      approval: (request, signal) =>
        new Promise<ApprovalDecision>((resolve) => {
          const agent = live();
          if (!agent || signal.aborted) return resolve({ allow: false, message: 'Cancelled.' });
          const approval: Approval = { id: randomUUID(), agentId, createdAt: Date.now(), ...request };
          const onAbort = () => finish({ allow: false, message: 'Cancelled.' });
          const finish = (decision: ApprovalDecision) => {
            if (!this.approvals.delete(approval.id)) return;
            signal.removeEventListener('abort', onAbort);
            this.hub.broadcast({ type: 'approvalResolved', id: approval.id, agentId });
            this.afterApproval(agentId, approval, decision);
            resolve(decision);
          };
          const drop = () => {
            if (!this.approvals.delete(approval.id)) return;
            signal.removeEventListener('abort', onAbort);
            this.hub.broadcast({ type: 'approvalResolved', id: approval.id, agentId });
            resolve({ allow: false, message: 'Cancelled.' });
          };
          signal.addEventListener('abort', onAbort, { once: true });
          this.approvals.set(approval.id, { approval, finish, drop });
          agent.status = 'waiting';
          agent.activity = approval.title;
          this.emitAgent(agent);
          this.hub.broadcast({ type: 'approval', approval });
          this.channels.needsUser(agentId, approval.title);
        }),
      closed: (error) => {
        this.runners.delete(agentId);
        this.tokens.delete(agentId);
        this.channels.sessionClosed(agentId, error);
        setImmediate(() => this.mailbox.drain(agentId));
        this.dropApprovals(agentId);
        const agent = live();
        if (!agent) return;
        agent.queued = this.mailbox.pending(agentId);
        if (agent.status === 'working' || agent.status === 'waiting') {
          agent.status = error ? 'error' : 'idle';
          agent.currentTask = null;
          agent.turnStartedAt = null;
          agent.activity = error ? 'Hit a problem' : '';
          agent.error = error ?? null;
        }
        if (error && agent.sessionId && /no conversation found|session.*not found/i.test(error)) {
          agent.sessionId = null;
          delete agent.context;
          delete agent.threadUsage;
          this.addEntry(agentId, { id: randomUUID(), kind: 'system', text: 'The previous session could not be resumed, so the next message starts a fresh one.' });
        }
        this.emitAgent(agent);
      },
    };
  }

  private afterApproval(agentId: string, approval: Approval, decision: ApprovalDecision): void {
    const agent = this.store.agents.get(agentId);
    if (!agent) return;
    const verb = approval.type === 'question' ? (decision.allow ? 'Answered' : 'Skipped') : decision.allow ? 'Allowed' : 'Denied';
    let text = `${verb}: ${approval.title}`;
    if (approval.type === 'question' && decision.answers) text += `\n${Object.values(decision.answers).join('; ')}`;
    else if (decision.message && decision.message !== 'Cancelled.') text += `\n"${clip(decision.message, 200)}"`;
    this.addEntry(agentId, { id: randomUUID(), kind: 'system', text });
    if (approval.type === 'plan' && decision.allow) agent.autonomy = 'edits';
    const stillWaiting = [...this.approvals.values()].some((p) => p.approval.agentId === agentId);
    if (!stillWaiting && agent.status === 'waiting') {
      agent.status = this.runners.get(agentId)?.busy ? 'working' : 'idle';
      agent.activity = agent.status === 'working' ? 'Thinking' : '';
    }
    this.emitAgent(agent);
  }

  private dropApprovals(agentId: string): void {
    for (const pending of [...this.approvals.values()]) {
      if (pending.approval.agentId === agentId) pending.drop();
    }
  }

  private cancelApprovals(agentId: string, message: string): void {
    for (const pending of [...this.approvals.values()]) {
      if (pending.approval.agentId === agentId) pending.finish({ allow: false, message });
    }
  }

  // ---- browser ------------------------------------------------------------

  /** One browser_* call: check it here (plan-only, the scripts setting, the URL), then ask the desktop app. */
  private async browserTool(agent: Agent, tool: BrowserTool, args: Record<string, unknown>): Promise<unknown> {
    const parsed = browserInputs[tool].safeParse(args);
    if (!parsed.success) throw new HttpError(400, `Check the ${tool} arguments: ${parsed.error.issues.slice(0, 3).map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`);
    const op = tool.slice('browser_'.length) as BrowserOp;
    const input: Record<string, unknown> = { ...parsed.data };
    if (agent.autonomy === 'readonly' && BROWSER_WRITE_OPS.includes(op)) {
      throw new HttpError(403, 'Plan-only agents can open, read, screenshot and check the console of pages, but not click, type, press keys, close tabs or run scripts.');
    }
    if (op === 'eval' && !this.store.settings.browserEval) {
      throw new HttpError(403, 'Running scripts in pages is off. The user can turn on Browser scripts in Settings; until then use browser_snapshot and browser_console.');
    }
    if (op === 'open') {
      // The same rules as the address bar and main (shared/browser.ts).
      const url = normalizeAddress(String(input.url));
      if (!url) throw new HttpError(400, 'That is not a web address the browser can open. Use http or https, for example localhost:3000 or https://example.com.');
      const blocked = blockedReason(url, PORT);
      if (blocked) throw new HttpError(400, blocked);
      input.url = url;
    }
    if (op === 'screenshot') {
      const dir = path.join(this.homes.path(agent.id), 'browser');
      fs.mkdirSync(dir, { recursive: true });
      input.path = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(input.tab_id).replace(/[^\w-]/g, '')}.png`);
    }
    try {
      const result = await this.browser.request(agent.id, op, input);
      return op === 'console' ? compactConsole(result) : result;
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  }

  // ---- eyes: read-only GitHub and CI, and the app's window ------------------

  /** The GitHub repo of a project, from its origin remote; null when it has none on GitHub. */
  private async projectRepo(project: Project): Promise<string | null> {
    const remote = await this.gitRemote(project.path).catch(() => null);
    return remote ? repoFromRemote(remote) : null;
  }

  /**
   * What an agent may look at with the eyes tools. The SuperAgent, and an agent with no project
   * (which already works with everyone), see every project; any other agent only its own project.
   */
  private eyesProjects(agent: Agent): Project[] | 'all' {
    if (agent.role === 'super' || agent.projectId === null) return 'all';
    const own = this.store.projects.get(agent.projectId);
    return own ? [own] : [];
  }

  /** A project the agent may look at, by id or name; 403 for one outside its scope. */
  private eyesProject(agent: Agent, ref: string): Project {
    const project = this.projectRef(ref);
    const scope = this.eyesProjects(agent);
    if (scope !== 'all' && !scope.some(p => p.id === project.id)) throw new HttpError(403, `You work on ${scope[0]?.name ?? 'one project'}, so you can look only at its GitHub repo.`);
    return project;
  }

  private async eyesTool(agent: Agent, tool: EyesTool, args: Record<string, unknown>): Promise<unknown> {
    const bad = (message: string) => { throw new HttpError(400, message); };
    if (tool === 'app_screenshot') return this.appScreenshot(agent, args);
    if (tool === 'run_check') {
      const parsed = runCheckInput.safeParse(args);
      if (!parsed.success) return bad(`Give a project and one of the checks: ${parsed.error.issues.slice(0, 2).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const { project: ref, command, ...options } = parsed.data;
      const project = this.eyesProject(agent, ref); // the same scope as the GitHub tools
      try {
        return { project: project.name, ...(await runCheck(project.path, command, options, this.checkExec)) };
      } catch (error) {
        throw new HttpError(error instanceof CheckError ? 400 : 500, (error as Error).message);
      }
    }
    const run = async (gh: string[]) => {
      try {
        return await runGh(gh, this.ghExec);
      } catch (error) {
        throw new HttpError(error instanceof GhError ? 409 : 500, (error as Error).message);
      }
    };
    /** The repo for one named project in the agent's scope, or a 409 that says why there is none. */
    const oneRepo = async (ref: string) => {
      const project = this.eyesProject(agent, ref);
      const repo = await this.projectRepo(project);
      if (!repo) throw new HttpError(409, `${project.name} has no GitHub remote (origin), so there is nothing to look up on GitHub.`);
      return { project, repo };
    };
    // What GitHub returns is written by others (titles, bodies, reviews, logs): it goes under
    // `untrusted`, with a line saying so, as agent text reaches the SuperAgent in its updates.
    const outside = (key: string, out: { data: unknown; note?: string }) => ({ untrusted: { [key]: out.data }, ...(out.note ? { note: out.note } : {}) });
    if (tool === 'gh_prs' || tool === 'gh_issues') {
      const parsed = (tool === 'gh_prs' ? ghPrsInput : ghIssuesInput).safeParse(args);
      if (!parsed.success) return bad('Give a project id or name, or nothing for every project you may look at.');
      const scope = this.eyesProjects(agent);
      const projects = parsed.data.project ? [this.eyesProject(agent, parsed.data.project)] : scope === 'all' ? [...this.store.projects.values()] : scope;
      // In parallel, so many projects stay within the tool's time.
      // Each project on its own: one that fails (gh logged out, a timeout) is a note, not the end of the rest.
      const results = await Promise.all(projects.map(async project => {
        const repo = await this.projectRepo(project);
        if (!repo) return { project: project.name, note: 'No GitHub remote (origin): skipped.' };
        try {
          const out = capJson(await run(tool === 'gh_prs' ? ghArgs.prs(repo) : ghArgs.issues(repo)));
          return { project: project.name, repo, ...outside(tool === 'gh_prs' ? 'pullRequests' : 'issues', out) };
        } catch (error) {
          return { project: project.name, repo, error: (error as Error).message };
        }
      }));
      return { about: GH_UNTRUSTED, results };
    }
    if (tool === 'gh_pr') {
      const parsed = ghPrInput.safeParse(args);
      if (!parsed.success) return bad('Give the project and the pull request number.');
      const { project, repo } = await oneRepo(parsed.data.project);
      return { about: GH_UNTRUSTED, project: project.name, repo, ...outside('pullRequest', capJson(await run(ghArgs.pr(repo, parsed.data.number)))) };
    }
    if (tool === 'gh_runs') {
      const parsed = ghRunsInput.safeParse(args);
      if (!parsed.success) return bad('Give the project, and optionally a branch or workflow.');
      const { project, repo } = await oneRepo(parsed.data.project);
      let gh: string[];
      try { gh = ghArgs.runs(repo, { branch: parsed.data.branch, workflow: parsed.data.workflow }); } catch (error) { return bad((error as Error).message); }
      return { about: GH_UNTRUSTED, project: project.name, repo, ...outside('runs', capJson(await run(gh))) };
    }
    const parsed = ghRunInput.safeParse(args);
    if (!parsed.success) return bad('Give the project and the run id.');
    const { project, repo } = await oneRepo(parsed.data.project);
    const id = String(parsed.data.run_id);
    const out = capJson(await run(ghArgs.run(repo, id)));
    const failed = parsed.data.failed_log && (out.data as { conclusion?: string } | null)?.conclusion === 'failure';
    const log = failed ? logTail(await run(ghArgs.runLog(repo, id)).catch(e => `(The failed log could not be read: ${(e as Error).message})`)) : undefined;
    return {
      about: GH_UNTRUSTED, project: project.name, repo,
      untrusted: { run: out.data, ...(log ? { failedLog: log.log } : {}) },
      ...(out.note || log?.note ? { note: [out.note, log?.note].filter(Boolean).join(' ') } : {}),
    };
  }

  /**
   * A PNG of the desktop app's main window, or of the quick window while it shows, saved in the
   * agent's home (screens/), never in a project. Opening a tab first changes what the user sees, and
   * stays within what the agent may already see: the SuperAgent anything; any other agent only
   * itself or agents visible to it under the team setting, and only channels it is a member of.
   */
  private async appScreenshot(agent: Agent, args: Record<string, unknown>): Promise<unknown> {
    const parsed = appScreenshotInput.safeParse(args);
    if (!parsed.success) throw new HttpError(400, 'Choose window main or quick, and optionally an agent or channel to open first.');
    if (!this.browser.available) throw new HttpError(409, 'app_screenshot works only in the AgentsCode desktop app; this AgentsCode runs in a browser.');
    const input = parsed.data;
    const isSuper = agent.role === 'super';
    let openAgent: string | undefined;
    if (input.agent) {
      const target = this.teammateOrSelf(input.agent);
      // Only the SuperAgent reads other agents' transcripts (read_transcript), so only it opens their tabs.
      if (!isSuper && target.id !== agent.id) throw new HttpError(403, 'You can open only your own tab; other agents\' transcripts are for the SuperAgent.');
      openAgent = target.id;
    }
    let openChannel: string | undefined;
    if (input.channel) {
      const channel = this.channelByRef(input.channel);
      if (!isSuper && !this.channels.isMember(channel.id, agent.id)) throw new HttpError(403, `You are not a member of #${channel.name}, so you cannot open it.`);
      openChannel = channel.id;
    }
    const dir = path.join(this.homes.path(agent.id), 'screens');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${input.window}.png`);
    try {
      return await this.browser.request(agent.id, 'app_screenshot', { path: file, window: input.window, ...(openAgent ? { openAgent } : {}), ...(openChannel ? { openChannel } : {}) });
    } catch (error) {
      throw new HttpError(409, (error as Error).message);
    }
  }

  /** A screenshot browser_screenshot saved in the agent's folder, for the transcript thumbnail. */
  browserShot(agentId: string, file: string): { path: string; mediaType: ImageAttachment['mediaType'] } {
    if (!/^[\w-]+\.png$/.test(file)) throw new HttpError(404, 'No such screenshot.');
    const full = path.join(this.homes.path(this.agent(agentId).id), 'browser', file);
    if (!fs.existsSync(full)) throw new HttpError(404, 'No such screenshot.');
    return { path: full, mediaType: 'image/png' };
  }

  // ---- walkthroughs --------------------------------------------------------

  private walkthroughDir(agentId: string): string {
    return path.join(this.homes.path(agentId), 'walkthroughs');
  }

  /** The folder a walkthrough step's file is in, and how the viewer opens it: a project, a worktree, or the agent's own workspace. */
  private stepRoot(agent: Agent, target: string): StepRoot | null {
    const real = (dir: string): string | null => { try { return fs.realpathSync(dir); } catch { return null; } };
    const inside = (dir: string) => target === dir || target.startsWith(dir + path.sep);
    const place = locate(target, this.places());
    if (place?.agentId) {
      // A worktree opens through its agent, whose workspace is the worktree's cwd.
      const owner = this.store.agents.get(place.agentId);
      const cwd = owner?.worktree ? real(owner.worktree.cwd) : null;
      return cwd && inside(cwd) ? { root: cwd, open: { agent: place.agentId }, projectId: place.projectId } : { root: place.root, open: null, projectId: place.projectId };
    }
    if (place) return { root: place.root, open: { project: place.projectId }, projectId: place.projectId };
    const own = real(this.workspaceOf(agent.id).root);
    if (own && inside(own)) return { root: own, open: { agent: agent.id }, projectId: agent.projectId };
    const home = real(this.homes.path(agent.id));
    if (home && inside(home)) return { root: home, open: null, projectId: null };
    return null;
  }

  walkthroughs(agentId: string) {
    return listWalkthroughs(this.walkthroughDir(this.agent(agentId).id));
  }

  walkthrough(agentId: string, id: string) {
    return readWalkthrough(this.walkthroughDir(this.agent(agentId).id), id);
  }

  walkthroughMarkdown(agentId: string, id: string): string {
    return walkthroughMarkdown(this.walkthrough(agentId, id));
  }

  walkthroughImage(agentId: string, id: string, file: string): { path: string; mediaType: ImageAttachment['mediaType'] } {
    const walkthrough = this.walkthrough(agentId, id);
    const image = walkthrough.steps.find(step => step.image?.file === file)?.image;
    if (!image) throw new HttpError(404, 'No such image.');
    return { path: walkthroughImage(this.walkthroughDir(agentId), id, file), mediaType: image.mediaType };
  }

  deleteWalkthrough(agentId: string, id: string): void {
    deleteWalkthrough(this.walkthroughDir(this.agent(agentId).id), id);
  }

  // ---- whereabouts --------------------------------------------------------

  /** Branch lookups per folder, so tool calls never wait on git; refreshed at each turn's end. */
  private branches = new Map<string, Promise<string | null>>();

  /** Every folder an agent can work in, canonical: each project's checkout and each agent worktree. */
  private places(): Place[] {
    const real = (dir: string): string | null => { try { return fs.realpathSync(dir); } catch { return null; } };
    const places: Place[] = [];
    for (const project of this.store.projects.values()) {
      const root = real(project.path);
      if (root) places.push({ root, projectId: project.id });
    }
    for (const agent of this.store.agents.values()) {
      const root = agent.worktree && agent.projectId ? real(agent.worktree.path) : null;
      if (root && agent.projectId) places.push({ root, projectId: agent.projectId, branch: agent.worktree!.branch, agentId: agent.id });
    }
    return places;
  }

  /** A path made canonical as far as it exists, so /tmp and /private/tmp match; new files resolve through their folder. */
  private canonicalPath(target: string): string {
    let dir = target;
    for (let i = 0; i < 64; i++) {
      try { return path.join(fs.realpathSync(dir), path.relative(dir, target)); } catch { /* go up */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return target;
  }

  private branchOf(root: string, fresh = false): Promise<string | null> {
    const cached = this.branches.get(root);
    if (cached && !fresh) return cached;
    const lookup = (async () => {
      const named = await gitRun(root, ['branch', '--show-current'], 5_000);
      if (!named.ok) return null;
      if (named.stdout.trim()) return named.stdout.trim();
      const head = await gitRun(root, ['rev-parse', '--short', 'HEAD'], 5_000);
      return head.ok && head.stdout.trim() ? head.stdout.trim() : null;
    })();
    this.branches.set(root, lookup);
    return lookup;
  }

  /** Move the agent to a place, then fill in its branch once git answers. */
  private moveTo(agent: Agent, place: Place, fresh = false): void {
    const now = Date.now();
    const same = agent.workingIn?.root === place.root && agent.workingIn.projectId === place.projectId;
    if (same && !fresh) {
      agent.workingIn!.at = now;
      return;
    }
    const branch = place.branch ?? (same ? agent.workingIn!.branch : null);
    agent.workingIn = { projectId: place.projectId, root: place.root, branch, at: now };
    if (!same) this.emitAgent(agent);
    if (place.branch) return;
    void this.branchOf(place.root, fresh).then((found) => {
      const live = this.store.agents.get(agent.id);
      if (!live?.workingIn || live.workingIn.root !== place.root || live.workingIn.branch === found) return;
      live.workingIn = { ...live.workingIn, branch: found };
      this.emitAgent(live);
    });
  }

  /** A tool call pointed at these paths: the last one inside a project says where the agent is. */
  private noteWhereabouts(agentId: string, paths: string[]): void {
    const agent = this.store.agents.get(agentId);
    if (!agent || !paths.length) return;
    const places = this.places();
    for (let i = paths.length - 1; i >= 0; i--) {
      const place = locate(this.canonicalPath(paths[i]), places);
      if (place) return this.moveTo(agent, place);
    }
  }

  /** A project agent starts each turn in its own folder; an agent with no project keeps its last place. */
  private seedWhereabouts(agent: Agent): void {
    if (agent.projectId === null) return;
    let root: string;
    try {
      root = fs.realpathSync(agent.worktree?.path ?? this.project(agent.projectId).path);
    } catch {
      return;
    }
    this.moveTo(agent, { root, projectId: agent.projectId, branch: agent.worktree?.branch });
  }

  private onTurnEnd(agentId: string, result: TurnResult): void {
    const agent = this.store.agents.get(agentId);
    if (!agent) return;
    // The turn may have switched branches; ask git again.
    if (agent.workingIn && !(agent.worktree && agent.workingIn.branch === agent.worktree.branch)) {
      this.moveTo(agent, { root: agent.workingIn.root, projectId: agent.workingIn.projectId }, true);
    }
    const now = Date.now();
    const task = agent.currentTask;
    agent.currentTask = null;
    const durationMs = agent.turnStartedAt ? now - agent.turnStartedAt : undefined;
    let turnCost: number | undefined;
    if (typeof result.costUsd === 'number') {
      const last = this.processCost.get(agentId) ?? 0;
      // A smaller figure means a new process started counting from zero.
      turnCost = result.costUsd >= last ? result.costUsd - last : result.costUsd;
      this.processCost.set(agentId, result.costUsd);
      agent.costUsd += turnCost;
      // The daily budget covers only what the SuperAgent does on its own: its update turns, and mail
      // about work it began itself. Your turns, and mail about work you asked for, never count.
      if (agent.role === 'super' && (task?.source === 'system' || (task?.source === 'agent' && !this.userWork(task.messageId)))) {
        this.superStore.addAutonomousCost(turnCost);
      }
    }
    if (result.tokens) agent.tokens += result.tokens;
    if (result.threadUsage) agent.threadUsage = result.threadUsage;
    const pending = result.pending ?? 0;
    const meta: TurnMeta = {
      durationMs,
      costUsd: turnCost,
      tokens: result.tokens,
      usage: result.usage,
    };
    // Before the mailbox settles the message, so a reply to the asker joins its conversation.
    this.channels.turnEnded(agentId, task, result, meta);
    this.noteForSuper(agent, task, result);
    this.mailbox.finish(agentId, result.ok && !result.stopped, result.stopped ? 'Stopped by the user.' : result.error);
    agent.queued = pending + this.mailbox.pending(agentId);
    agent.lastActiveAt = now;
    agent.turnStartedAt = pending > 0 ? now : null;
    agent.turns += 1;
    try {
      this.dreamer.turnEnded(agent);
    } catch (err) {
      console.error(`[dream] could not count ${agent.name}'s turn:`, (err as Error).message);
    }

    if (result.stopped) {
      this.addEntry(agentId, { id: randomUUID(), kind: 'system', text: 'Stopped.' });
      if (pending === 0) {
        agent.status = 'idle';
        agent.activity = '';
      }
    } else if (result.ok) {
      const summary = summarize(result.summary) || 'Finished.';
      this.addEntry(agentId, { id: randomUUID(), kind: 'done', text: summary, meta });
      if (pending === 0) {
        agent.status = 'done';
        agent.activity = '';
        agent.unread = true;
        agent.lastSummary = summary;
      }
    } else {
      this.dropApprovals(agentId);
      const error = (result.error || 'Something went wrong.').trim();
      if (/no conversation found|session.*not found/i.test(error)) {
        agent.sessionId = null;
        delete agent.context;
        delete agent.threadUsage;
      }
      this.addEntry(agentId, { id: randomUUID(), kind: 'error', text: error, meta });
      agent.error = clip(error, 300);
      if (pending === 0) {
        agent.status = 'error';
        agent.activity = 'Hit a problem';
        agent.unread = true;
      }
    }
    if (pending > 0) {
      agent.status = 'working';
      agent.activity = 'Next message';
    }
    this.emitAgent(agent);
    if (pending === 0 && !this.shuttingDown) this.scheduleIdleClose(agentId);
  }

  private scheduleIdleClose(agentId: string): void {
    this.clearIdleTimer(agentId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(agentId);
      const runner = this.runners.get(agentId);
      if (runner && !runner.busy) {
        runner.close();
        this.runners.delete(agentId);
        this.tokens.delete(agentId);
        // The agent went quiet: a good time to dream, if the gate allows.
        this.dream(agentId, 'idle');
      }
    }, this.idleProcessMs);
    timer.unref();
    this.idleTimers.set(agentId, timer);
  }

  private clearIdleTimer(agentId: string): void {
    const timer = this.idleTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(agentId);
  }

  private addEntry(agentId: string, draft: EntryDraft): void {
    const entry: Entry = { ...draft, agentId, ts: draft.ts ?? Date.now() };
    this.store.appendEntry(entry);
    this.hub.broadcast({ type: 'entry', entry });
  }

  // ---- projects ----------------------------------------------------------

  addProject(input: { name?: string; path?: string; create?: boolean }): Project {
    const rawPath = String(input.path ?? '').trim();
    if (!rawPath) throw new HttpError(400, 'Choose a folder for the project.');
    const dir = normalizeDir(rawPath);
    if (!isDirectory(dir)) {
      if (fs.existsSync(dir)) throw new HttpError(400, `${dir} is a file, not a folder.`);
      if (!input.create) throw new HttpError(400, `${dir} does not exist.`);
      fs.mkdirSync(dir, { recursive: true });
    }
    const duplicate = [...this.store.projects.values()].find((p) => p.path === dir);
    if (duplicate) throw new HttpError(409, `That folder is already open as "${duplicate.name}".`);
    const project: Project = {
      id: randomUUID(),
      name: clip(String(input.name ?? '').trim() || path.basename(dir), 40),
      path: dir,
      createdAt: Date.now(),
      exists: true,
      isGit: isInsideGitRepo(dir),
    };
    this.store.projects.set(project.id, project);
    this.store.save();
    this.hub.broadcast({ type: 'project', project });
    return project;
  }

  project(id: string): Project {
    const project = this.store.projects.get(id);
    if (!project) throw new HttpError(404, 'No project with that id.');
    return project;
  }

  renameProject(id: string, input: { name?: string }): Project {
    const project = this.project(id);
    const name = clip(String(input.name ?? '').trim(), 40);
    if (!name) throw new HttpError(400, 'Name cannot be empty.');
    project.name = name;
    this.store.save();
    this.hub.broadcast({ type: 'project', project });
    return project;
  }

  removeProject(id: string): void {
    const project = this.project(id);
    const staff = [...this.store.agents.values()].filter((a) => a.projectId === id);
    if (staff.length) throw new HttpError(409, `${staff.map((a) => a.name).join(', ')} still work on ${project.name}. Remove them first.`);
    this.store.projects.delete(id);
    this.store.save();
    this.hub.broadcast({ type: 'projectRemoved', id });
  }

  // ---- settings ----------------------------------------------------------

  updateSettings(input: Partial<Settings>): Settings {
    if (input.awareness !== undefined && !['off', 'project', 'all'].includes(input.awareness)) throw new HttpError(400, 'Choose Off, Same project or All projects.');
    for (const key of ['shareActivity', 'autoTeamContext', 'browserEval'] as const) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new HttpError(400, 'Toggles must be true or false.');
    }
    if (input.messageLimit !== undefined && (!Number.isSafeInteger(input.messageLimit) || input.messageLimit < 0)) {
      throw new HttpError(400, 'The message budget must be a whole number of zero or more.');
    }
    for (const key of ['superWake', 'superNotify'] as const) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new HttpError(400, 'Toggles must be true or false.');
    }
    if (input.superMaxCreatesPerDay !== undefined && (!Number.isSafeInteger(input.superMaxCreatesPerDay) || input.superMaxCreatesPerDay < 0 || input.superMaxCreatesPerDay > 200)) {
      throw new HttpError(400, 'Agents a day must be a whole number from 0 to 200.');
    }
    if (input.superDailyBudgetUsd !== undefined && (typeof input.superDailyBudgetUsd !== 'number' || !Number.isFinite(input.superDailyBudgetUsd) || input.superDailyBudgetUsd < 0 || input.superDailyBudgetUsd > 1000)) {
      throw new HttpError(400, 'The daily budget is dollars from 0 (no cap) to 1000.');
    }
    if (input.superMaxWakesPerHour !== undefined && (!Number.isSafeInteger(input.superMaxWakesPerHour) || input.superMaxWakesPerHour < 0 || input.superMaxWakesPerHour > 60)) {
      throw new HttpError(400, 'Wake-ups an hour must be a whole number from 0 to 60.');
    }
    for (const key of ['superQuietFrom', 'superQuietTo'] as const) {
      if (input[key] !== undefined && !validQuietTime(input[key])) throw new HttpError(400, 'Quiet hours are times like 22:00.');
    }
    const settings = this.store.settings;
    if (input.messageLimit !== undefined) settings.messageLimit = input.messageLimit;
    if (input.awareness !== undefined) settings.awareness = input.awareness;
    if (input.shareActivity !== undefined) settings.shareActivity = input.shareActivity;
    if (input.autoTeamContext !== undefined) settings.autoTeamContext = input.autoTeamContext;
    if (input.browserEval !== undefined) settings.browserEval = input.browserEval;
    for (const key of ['superWake', 'superNotify'] as const) if (input[key] !== undefined) settings[key] = input[key]!;
    if (input.superMaxWakesPerHour !== undefined) settings.superMaxWakesPerHour = input.superMaxWakesPerHour;
    if (input.superDailyBudgetUsd !== undefined) settings.superDailyBudgetUsd = input.superDailyBudgetUsd;
    if (input.superMaxCreatesPerDay !== undefined) settings.superMaxCreatesPerDay = input.superMaxCreatesPerDay;
    for (const key of ['superQuietFrom', 'superQuietTo'] as const) if (input[key] !== undefined) settings[key] = input[key]!.trim();
    this.store.save();
    this.hub.broadcast({ type: 'settings', settings });
    // Mail held for the SuperAgent may go now (wake-ups back on, a bigger budget).
    const superId = this.superId();
    if (superId) setImmediate(() => this.mailbox.drain(superId));
    return settings;
  }
}
