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
  type EngineInfo,
  type EngineKind,
  type EngineModels,
  type Entry,
  type ImageAttachment,
  type MemoryEntry,
  type MemoryPatch,
  type PeerMessage,
  type Project,
  type Settings,
  type Snapshot,
  type TurnMeta,
  type Worktree,
  type WorktreeCleanup,
} from '../shared/types.ts';
import { ROLES, rolePreset } from '../shared/roles.ts';
import { isIdeCommand } from '../shared/commands.ts';
import { injectSkillPrompt, skillNamesInText, type ComposerCommand } from '../shared/composer.ts';
import { commandBody, commandsFor, type DiscoveredCommand } from './skills.ts';
import { dropContextWindow, mergeContextUsage, sameContextUsage } from '../shared/contextUsage.ts';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import { clip } from './agents/describe.ts';
import {
  agentContext, CONTEXT_SECTIONS, contextSections, fullContext, memorySection, refreshedContext, systemInstructions,
  type ContextSection, type EntryDraft, type PromptContext, type Runner, type RunnerContext, type RunnerHooks, type RunnerImage, type TurnResult,
} from './agents/runner.ts';
import { AgentHomes, capMemory, MEMORY_TEXT_LIMIT, MEMORY_WHY_LIMIT, SOUL_LIMIT, workspacePath } from './agentHome.ts';
import { Attachments } from './attachments.ts';
import { ScopedRunner, type ExecutionContext } from './agents/scoped.ts';
import { Channels } from './comms/channels.ts';
import { Mailbox } from './comms/mailbox.ts';
import { COMMS_TOOLS, delegationInput, forgetInput, postInput, readChannelInput, rememberInput, replyInput, reportInput, sendInput, summaryInput, type CommsTool } from './comms/tools.ts';
import { IDLE_PROCESS_MS } from './config.ts';
import { defaultDreamEngine, Dreamer, type DreamEngine } from './dream.ts';
import { HttpError } from './errors.ts';
import type { Broadcaster } from './hub.ts';
import { discoverClaudeModels, discoverCodexModels, emptyModels } from './models.ts';
import { isDirectory, isInsideGitRepo, normalizeDir } from './projects.ts';
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
  private idleProcessMs: number;
  private createRunner: (ctx: RunnerContext) => Runner;
  private models: Record<EngineKind, EngineModels> = { claude: emptyModels('claude'), codex: emptyModels('codex') };
  /** Claude reports cost cumulatively per process; remember the last figure to get each turn's share. */
  private processCost = new Map<string, number>();
  private shuttingDown = false;

  constructor(store: Store, hub: Broadcaster, engines: Record<EngineKind, EngineInfo>, options: ManagerOptions = {}) {
    this.store = store;
    this.hub = hub;
    this.engines = engines;
    this.worktreesRoot = options.worktreesRoot ?? path.join(store.dataDir, 'worktrees');
    this.attachments = new Attachments(path.join(store.dataDir, 'attachments'));
    this.channelAttachments = new Attachments(path.join(store.dataDir, 'channel-attachments'));
    this.homes = new AgentHomes(path.join(store.dataDir, 'agents'));
    this.createRunner = options.createRunner ?? (ctx => ctx.agent().engine === 'claude' ? new ClaudeRunner(ctx) : new CodexRunner(ctx));
    this.idleProcessMs = options.idleProcessMs ?? IDLE_PROCESS_MS;
    this.dreamer = new Dreamer({
      homes: this.homes,
      agent: id => this.store.agents.get(id),
      entries: id => this.store.readEntries(id, 5000),
      busy: id => {
        const agent = this.store.agents.get(id);
        return Boolean(this.runners.get(id)?.busy) || agent?.status === 'working' || agent?.status === 'waiting';
      },
      engine: options.dreamEngine ?? defaultDreamEngine({ claude: engines.claude.path, codex: engines.codex.path }),
      broadcast: event => this.hub.broadcast(event),
      note: (agentId, text) => this.addEntry(agentId, { id: randomUUID(), kind: 'system', text }),
      memoryChanged: (agent, entries) => this.publishMemory(agent.id, entries),
      soulChanged: (agent, soul) => {
        agent.instructions = soul;
        this.emitAgent(agent);
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
    };
  }

  /** Ask both CLIs for their model lists; each engine updates independently. */
  async refreshModels(): Promise<Record<EngineKind, EngineModels>> {
    const discover = async (engine: EngineKind) => {
      if (!this.engines[engine].available) return;
      try {
        const found = engine === 'claude' ? await discoverClaudeModels(this.engines.claude.path) : await discoverCodexModels(this.engines.codex.path);
        this.models = { ...this.models, [engine]: found };
        this.hub.broadcast({ type: 'models', models: this.models });
      } catch (err) {
        console.error(`[models] could not list ${engine} models:`, (err as Error).message);
      }
    };
    await Promise.all([discover('claude'), discover('codex')]);
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
    if (engine !== 'claude' && engine !== 'codex') throw new HttpError(400, 'Pick Claude Code or Codex.');
    if (!this.engines[engine].available) throw new HttpError(400, `${engine === 'claude' ? 'Claude Code' : 'Codex'} is not installed on this machine.`);
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
      model: clip(String(req.model ?? '').trim(), 80),
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
    const model = patch.model === undefined ? undefined : clip(String(patch.model).trim(), 80);
    const effort = patch.effort === undefined ? undefined : validEffort(patch.effort);
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
   * Codex does not run skills itself, so a message naming one with /name carries the skill's
   * instructions to it (MonoCode's injectSkillPrompt). Claude Code runs them as typed.
   */
  private withSkills(id: string, text: string): string {
    const agent = this.agent(id);
    if (agent.engine !== 'codex' || !text.includes('/')) return text;
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
   * folder already existed does not matter. Codex threads resume from any folder. Files the agent saved
   * before stay in its home, where it can still edit them (only AgentsCode's own files are guarded).
   */
  private moveToWorkspace(agent: Agent): void {
    const workspace = fs.realpathSync(this.homes.workspace(agent));
    if (agent.engine !== 'claude' || !agent.sessionId || agent.sessionCwd === workspace) return;
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
      if (!parsed.success) throw new HttpError(400, `Say what to remember in 1 to ${MEMORY_TEXT_LIMIT} characters, with an optional why of up to ${MEMORY_WHY_LIMIT}.`);
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
      if (!parsed.success) throw new HttpError(400, 'Give the id of the memory entry to forget.');
      const before = this.homes.memory(agent);
      const { entry, entries } = this.homes.forget(agent, parsed.data.id);
      this.publishMemory(agent.id, entries);
      this.sawOwnMemory(agent, before, entries);
      return { forgot: entry };
    }
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
            const changed = CONTEXT_SECTIONS.filter(name => seen[name] !== keys[name]);
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
    return {
      memory: entries,
      memoryOmitted: omitted,
      projects: agent.projectId === null ? this.projectFolders() : undefined,
    };
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

  private onTurnEnd(agentId: string, result: TurnResult): void {
    const agent = this.store.agents.get(agentId);
    if (!agent) return;
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
    for (const key of ['shareActivity', 'autoTeamContext'] as const) {
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
    this.store.save();
    this.hub.broadcast({ type: 'settings', settings });
    return settings;
  }
}
