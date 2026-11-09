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
  type TurnMeta,
  type UserProfile,
  type Worktree,
  type WorktreeCleanup,
} from '../shared/types.ts';
import { ROLES, rolePreset } from '../shared/roles.ts';
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
import { BROWSER_TOOLS, browserInputs, COMMS_TOOLS, walkthroughInput, type BrowserTool, delegationInput, forgetInput, postInput, readChannelInput, rememberInput, replyInput, reportInput, sendInput, summaryInput, type CommsTool } from './comms/tools.ts';
import { IDLE_PROCESS_MS, PORT } from './config.ts';
import { defaultDreamEngine, Dreamer, type DreamEngine } from './dream.ts';
import { capProfile, findPromotions, ProfileStore } from './userProfile.ts';
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
  private idleProcessMs: number;
  private createRunner: (ctx: RunnerContext) => Runner;
  private models: Record<EngineKind, EngineModels> = { claude: emptyModels('claude'), codex: emptyModels('codex'), orcacode: emptyModels('orcacode') };
  /** Claude reports cost cumulatively per process; remember the last figure to get each turn's share. */
  private processCost = new Map<string, number>();
  private shuttingDown = false;

  /** The desktop app's browser, for agents' browser_* tools (server/browserBridge.ts). */
  readonly browser: BrowserBridge;

  constructor(store: Store, hub: Broadcaster, engines: Record<EngineKind, EngineInfo>, options: ManagerOptions = {}) {
    this.store = store;
    this.hub = hub;
    this.engines = engines;
    this.worktreesRoot = options.worktreesRoot ?? path.join(store.dataDir, 'worktrees');
    this.attachments = new Attachments(path.join(store.dataDir, 'attachments'));
    this.channelAttachments = new Attachments(path.join(store.dataDir, 'channel-attachments'));
    this.homes = new AgentHomes(path.join(store.dataDir, 'agents'));
    this.profile = new ProfileStore(store.dataDir);
    this.createRunner = options.createRunner ?? (ctx => createEngineRunner(ctx));
    this.idleProcessMs = options.idleProcessMs ?? IDLE_PROCESS_MS;
    this.browser = options.browser ?? new BrowserBridge();
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
        this.runnerFor(this.agent(id)).send(text, task);
      },
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

  async create(req: CreateAgentRequest): Promise<Agent> {
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
    const role = req.role ?? 'dev';
    if (!ROLES.some(r => r.id === role)) throw new HttpError(400, 'Unknown agent role.');
    const preset = rolePreset(role);
    const task = String(req.task ?? '').trim();
    if (task.length > 100_000) throw new HttpError(400, 'The first task is too long.');
    const autonomy = AUTONOMIES.includes(req.autonomy as Autonomy) ? (req.autonomy as Autonomy) : preset.autonomy;

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
    if (patch.role !== undefined && !ROLES.some(r => r.id === patch.role)) throw new HttpError(400, 'Unknown agent role.');
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
    if (typeof tool !== 'string' || !COMMS_TOOLS.includes(tool as CommsTool)) throw new HttpError(400, 'Unknown comms tool.');
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
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
        const { entry, added, entries } = this.profile.add(parsed.data.text, parsed.data.why, { agentId: agent.id, from: agent.name });
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
        if (target.agentId !== agent.id) throw new HttpError(403, 'You can only forget profile entries you saved. Ask the user to change this one in AgentsCode (Settings, About you).');
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
    if (agent.autonomy === 'readonly' && (tool === 'send_message' || tool === 'delegate_task' || (tool === 'reply' && args.expects_reply === true))) {
      throw new HttpError(403, 'Plan-only agents can reply with findings, but need the user\'s approval before sending work to teammates.');
    }
    if (tool === 'post_to_channel') {
      const parsed = postInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide a channel id or name, 1 to 10,000 characters of text, and member ids to mention.');
      const input = parsed.data;
      if (agent.autonomy === 'readonly' && input.mention_agent_ids.length) {
        throw new HttpError(403, 'Plan-only agents can post findings, but need the user\'s approval before starting teammates. Post without mentions.');
      }
      return this.channels.postAsAgent(id, input.channel, input.text, input.mention_agent_ids, input.expects_reply, input.thread_id);
    }
    if (tool === 'delegate_task') {
      const parsed = delegationInput.safeParse(args);
      if (!parsed.success) throw new HttpError(400, 'Provide a recipient, task kind, task and acceptance criteria within the tool limits.');
      const input = parsed.data;
      return this.mailbox.delegate(id, input.to_agent_id, { kind: input.kind, task: input.task, acceptanceCriteria: input.acceptance_criteria, context: input.context });
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
      return this.mailbox.send(id, parsed.data.to_agent_id, parsed.data.text, parsed.data.expects_reply);
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
    const settings = this.store.settings;
    if (input.messageLimit !== undefined) settings.messageLimit = input.messageLimit;
    if (input.awareness !== undefined) settings.awareness = input.awareness;
    if (input.shareActivity !== undefined) settings.shareActivity = input.shareActivity;
    if (input.autoTeamContext !== undefined) settings.autoTeamContext = input.autoTeamContext;
    if (input.browserEval !== undefined) settings.browserEval = input.browserEval;
    this.store.save();
    this.hub.broadcast({ type: 'settings', settings });
    return settings;
  }
}
