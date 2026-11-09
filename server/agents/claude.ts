import {
  query,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTask, Autonomy, Question, ToolCall, TurnUsage } from '../../shared/types.ts';
import { reservedHomeFile } from '../agentHome.ts';
import { approvalTitle, clip, resultSummary, toolActivity, toolDetail, toolResultText, toolSummary } from './describe.ts';
import { toolPaths } from '../whereabouts.ts';
import { systemInstructions, type Runner, type RunnerCommand, type RunnerContext, type RunnerImage, type RunnerInput } from './runner.ts';
import { commsMcpConfig, COMMS_TOOLS } from '../comms/tools.ts';
import { COMMS_SERVER } from '../config.ts';
import { parseCommand } from '../../shared/commands.ts';

const MODE: Record<Autonomy, PermissionMode> = {
  readonly: 'plan',
  ask: 'default',
  edits: 'acceptEdits',
  full: 'bypassPermissions',
};

/** Claude Code's file-editing tools, and the input that names the file. */
const EDIT_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

function realpath(file: string, depth = 0): string {
  try {
    return fs.realpathSync.native(file);
  } catch { /* missing, or a dangling link */ }
  try {
    // A dangling symlink: writing through it creates its target, so the target is what counts.
    if (depth < 32 && fs.lstatSync(file).isSymbolicLink()) return realpath(path.resolve(path.dirname(file), fs.readlinkSync(file)), depth + 1);
  } catch { /* not there at all */ }
  // A file about to be created: resolve its folder instead.
  const dir = path.dirname(file);
  return dir === file ? file : path.join(realpath(dir, depth + 1), path.basename(file));
}

const inside = (dir: string, file: string) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** user.md and its proposals, relative to the data dir; case-insensitive, as macOS file names are. */
const PROFILE_FILE = /^user\.(?:md(?:\.tmp)?|proposals\.json(?:\.tmp)?)$/i;

/**
 * Why an edit tool may not write this file, or null. An agent's home holds files only AgentsCode and
 * the user write (reservedHomeFile): soul.md (the user's instructions), memory.md (written only
 * through remember and forget, with the secret filter), a soul proposal, the dream records and
 * history/. Anything else there, such as notes saved before the agent had a workspace, and the
 * workspace itself, stay its own. The user profile (user.md and its proposals, in the data dir two
 * levels above every home) is shared by all agents and changes only through remember and forget. The path is resolved through symlinks and macOS's case-insensitive
 * names. The hook runs in every permission mode, Full access included, before any auto-accept.
 */
export function ownFileProblem(home: string | undefined, cwd: string, toolName: string, input: Record<string, unknown>): string | null {
  const key = EDIT_TOOLS[toolName];
  const target = key ? input[key] : undefined;
  if (!home || typeof target !== 'string' || !target) return null;
  const file = realpath(path.resolve(cwd, target));
  const homes = [...new Set([path.resolve(home), realpath(path.resolve(home))])];
  const own = homes.some(h => inside(h, file) && reservedHomeFile(path.relative(h, file)));
  if (!own && homes.some(h => PROFILE_FILE.test(path.relative(path.dirname(path.dirname(h)), file)))) {
    return 'That is the user profile, which every agent shares: change it with remember and forget (scope "user"), or ask the user to edit it in AgentsCode.';
  }
  return own
    ? 'That file is in your AgentsCode home, which only AgentsCode and the user edit: soul.md is the user\'s standing instructions, and memory changes go through the remember and forget tools. Ask the user if soul.md should change.'
    : null;
}

/** Async iterable the SDK pulls user messages from; stays open while the agent is at its desk. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(message: SDKUserMessage): void {
    if (this.ended) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiter) {
      this.waiter({ value: undefined, done: true });
      this.waiter = null;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

type UserContent = SDKUserMessage['message']['content'];
type UserBlock = Extract<UserContent, readonly unknown[]>[number];

/**
 * Attached images go before the text, as image blocks. They are read when the turn starts,
 * not when it is queued; one that can no longer be read becomes a short note instead.
 */
export function userContent(text: string, images?: RunnerImage[]): UserContent {
  if (!images?.length) return text;
  const blocks: UserBlock[] = [];
  for (const image of images) {
    try {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: fs.readFileSync(image.path).toString('base64') } });
    } catch {
      blocks.push({ type: 'text', text: '(An attached image could not be read.)' });
    }
  }
  // The API refuses empty text blocks.
  if (text.trim()) blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * One long-lived Claude Code process per agent, driven through the Agent SDK in
 * streaming-input mode. Tool permission prompts are routed to the IDE.
 */
