import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Agent, AgentTask, Autonomy, ToolCall } from '../../shared/types.ts';
import { clip } from './describe.ts';
import { systemInstructions, type Runner, type RunnerContext, type RunnerImage, type RunnerInput } from './runner.ts';
import { codexCommsConfig, COMMS_INSTRUCTIONS } from '../comms/tools.ts';

const SANDBOX: Record<Autonomy, string> = {
  readonly: 'read-only',
  ask: 'workspace-write',
  edits: 'workspace-write',
  full: 'danger-full-access',
};

const AUTH_PATTERN = /\b401\b|unauthori[sz]ed|refresh token|sign(ed)? in again|not logged in|log(ged)? in again/i;

function friendlyError(message: string): string {
  if (AUTH_PATTERN.test(message)) {
    return 'Codex is not signed in, or its login expired. Run `codex login` in a terminal, then send the message again.';
  }
  return message;
}

/** `bash -lc 'npm test'` -> `npm test` */
function unwrapShell(command: string): string {
  const match = command.match(/^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return match ? match[2] : command;
}

type Item = Record<string, unknown> & { id?: string; type?: string };

/**
 * Arguments for one `codex exec` turn. The prompt itself goes over stdin ("-") so it is never parsed as a flag.
 * Images go one `--image=<file>` each, with another flag after them, so none can swallow the session id or "-".
 */
export function codexArgs(agent: Agent, commsToken?: string, images: readonly RunnerImage[] = []): string[] {
  const sandbox = SANDBOX[agent.autonomy];
  const options = ['--json', ...images.map(image => `--image=${image.path}`), '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`];
  if (commsToken) options.push('-c', codexCommsConfig(commsToken));
  // A worktree keeps its git data in the main repo's .git, which must be writable to commit.
  if (agent.worktree && sandbox === 'workspace-write') {
    options.push('-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(agent.worktree.gitDir)}]`);
  }
  if (agent.model) options.push('-m', agent.model);
  if (agent.effort) options.push('-c', `model_reasoning_effort="${agent.effort}"`);
  return agent.sessionId ? ['exec', 'resume', ...options, agent.sessionId, '-'] : ['exec', ...options, '-'];
}

/**
 * Codex has no long-lived streaming mode in its CLI, so each turn is one
 * `codex exec --json` process; follow-ups use `codex exec resume <thread>`.
 * Messages sent while a turn runs are queued and run as the next turn.
 */
export class CodexRunner implements Runner {
  private ctx: RunnerContext;
  private child: ChildProcess | null = null;
  private queue: RunnerInput[] = [];
  private stopping = false;
  private turnEnded = false;
  private completedTokens: number | null = null;
  private turnKey = '';
  private lastMessage = '';
  private lastError = '';
  private stderrTail = '';
  private seenWarnings = new Set<string>();

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
    child?.kill('SIGTERM');
  }

  private run(input: RunnerInput): void {
    const hooks = this.ctx.hooks;
    const agent = this.ctx.agent();
    const project = this.ctx.project;
    this.turnEnded = false;
    this.completedTokens = null;
    this.stopping = false;
    this.turnKey = randomUUID().slice(0, 8);
    this.lastMessage = '';
    this.lastError = '';
    this.stderrTail = '';
    hooks.turnStart(input.task);

    if (!this.ctx.binPath) {
      this.finish({ ok: false, summary: '', error: 'The Codex CLI was not found on this machine. Install it with `npm i -g @openai/codex`.' });
      hooks.ready?.();
      return;
    }

    // Codex reads the files when the turn starts; one that is gone would fail the whole turn.
    const images = (input.images ?? []).filter(image => fs.existsSync(image.path));
    const args = codexArgs(agent, this.ctx.commsToken, images);
    const text = this.ctx.preparePrompt?.(input.text) ?? input.text;
    // A resumed thread already has the full instructions; repeat only the comms rules, whose token changed.
    const prompt = agent.sessionId
      ? `${this.ctx.commsToken ? `${COMMS_INSTRUCTIONS}\n\n` : ''}${text}`
      : `${systemInstructions(agent, project)}\n\n---\n\n${text}`;

    const child = spawn(this.ctx.binPath, args, {
      cwd: this.ctx.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    hooks.activity('Thinking');

    child.stdin?.on('error', () => {
      // the process exited before reading the prompt; the close handler reports it
    });
    child.stdin?.end(prompt);
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (this.child === child) this.handleLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-3000);
    });
    child.on('error', (err) => {
      this.lastError = err.message;
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return; // closed on purpose
      // A terminal JSON event precedes CLI teardown. Settle only after exit so a
      // late failure or Stop cannot deliver a task or launch validation early.
      if (this.stopping) this.finish({ ok: false, stopped: true, summary: '' });
      else if (code === 0 && this.completedTokens !== null && !this.lastError) {
        this.finish({ ok: true, summary: this.lastMessage, tokens: this.completedTokens });
      } else {
        const detail = this.lastError || this.relevantStderr() || (signal ? `codex exited with signal ${signal}`
          : code === 0 ? 'Codex exited without reporting turn completion.' : `codex exited with code ${code}`);
        this.finish({ ok: false, summary: '', error: friendlyError(detail) });
      }
      // Keep sends queued through turnEnd; hooks must not overtake FIFO work.
      this.child = null;
      this.stopping = false;
      const next = this.queue.shift();
      if (next !== undefined) this.run(next);
      else hooks.ready?.();
    });
  }

  private finish(result: Parameters<RunnerContext['hooks']['turnEnd']>[0]): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    this.ctx.hooks.turnEnd({ ...result, pending: this.queue.length });
  }

  private relevantStderr(): string {
    const lines = this.stderrTail.split('\n').filter((l) => l.trim() && !/rmcp::transport|codex_models_manager/.test(l));
    return clip(lines.slice(-4).join('\n'), 600);
  }

  private handleLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const hooks = this.ctx.hooks;
    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') hooks.session(event.thread_id);
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.handleItem((event.item ?? {}) as Item, event.type === 'item.completed');
        return;
      case 'turn.completed': {
        const usage = (event.usage ?? {}) as Record<string, number>;
        this.completedTokens ??= (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        return;
      }
      case 'turn.failed': {
        const message = String((event.error as { message?: string } | undefined)?.message ?? 'Codex turn failed');
        this.lastError = message;
        return;
      }
      case 'error': {
        const message = String(event.message ?? '');
        if (/^Reconnecting/i.test(message)) hooks.activity(clip(message, 44));
        else this.lastError = message;
        return;
      }
      default:
        return;
    }
  }

  private handleItem(item: Item, completed: boolean): void {
    const hooks = this.ctx.hooks;
    const id = `${this.turnKey}-${item.id ?? randomUUID()}`;
    const status = (ok: boolean): ToolCall['status'] => (!completed ? 'running' : ok ? 'ok' : 'error');

    switch (item.type) {
      case 'agent_message': {
        const text = String(item.text ?? '');
        if (completed && text.trim()) {
          this.lastMessage = text;
          hooks.entry({ id, kind: 'agent', text });
        }
        return;
      }
      case 'reasoning': {
        const heading = String(item.text ?? '').match(/\*\*(.+?)\*\*/)?.[1];
        hooks.activity(heading ? clip(heading, 44) : 'Thinking');
        return;
      }
      case 'command_execution': {
        const command = unwrapShell(String(item.command ?? ''));
        const output = String(item.aggregated_output ?? '');
        hooks.entry({
          id,
          kind: 'tool',
          text: '',
          tool: {
            name: 'Shell',
            summary: clip(command, 160),
            detail: command,
            output: output.length > 4000 ? `${output.slice(0, 4000)}\n...` : output,
            status: status(item.exit_code === 0 || (item.exit_code == null && item.status === 'completed')),
          },
        });
        if (!completed) hooks.activity(`Running ${clip(command, 32)}`);
        return;
      }
      case 'file_change': {
        const changes = (Array.isArray(item.changes) ? item.changes : []) as { path?: string; kind?: string }[];
        const first = changes[0]?.path ?? '';
        hooks.entry({
          id,
          kind: 'tool',
          text: '',
          tool: {
            name: 'Edit',
            summary: changes.map((c) => c.path).join(', '),
            detail: changes.map((c) => `${c.kind ?? 'update'}  ${c.path}`).join('\n'),
            status: status(item.status !== 'failed'),
          },
        });
        hooks.activity(`Editing ${path.basename(first)}`);
        return;
      }
      case 'mcp_tool_call': {
        const name = `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`;
        hooks.entry({ id, kind: 'tool', text: '', tool: { name, summary: name, status: status(item.status !== 'failed') } });
        hooks.activity(`Using ${clip(name, 36)}`);
        return;
      }
      case 'web_search': {
        const queryText = String(item.query ?? '');
        hooks.entry({ id, kind: 'tool', text: '', tool: { name: 'WebSearch', summary: queryText, status: status(true) } });
        hooks.activity('Searching the web');
        return;
      }
      case 'todo_list': {
        const items = (Array.isArray(item.items) ? item.items : []) as { text?: string; completed?: boolean }[];
        const done = items.filter((t) => t.completed).length;
        hooks.entry({
          id: `${this.turnKey}-plan`,
          kind: 'tool',
          text: '',
          tool: {
            name: 'Plan',
            summary: `${done}/${items.length} steps done`,
            detail: items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text ?? ''}`).join('\n'),
            status: 'ok',
          },
        });
        return;
      }
      case 'error': {
        const message = String(item.message ?? '');
        if (completed && message && !this.seenWarnings.has(message)) {
          this.seenWarnings.add(message);
          hooks.entry({ id, kind: 'system', text: clip(message, 300) });
        }
        return;
      }
      default:
        return;
    }
  }
}
