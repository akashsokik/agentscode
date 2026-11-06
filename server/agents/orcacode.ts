import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Agent, AgentTask, Autonomy, TurnUsage } from '../../shared/types.ts';
import { usageTotal } from '../../shared/turnUsage.ts';
import { approvalTitle, clip, toolActivity, toolDetail, toolSummary } from './describe.ts';
import { systemInstructions, type Runner, type RunnerContext, type RunnerImage, type RunnerInput, type TurnResult } from './runner.ts';
import { commsMcpConfig, COMMS_INSTRUCTIONS } from '../comms/tools.ts';
import { COMMS_SERVER } from '../config.ts';
import { orcacodeContextWindow } from '../models.ts';

type Input = Record<string, unknown>;
type Event = Record<string, unknown> & { type?: string };

/** Model invocations per turn. OrcaCode's own default (48) ends ordinary coding turns early. */
export const ORCACODE_MAX_STEPS = 400;

/**
 * How each autonomy maps onto OrcaCode's headless modes. OrcaCode has no OS sandbox: these are
 * tool gates, and "full" (--yolo) runs every tool unconfined.
 * - readonly: --read-only; shell runs only when the user approves each command.
 * - ask: normal mode; every gated tool asks the user over --approvals stdio.
 * - edits: --auto; OrcaCode's own reviewer admits edits and judges risky actions.
 * - full: --yolo.
 */
const MODE_FLAGS: Record<Autonomy, string[]> = {
  readonly: ['--read-only', '--approvals', 'stdio'],
  ask: ['--approvals', 'stdio'],
  edits: ['--auto'],
  full: ['--yolo'],
};

/** OrcaCode keeps MCP tools hidden until the model selects them, so the comms rules say how. */
export const ORCACODE_COMMS_NOTE = `In OrcaCode, MCP tools are selected before use: call mcp_select_tool with {"name":"mcp__${COMMS_SERVER}__<tool>"} (for example mcp__${COMMS_SERVER}__list_agents), then call that tool.`;

const AUTH_PATTERN = /\b401\b|unauthori[sz]ed|api key|not (signed|logged) in|login|refresh token/i;

function friendlyError(message: string): string {
  if (AUTH_PATTERN.test(message)) {
    return `OrcaCode could not authenticate with its model provider. Run \`orcacode\` in a terminal and check /provider or /settings, then send the message again. (${clip(message, 200)})`;
  }
  return message;
}

/** Arguments for one headless `orcacode` turn. The prompt and MCP config are files, never argv. */
export function orcacodeArgs(agent: Agent, files: { prompt: string; mcp?: string }, images: readonly RunnerImage[] = []): string[] {
  const args = ['--json', '--prompt-file', files.prompt, '--max-steps', String(ORCACODE_MAX_STEPS), ...MODE_FLAGS[agent.autonomy]];
  if (files.mcp) args.push('--mcp-config', files.mcp);
  for (const image of images) args.push('--image', image.path);
  if (agent.model) args.push('--model', agent.model);
  if (agent.effort) args.push('--effort', agent.effort);
  if (agent.sessionId) args.push('--resume', agent.sessionId);
  return args;
}

/** The comms server for one OrcaCode process, in --mcp-config's shape. */
export function orcacodeMcpConfig(token: string): string {
  return JSON.stringify({ [COMMS_SERVER]: commsMcpConfig(token) });
}

/** A turn's usage from OrcaCode's camelCase totals (its summary covers this process, so this turn). */
export function orcacodeUsage(usage: unknown): TurnUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const count = (key: string) => (typeof u[key] === 'number' && Number.isFinite(u[key]) && (u[key] as number) > 0 ? (u[key] as number) : 0);
  return {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cacheReadTokens: count('cacheReadTokens'),
    cacheWriteTokens: count('cacheCreateTokens'),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * OrcaCode's tool calls under the names the transcript already describes (Claude Code's), with
 * their inputs renamed to match. Tools it has no counterpart for keep their own name.
 */