export class ClaudeRunner implements Runner {
  private ctx: RunnerContext;
  private query: typeof query;
  private q: Query | null = null;
  private retirements = new Set<Promise<void>>();
  private retirementError: unknown;
  private input: InputQueue | null = null;
  private queue: RunnerInput[] = [];
  private turnActive = false;
  private stopping = false;
  private restartWhenIdle = false;
  private startedWithBypass = false;
  /** The extra folders the running process was started with; they are fixed for its life. */
  private startedDirs = '';
  private lastText = '';
  /** The model that answered the last main-loop request; its modelUsage entry has the window. */
  private lastModel = '';
  private stderrTail = '';
  private tools = new Map<string, ToolCall>();

  constructor(ctx: RunnerContext, queryFactory: typeof query = query) {
    this.ctx = ctx;
    this.query = queryFactory;
  }

  get busy(): boolean {
    return this.turnActive;
  }

  send(text: string, task?: AgentTask, images?: RunnerImage[]): void {
    // Keep later tasks local so task identity and team snapshots are fresh at execution time.
    if (this.turnActive) {
      this.queue.push({ text, task, images });
      return;
    }
    // A project added since the process started is not one of its folders yet. Start a fresh
    // process for this turn; the session resumes.
    if (this.q && JSON.stringify(this.directories()) !== this.startedDirs) this.shutdown();
    if (!this.q) this.start();
    this.turnActive = true;
    this.lastText = '';
    this.ctx.hooks.turnStart(task);
    // Claude Code only runs a slash command when it starts the message, so send those as typed.
    const content = parseCommand(text) && !images?.length ? text : (this.ctx.preparePrompt?.(text) ?? text);
    this.input?.push({
      type: 'user',
      message: { role: 'user', content: userContent(content, images) },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    this.queue = [];
    const q = this.q;
    if (!q || !this.turnActive) return;
    this.stopping = true;
    try {
      await q.interrupt();
    } catch {
      // the process may already be gone; the consume loop reports that
    }
    // If the CLI never reports the interrupted turn, unstick the desk anyway.
    setTimeout(() => {
      if (this.stopping && this.turnActive && this.q === q) {
        this.stopping = false;
        this.turnActive = false;
        this.ctx.hooks.turnEnd({ ok: false, stopped: true, summary: '' });
      }
    }, 8000);
  }

  async setAutonomy(autonomy: Autonomy): Promise<void> {
    if (!this.q) return; // the next start() reads the new value
    if (autonomy === 'full' && !this.startedWithBypass) {
      // Bypass has to be enabled when the process starts, so restart it (the session resumes).
      if (this.turnActive) this.restartWhenIdle = true;
      else this.shutdown();
      return;
    }
    await this.q.setPermissionMode(MODE[autonomy]);
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model || undefined);
  }

  async setEffort(effort: string): Promise<void> {
    await this.q?.applyFlagSettings({ effortLevel: (effort || null) as EffortLevel | null });
  }

  /** Claude's one tier is fast mode; it switches the running session. */
  async setServiceTier(tier: string): Promise<void> {
    await this.q?.applyFlagSettings({ fastMode: tier === 'fast' });
  }

  /** What the running session can run, as Claude Code names it, without its own built-in commands. */
  async commands(): Promise<RunnerCommand[] | undefined> {
    const q = this.q;
    if (!q) return undefined;
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3000).unref());
    const listed = await Promise.race([q.supportedCommands().catch(() => undefined), timeout]);
    return listed?.filter(c => !c.builtin).map(c => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }));
  }

  async dispose(): Promise<void> {
    this.close();
    // Include queries retired by an autonomy change before the context switch.
    await Promise.all(this.retirements);
    if (this.retirementError) throw this.retirementError;
  }

  close(): void {
    this.queue = [];
    this.turnActive = false;
    this.shutdown();
  }

  private shutdown(): void {
    const q = this.q;
    this.q = null;
    this.input?.end();
    this.input = null;
    if (q) {
      q.close();
      // SDK return() performs cleanup and waits for its subprocess exit.
      const retirement = q.return().then(() => undefined);
      this.retirements.add(retirement);
      void retirement.then(() => this.retirements.delete(retirement), error => {
        this.retirements.delete(retirement);
        this.retirementError = error;
      });
    }
  }

  private directories(): string[] {
    return this.ctx.directories?.() ?? [];
  }

  private start(): void {
    const agent = this.ctx.agent();
    const project = this.ctx.project;
    const input = new InputQueue();
    const directories = this.directories();
    this.startedDirs = JSON.stringify(directories);
    this.startedWithBypass = agent.autonomy === 'full';
    this.stderrTail = '';
    const q = this.query({
      prompt: input,
      options: {
        cwd: this.ctx.cwd,
        additionalDirectories: directories.length ? directories : undefined,
        model: agent.model || undefined,
        effort: (agent.effort || undefined) as EffortLevel | undefined,
        settings: agent.serviceTier === 'fast' ? { fastMode: true } : undefined,
        permissionMode: MODE[agent.autonomy],
        allowDangerouslySkipPermissions: this.startedWithBypass || undefined,
        canUseTool: this.canUseTool,
        // soul.md, memory.md and the dream records are off limits to edit tools in every mode.
        hooks: { PreToolUse: [{ matcher: Object.keys(EDIT_TOOLS).join('|'), hooks: [this.guardOwnFiles] }] },
        // Load CLAUDE.md, settings and plugins like a normal Claude Code session...
        settingSources: ['user', 'project', 'local'],
        // ...but skip MCP servers unless asked: they can add ~200k tokens of tool definitions.
        strictMcpConfig: !agent.useMcp,
        // The comms tools only reach the IDE, so they run without a permission prompt.
        mcpServers: this.ctx.commsToken ? { [COMMS_SERVER]: commsMcpConfig(this.ctx.commsToken) } : undefined,
        allowedTools: this.ctx.commsToken ? COMMS_TOOLS.map(name => `mcp__${COMMS_SERVER}__${name}`) : undefined,
        resume: agent.sessionId ?? undefined,
        pathToClaudeCodeExecutable: this.ctx.binPath ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.ctx.instructions?.() ?? systemInstructions(agent, project) },
        stderr: (data: string) => {
          this.stderrTail = (this.stderrTail + data).slice(-2000);
        },
      },
    });
    this.q = q;
    this.input = input;
    void this.consume(q);
  }

  private async consume(q: Query): Promise<void> {
    let error: string | undefined;
    try {
      for await (const message of q) {
        if (this.q !== q) break;
        this.handle(message);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      const tail = this.stderrTail.trim();
      if (tail && !error.includes(tail)) error = `${error}\n${clip(tail, 600)}`;
    }
    if (this.q !== q) return; // closed or replaced on purpose
    this.queue = [];
    this.q = null;
    this.input = null;
    if (this.turnActive) {
      this.turnActive = false;
      this.stopping = false;
      this.ctx.hooks.turnEnd({ ok: false, summary: '', error: error ?? 'Claude Code exited unexpectedly.' });
    }
    this.ctx.hooks.closed(error);
  }

  private handle(message: SDKMessage): void {
    const hooks = this.ctx.hooks;
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') hooks.session(message.session_id);
        else if (message.subtype === 'compact_boundary') hooks.entry({ id: message.uuid, kind: 'system', text: 'Context compacted.' });
        return;

      case 'assistant': {
        const blocks = message.message.content;
        if (message.parent_tool_use_id) {
          // Subagent traffic: only surface what it is doing.
          for (const block of blocks) {
            if (block.type !== 'tool_use') continue;
            hooks.activity(clip(`Helper: ${toolActivity(block.name, block.input as Record<string, unknown>)}`, 44));
            hooks.touched?.(toolPaths(block.name, block.input as Record<string, unknown>, this.ctx.cwd, os.homedir()));
          }
          return;
        }
        // Main loop only: a subagent's prompt is not this session's context.
        if (message.message.model) this.lastModel = message.message.model;
        const used = promptTokens(message.message.usage);
        if (used > 0) hooks.context?.({ used });
        blocks.forEach((block, i) => {
          if (block.type === 'text' && block.text.trim()) {
            this.lastText = block.text;
            hooks.entry({ id: `${message.uuid}-${i}`, kind: 'agent', text: block.text });
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const tool: ToolCall = {
              name: block.name,
              summary: toolSummary(block.name, input, this.ctx.cwd),
              detail: toolDetail(block.name, input, this.ctx.cwd),
              status: 'running',
            };
            this.tools.set(block.id, tool);
            hooks.entry({ id: block.id, kind: 'tool', text: '', tool });
            hooks.activity(toolActivity(block.name, input));
            hooks.touched?.(toolPaths(block.name, input, this.ctx.cwd, os.homedir()));
          } else if (block.type === 'thinking') {
            hooks.activity('Thinking');
          }
        });
        return;
      }

      case 'user': {
        if (message.parent_tool_use_id) return;
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const tool = this.tools.get(block.tool_use_id);
          if (!tool) continue;
          this.tools.delete(block.tool_use_id);
          const output = toolResultText(block.content);
          hooks.entry({
            id: block.tool_use_id,
            kind: 'tool',
            text: '',
            tool: { ...tool, summary: (!block.is_error && resultSummary(tool.name, output)) || tool.summary, status: block.is_error ? 'error' : 'ok', output },
          });
        }
        hooks.activity('Thinking');
        return;
      }

      case 'result': {
        // Before the guard: a turn you stopped still reports the model's window.
        const window = contextWindow(message.modelUsage, this.lastModel);
        if (window) hooks.context?.({ window });
        if (!this.turnActive) return; // already reported (forced stop)
        const pending = this.queue.length;
        const ok = message.subtype === 'success' && !message.is_error;
        const stopped = this.stopping;
        this.stopping = false;
        let error: string | undefined;
        if (!ok) error = message.subtype === 'success' ? message.result : message.errors.join('\n') || message.subtype;
        const summary = message.subtype === 'success' && !message.is_error ? message.result : '';
        this.turnActive = false;
        hooks.turnEnd({
          ok,
          stopped,
          summary: summary || this.lastText,
          error,
          costUsd: message.total_cost_usd,
          usage: claudeTurnUsage(message.usage),
          pending,
        });
        this.lastText = '';
        if (!this.turnActive && this.restartWhenIdle) {
          this.restartWhenIdle = false;
          this.shutdown();
        }
        const next = this.queue.shift();
        if (next) this.send(next.text, next.task, next.images);
        else hooks.ready?.();
        return;
      }

      default:
        return;
    }
  }

  private guardOwnFiles: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const problem = ownFileProblem(this.ctx.agent().home, this.ctx.cwd, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
    return problem ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: problem } } : {};
  };

  private canUseTool: CanUseTool = async (toolName, input, options) => {
    const hooks = this.ctx.hooks;

    if (toolName === 'AskUserQuestion') {
      const questions = (Array.isArray(input.questions) ? input.questions : []) as Question[];
      const decision = await hooks.approval(
        {
          type: 'question',
          toolName,
          title: clip(questions[0]?.question ?? 'I have a question', 60),
          detail: '',
          description: '',
          canAlwaysAllow: false,
          questions,
        },
        options.signal,
      );
      if (!decision.allow) return { behavior: 'deny', message: decision.message || 'The user dismissed the question.' };
      return { behavior: 'allow', updatedInput: { ...input, answers: decision.answers ?? {} } };
    }

    if (toolName === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : '';
      const decision = await hooks.approval(
        { type: 'plan', toolName, title: 'Plan ready', detail: '', description: '', canAlwaysAllow: false, plan },
        options.signal,
      );
      if (!decision.allow) {
        return {
          behavior: 'deny',
          message: decision.message
            ? `The user wants changes to the plan: ${decision.message}`
            : 'The user has not approved the plan yet. Keep refining it.',
        };
      }
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      };
    }

    // Full access means no prompts. Bypass mode still sends Claude Code's own safety checks
    // here, and a switch to Full access mid-turn only reaches the CLI when the turn ends, so
    // allow from the live setting. An ask rule the user wrote in their settings still asks.
    if (this.ctx.agent().autonomy === 'full' && !options.matchedAskRule) {
      return { behavior: 'allow', updatedInput: input };
    }

    const decision = await hooks.approval(
      {
        type: 'tool',
        toolName,
        title: approvalTitle(toolName, input, this.ctx.cwd),
        detail: toolDetail(toolName, input, this.ctx.cwd),
        description: options.decisionReason || options.title || options.description || '',
        canAlwaysAllow: !options.suppressAlwaysAllowRule && Boolean(options.suggestions?.length),
      },
      options.signal,
    );
    if (decision.allow) {
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: decision.always ? options.suggestions : undefined,
      };
    }
    return {
      behavior: 'deny',
      message: decision.message ? `The user denied this: ${decision.message}` : 'The user denied this action.',
    };
  };
}

