import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_AGENTS,
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
  type EngineInfo,
  type EngineKind,
  type EngineModels,
  type Entry,
  type ImageAttachment,
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
import type { EntryDraft, Runner, RunnerContext, RunnerHooks, RunnerImage, TurnResult } from './agents/runner.ts';
import { Attachments } from './attachments.ts';
import { ScopedRunner, type ExecutionContext } from './agents/scoped.ts';
import { Channels } from './comms/channels.ts';
import { Mailbox } from './comms/mailbox.ts';
import { COMMS_TOOLS, delegationInput, postInput, readChannelInput, replyInput, reportInput, sendInput, summaryInput, type CommsTool } from './comms/tools.ts';
import { IDLE_PROCESS_MS } from './config.ts';
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
    this.createRunner = options.createRunner ?? (ctx => ctx.agent().engine === 'claude' ? new ClaudeRunner(ctx) : new CodexRunner(ctx));
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
      startUserTask: (agentId, text, prompt, task, channel) => this.startUserTask(agentId, text, prompt, task, channel),
    });
  }

  /** Nothing is running after a restart; settle agents that were mid-turn. */
  init(): void {
    this.mailbox.recover();
    this.channels.recover();
    for (const agent of this.store.agents.values()) {
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
    const project = this.store.projects.get(req.projectId);
    if (!project) throw new HttpError(400, 'Pick a project for this agent.');
    if (!isDirectory(project.path)) throw new HttpError(400, `The project folder ${project.path} does not exist.`);
    if (this.store.agents.size >= MAX_AGENTS) throw new HttpError(400, `AgentsCode runs at most ${MAX_AGENTS} agents.`);
    const name = this.agentName(req.name);
    const role = req.role ?? 'dev';
    if (!ROLES.some(r => r.id === role)) throw new HttpError(400, 'Unknown agent role.');
    const preset = rolePreset(role);
    const task = String(req.task ?? '').trim();
    if (task.length > 100_000) throw new HttpError(400, 'The first task is too long.');
    const autonomy = AUTONOMIES.includes(req.autonomy as Autonomy) ? (req.autonomy as Autonomy) : preset.autonomy;

    // Last fallible step before the agent exists, so a failure leaves nothing behind.
    let worktree: Worktree | null = null;
    if (req.worktree) worktree = await createWorktree(project.path, name, req.branch, this.worktreesRoot);
    try {
      this.agentName(name);
    } catch (error) {
      if (worktree) await removeWorktree(worktree, true).catch(() => {});
      throw error;
    }

    const now = Date.now();
    const agent: Agent = {
      id: randomUUID(),
      name,
      engine,
      projectId: project.id,
      worktree,
      model: clip(String(req.model ?? '').trim(), 80),
      effort: validEffort(req.effort),
      autonomy,
      useMcp: engine === 'claude' && Boolean(req.useMcp),
      role,
      instructions: String(req.instructions ?? preset.instructions).trim().slice(0, 4000),
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
    this.store.agents.set(agent.id, agent);
    this.addEntry(agent.id, {
      id: randomUUID(),
      kind: 'system',
      sessionStart: true,
      text: worktree
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
    const model = patch.model === undefined ? undefined : clip(String(patch.model).trim(), 80);
    const effort = patch.effort === undefined ? undefined : validEffort(patch.effort);
    const runner = this.runners.get(id);
    if (name !== undefined) agent.name = name;
    if (patch.instructions !== undefined) agent.instructions = String(patch.instructions).trim().slice(0, 4000);
    if (patch.role !== undefined) agent.role = patch.role;
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

  /** The folder an agent works in: its worktree, or its project. */
  workspaceOf(id: string): { root: string; baseCommit?: string } {
    const agent = this.agent(id);
    const root = agent.worktree?.cwd ?? this.project(agent.projectId).path;
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
  removeChannel(id: string): void { this.channels.remove(id); }
  channelPosts(id: string): ChannelPost[] { return this.channels.posts(id); }
  postToChannel(id: string, text: unknown, mentions: unknown, threadId?: unknown): ChannelPost { return this.channels.postAsUser(id, text, mentions, threadId); }
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

  private execution(agentId: string): ExecutionContext {
    const agent = this.agent(agentId);
    const project = this.project(agent.projectId);
    const cwd = canonicalDirectory(agent.worktree?.cwd ?? project.path);
    return {
      cwd,
      context: hooks => {
        const commsToken = randomUUID() + randomUUID();
        this.tokens.set(agentId, commsToken);
        return {
          agent: () => this.agent(agentId),
          project: { ...project, path: canonicalDirectory(project.path) },
          cwd,
          binPath: this.engines[agent.engine].path,
          commsToken,
          preparePrompt: text => this.mailbox.preparePrompt(agentId, text),
          hooks,
        };
      },
    };
  }

  private hooksFor(agentId: string): RunnerHooks {
    const live = () => this.store.agents.get(agentId);
    return {
      session: (sessionId) => {
        const agent = live();
        if (!agent) return;
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
      }
    }, IDLE_PROCESS_MS);
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