export function normalizeTool(name: string, input: Input): { name: string; input: Input } {
  switch (name) {
    case 'shell':
      return { name: 'Bash', input: { command: str(input.command) } };
    case 'read_file':
      return { name: 'Read', input: { file_path: str(input.path) } };
    case 'write_file':
      return { name: 'Write', input: { file_path: str(input.path), content: str(input.content) } };
    case 'edit_file':
    case 'multi_edit':
    case 'apply_patch': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      if (edits.length) {
        return {
          name: 'MultiEdit',
          input: { file_path: str(input.path) || str(edits[0]?.path), edits: edits.map(e => ({ old_string: str(e.old), new_string: str(e.new) || str(e.content) })) },
        };
      }
      if (name === 'apply_patch') return { name: 'Edit', input: { file_path: str(input.path), old_string: '', new_string: str(input.patch) || str(input.input) } };
      return { name: 'Edit', input: { file_path: str(input.path), old_string: str(input.old), new_string: str(input.new) } };
    }
    case 'grep':
      return { name: 'Grep', input: { pattern: str(input.query), path: input.path } };
    case 'glob':
      return { name: 'Glob', input: { pattern: str(input.pattern), path: input.path } };
    case 'web_fetch':
      return { name: 'WebFetch', input: { url: str(input.url) } };
    case 'web_search':
      return { name: 'WebSearch', input: { query: str(input.query) } };
    case 'subagent':
      return { name: 'Agent', input: { description: str(input.description) || str(input.task) || str(input.name), prompt: str(input.prompt) || str(input.task) } };
    default:
      return { name, input };
  }
}

function outputText(output: unknown): string {
  const text = typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
}

/**
 * OrcaCode has no long-lived streaming mode, so each turn is one headless
 * `orcacode --json` process; follow-ups pass `--resume <sessionId>` from the turn's metadata.
 * Approvals travel over stdin as JSON lines. Messages sent while a turn runs are queued.
 */
export class OrcacodeRunner implements Runner {
  private ctx: RunnerContext;
  private child: ChildProcess | null = null;
  private queue: RunnerInput[] = [];
  private stopping = false;
  private turnEnded = false;
  private tempDir: string | null = null;
  private approvals: AbortController | null = null;
  private calls = new Map<string, { name: string; input: Input }>();
  private summary: Event | null = null;
  private turnKey = '';
  private lastMessage = '';
  private lastError = '';
  private stderrTail = '';

  constructor(ctx: RunnerContext) {
    this.ctx = ctx;
  }

  get busy(): boolean {
    return this.child !== null;
  }

  send(text: string, task?: AgentTask, images?: RunnerImage[]): void {
    if (this.child) this.queue.push({ text, task, images });
    else this.run({ text, task, images });
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.queue = [];
    this.approvals?.abort();
    child.kill('SIGINT');
    const killTimer = setTimeout(() => {
      if (this.child === child) child.kill('SIGKILL');
    }, 4000);
    child.once('close', () => clearTimeout(killTimer));
  }

  async setAutonomy(): Promise<void> {
    // read from the agent at the start of every turn
  }

  async setModel(): Promise<void> {
    // read from the agent at the start of every turn
  }

  async setEffort(): Promise<void> {
    // read from the agent at the start of every turn
  }

  async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    this.queue = [];
    this.stopping = true;
    this.approvals?.abort();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  close(): void {
    this.queue = [];
    const child = this.child;
    this.child = null;
    this.approvals?.abort();
    child?.kill('SIGTERM');
    this.cleanup();
  }

  private cleanup(): void {
    if (this.tempDir) fs.rmSync(this.tempDir, { recursive: true, force: true });
    this.tempDir = null;
  }