/** The part of an API usage block that measures the prompt. The cache fields may be null. */
type PromptUsage = { input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };

/**
 * Tokens the last request put in the context window: fresh input plus cache writes and reads.
 * 0 when there is no usage, as on synthetic error messages, which callers skip.
 */
export function promptTokens(usage: PromptUsage | null | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

/**
 * What a turn spent, from its result's usage: the main loop's requests in this turn only (the
 * SDK sums them per turn and leaves subagents out). Undefined when the result carries none.
 */
export function claudeTurnUsage(usage: (PromptUsage & { output_tokens?: number | null }) | null | undefined): TurnUsage | undefined {
  if (!usage) return undefined;
  const turn: TurnUsage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
  return Object.values(turn).some(n => n > 0) ? turn : undefined;
}

type ModelWindow = { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number };

/**
 * The context window from a result's modelUsage: the entry for the model that answered last,
 * else the one that read the most input (the main model, not a helper). Undefined when none says.
 */
export function contextWindow(modelUsage: Record<string, ModelWindow> | null | undefined, model: string): number | undefined {
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage);
  const read = (entry: ModelWindow) => (entry.inputTokens ?? 0) + (entry.cacheReadInputTokens ?? 0) + (entry.cacheCreationInputTokens ?? 0);
  const chosen = modelUsage[model] ?? entries.map(([, entry]) => entry).sort((a, b) => read(b) - read(a))[0];
  const window = chosen?.contextWindow;
  return typeof window === 'number' && window > 0 ? window : undefined;
}