  private run(input: RunnerInput): void {
    const hooks = this.ctx.hooks;
    const agent = this.ctx.agent();
    const project = this.ctx.project;
    this.turnEnded = false;
    this.stopping = false;
    this.summary = null;
    this.calls.clear();
    this.turnKey = randomUUID().slice(0, 8);
    this.lastMessage = '';
    this.lastError = '';
    this.stderrTail = '';
    hooks.turnStart(input.task);

    if (!this.ctx.binPath) {
      this.finish({ ok: false, summary: '', error: 'The OrcaCode CLI was not found on this machine. Install it with `curl -fsSL https://orcapods.ai/orcacode.sh | sh`.' });
      hooks.ready?.();
      return;
    }

    // A new session gets the full instructions first, as with Codex; a resumed one only the comms
    // rules (their token changed) and whatever preparePrompt says changed since.
    const instructions = agent.sessionId ? null : (this.ctx.instructions?.() ?? systemInstructions(agent, project));
    const text = this.ctx.preparePrompt?.(input.text) ?? input.text;
    const comms = this.ctx.commsToken ? `${COMMS_INSTRUCTIONS}\n${ORCACODE_COMMS_NOTE}` : '';
    const prompt = instructions === null
      ? `${comms ? `${comms}\n\n` : ''}${text}`
      : `${instructions}${comms ? `\n${ORCACODE_COMMS_NOTE}` : ''}\n\n---\n\n${text}`;

    // The prompt and the MCP config (it holds the comms token) go in a private folder, not argv.
    this.cleanup();
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentscode-orcacode-'));
    const files = { prompt: path.join(this.tempDir, 'prompt.md'), mcp: this.ctx.commsToken ? path.join(this.tempDir, 'mcp.json') : undefined };
    fs.writeFileSync(files.prompt, prompt, { mode: 0o600 });
    if (files.mcp) fs.writeFileSync(files.mcp, orcacodeMcpConfig(this.ctx.commsToken!), { mode: 0o600 });
    const images = (input.images ?? []).filter(image => fs.existsSync(image.path));
    const args = orcacodeArgs(agent, files, images);
    const asks = args.includes('stdio');

    const child = spawn(this.ctx.binPath, args, {
      cwd: this.ctx.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: [asks ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.approvals = new AbortController();
    hooks.activity('Thinking');

    child.stdin?.on('error', () => {
      // the process exited before reading a decision; the close handler reports it
    });
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (this.child === child) this.handleLine(line, child);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-3000);
    });
    child.on('error', (err) => {
      this.lastError = err.message;
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return; // closed on purpose
      this.approvals?.abort();
      const status = str(this.summary?.status);
      if (this.stopping || status === 'cancelled') {
        this.finish({ ok: false, stopped: true, summary: '' });
      } else {
        const usage = orcacodeUsage(this.summary?.usage);
        const cost = (this.summary?.usage as { cost?: unknown } | undefined)?.cost;
        const spent = { tokens: usage && usageTotal(usage), usage, costUsd: typeof cost === 'number' ? cost : undefined };
        if (code === 0 && status === 'success') {
          this.finish({ ok: true, summary: this.lastMessage, ...spent });
        } else {
          const detail = status === 'max_steps'
            ? `OrcaCode stopped after ${ORCACODE_MAX_STEPS} model steps without finishing. Send a message to let it continue.`
            : this.lastError || this.relevantStderr() || (signal ? `orcacode exited with signal ${signal}`
              : code === 0 ? 'OrcaCode exited without reporting a result.' : `orcacode exited with code ${code}`);
          this.finish({ ok: false, summary: this.lastMessage, error: friendlyError(detail), ...spent });
        }
      }
      this.child = null;
      this.stopping = false;
      this.cleanup();
      const next = this.queue.shift();
      if (next !== undefined) this.run(next);
      else hooks.ready?.();
    });
  }

  private finish(result: TurnResult): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    this.ctx.hooks.turnEnd({ ...result, pending: this.queue.length });
  }

  private relevantStderr(): string {
    const lines = this.stderrTail.split('\n').filter((l) => l.trim() && !/^\s*(warning|mcp|skills?|plugin)/i.test(l));
    return clip(lines.slice(-4).join('\n'), 600);
  }

  private handleLine(line: string, child: ChildProcess): void {
    let event: Event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const hooks = this.ctx.hooks;
    switch (event.type) {
      case 'metadata': {
        if (typeof event.sessionId === 'string' && event.sessionId) hooks.session(event.sessionId);
        const window = orcacodeContextWindow(str(event.model));
        if (window) hooks.context?.({ window });
        return;
      }
      case 'reasoning_delta':
        hooks.activity('Thinking');
        return;
      case 'assistant': {
        const text = str(event.message);
        if (text.trim()) {
          this.lastMessage = text;
          hooks.entry({ id: `${this.turnKey}-${randomUUID().slice(0, 8)}`, kind: 'agent', text });
        }
        return;
      }
      case 'tool_call': {
        const id = str(event.tool_call_id) || randomUUID();
        const tool = normalizeTool(str(event.tool_name), (event.input && typeof event.input === 'object' ? event.input : {}) as Input);
        this.calls.set(id, tool);
        this.toolEntry(id, tool, 'running');
        hooks.activity(clip(toolActivity(tool.name, tool.input), 44));
        return;
      }
      case 'tool_result': {
        const id = str(event.tool_call_id);
        const tool = this.calls.get(id) ?? normalizeTool(str(event.tool_name), {});
        this.toolEntry(id || randomUUID(), tool, event.is_error ? 'error' : 'ok', outputText(event.output));
        return;
      }
      case 'usage': {
        const usage = orcacodeUsage(event.usage);
        // The size of the last prompt: fresh input plus what was read from or written to the cache.
        if (usage) hooks.context?.({ used: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens });
        return;
      }
      case 'result':
        if (str(event.message).trim()) this.lastMessage = str(event.message);
        return;
      case 'error':
        this.lastError = str(event.message) || 'OrcaCode reported an error.';
        return;
      case 'approval_request':
        void this.answer(event, child);
        return;
      case 'summary':
        this.summary = event;
        if (typeof event.sessionId === 'string' && event.sessionId && event.sessionId !== this.ctx.agent().sessionId) hooks.session(event.sessionId);
        return;
      default:
        return;
    }
  }

  private toolEntry(id: string, tool: { name: string; input: Input }, status: 'running' | 'ok' | 'error', output?: string): void {
    this.ctx.hooks.entry({
      id: `${this.turnKey}-${id}`,
      kind: 'tool',
      text: '',
      tool: {
        name: tool.name,
        summary: toolSummary(tool.name, tool.input, this.ctx.cwd),
        detail: toolDetail(tool.name, tool.input, this.ctx.cwd),
        ...(output !== undefined ? { output } : {}),
        status,
      },
    });
  }

  /** Ask the user about one gated tool call and write the decision to the process's stdin. */
  private async answer(event: Event, child: ChildProcess): Promise<void> {
    const id = str(event.id);
    if (!id) return;
    const signal = this.approvals?.signal;
    if (!signal || signal.aborted) return;
    const tool = normalizeTool(str(event.tool_name), (event.input && typeof event.input === 'object' ? event.input : {}) as Input);
    const readOnlyShell = this.ctx.agent().autonomy === 'readonly' && tool.name === 'Bash';
    const write = (decision: 'allow' | 'deny' | 'always') => {
      if (this.child === child && child.stdin?.writable) child.stdin.write(`${JSON.stringify({ type: 'approval', id, decision })}\n`);
    };
    this.ctx.hooks.activity('Waiting for approval');
    try {
      const decision = await this.ctx.hooks.approval(
        {
          type: 'tool',
          toolName: tool.name,
          title: approvalTitle(tool.name, tool.input, this.ctx.cwd),
          detail: toolDetail(tool.name, tool.input, this.ctx.cwd),
          description: readOnlyShell ? 'Read-only: OrcaCode asks before every shell command.' : '',
          // OrcaCode never applies "always" to a read-only shell, so do not offer it there.
          canAlwaysAllow: !readOnlyShell,
        },
        signal,
      );
      write(decision.allow ? (decision.always && !readOnlyShell ? 'always' : 'allow') : 'deny');
    } catch {
      write('deny');
    }
  }
}
