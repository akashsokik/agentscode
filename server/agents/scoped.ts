import type { AgentTask, Autonomy } from '../../shared/types.ts';
import type { Runner, RunnerCommand, RunnerContext, RunnerHooks, RunnerImage, RunnerInput, TurnResult } from './runner.ts';

export interface ExecutionContext {
  cwd: string;
  context(hooks: RunnerHooks): RunnerContext;
}

interface ScopedOptions {
  resolve(): ExecutionContext | Promise<ExecutionContext>;
  create(context: RunnerContext): Runner;
  hooks: RunnerHooks;
  /** Expire external credentials synchronously, before provider teardown awaits. */
  retired(): void;
  cancelled(task: AgentTask | undefined, error: string): void;
}

/**
 * The single FIFO for one agent, for user and peer work alike. Provider runners receive one
 * turn at a time, in one verified cwd. Callbacks from a retired provider are ignored.
 */
export class ScopedRunner implements Runner {
  private options: ScopedOptions;
  private queue: RunnerInput[] = [];
  private child: Runner | null = null;
  private key = '';
  private generation = 0;
  private retireBeforeNextTurn = false;
  private current: RunnerInput | null = null;
  private ended = false;
  private preparing = false;
  private closed = false;
  private draining: Promise<void> | null = null;
  private resolution: Promise<ExecutionContext> | null = null;

  constructor(options: ScopedOptions) { this.options = options; }
  get accepting(): boolean { return !this.closed; }
  get busy(): boolean { return Boolean(this.current || this.preparing || this.draining || this.queue.length); }
  /** User messages waiting behind the current turn. */
  get queuedUserTasks(): number { return this.queue.filter(i => i.task?.source === 'user').length; }

  send(text: string, task?: AgentTask, images?: RunnerImage[]): void {
    if (this.closed) throw new Error('This execution queue is closed.');
    this.queue.push({ text, task: task && { ...task }, images });
    this.pump();
  }

  private pump(): void {
    if (this.closed || this.current || this.preparing || this.draining) return;
    const input = this.queue.shift();
    if (!input) { this.options.hooks.ready?.(); return; }
    this.current = input;
    this.ended = false;
    this.preparing = true;
    try {
      const execution = this.options.resolve();
      if (execution instanceof Promise) {
        this.resolution = execution;
        void execution.then(ctx => {
          if (this.resolution === execution) this.resolution = null;
          if (!this.draining) this.start(input, ctx);
        }, error => {
          if (this.resolution === execution) this.resolution = null;
          if (!this.draining) this.fail(input, error);
        });
      } else this.start(input, execution);
    } catch (error) { this.fail(input, error); }
  }

  private start(input: RunnerInput, execution: ExecutionContext): void {
    if (this.current !== input || this.closed) return;
    const key = execution.cwd;
    if (this.child && (this.key !== key || this.retireBeforeNextTurn)) {
      this.retireBeforeNextTurn = false;
      const closing = this.detach();
      this.draining = closing;
      void closing.then(() => {
        const ownsSwitch = this.draining === closing;
        if (ownsSwitch) this.draining = null;
        // Resolve again after teardown: the filesystem may have changed.
        if (ownsSwitch && this.current === input && !this.closed) {
          this.current = null; this.preparing = false; this.queue.unshift(input); this.pump();
        }
      }, error => {
        this.closed = true;
        for (const queued of this.queue) this.options.cancelled(queued.task, 'The previous provider could not be closed.');
        this.queue = [];
        this.fail(input, error);
      });
      return;
    }
    try {
      if (!this.child) {
        this.retireBeforeNextTurn = false;
        const generation = ++this.generation;
        const live = () => generation === this.generation && !this.closed;
        const hooks = this.options.hooks;
        this.child = this.options.create(execution.context({
          session: id => { if (live()) hooks.session(id); },
          entry: entry => { if (live() && this.current && !this.ended) hooks.entry(entry); },
          activity: text => { if (live() && this.current && !this.ended) hooks.activity(text); },
          turnStart: task => { if (live()) hooks.turnStart(task); },
          turnEnd: result => { if (live()) this.finish(result); },
          context: reading => { if (live()) hooks.context?.(reading); },
          ready: () => {
            if (!live()) return;
            this.current = null; this.preparing = false; this.pump();
          },
          approval: (request, signal) => live() && this.current && !this.ended
            ? hooks.approval(request, signal) : Promise.resolve({ allow: false, message: 'Execution expired.' }),
          closed: error => {
            if (!live()) return;
            this.child = null; this.key = ''; ++this.generation;
            this.options.retired();
            const reason = error ?? 'The session closed before queued work could run.';
            for (const queued of this.queue) this.options.cancelled(queued.task, `The session closed: ${reason}`);
            this.queue = [];
            if (this.current && !this.ended) this.finish({ ok: false, summary: '', error: reason });
            this.current = null; this.preparing = false;
            this.closed = true;
            hooks.closed(error);
          },
        }));
        this.key = key;
      }
      this.preparing = false;
      this.child.send(input.text, input.task, input.images);
    } catch (error) { this.fail(input, error); }
  }

  private finish(result: TurnResult): void {
    if (!this.current || this.ended) return;
    this.ended = true;
    this.options.hooks.turnEnd({ ...result, pending: this.queuedUserTasks });
  }

  private fail(input: RunnerInput, error: unknown): void {
    if (this.current !== input) return;
    this.preparing = false;
    this.options.hooks.turnStart(input.task);
    this.finish({ ok: false, summary: '', error: error instanceof Error ? error.message : String(error) });
    this.current = null;
    this.pump();
  }

  private detach(): Promise<void> {
    const child = this.child;
    this.child = null; this.key = ''; ++this.generation;
    this.options.retired();
    if (!child) return Promise.resolve();
    if (child.dispose) return child.dispose();
    child.close(); // injected synchronous test runners have no subprocess
    return Promise.resolve();
  }

  private async cancelCurrent(reason: string): Promise<void> {
    const input = this.current;
    const ended = this.ended;
    if (input && this.preparing && !ended) this.options.hooks.turnStart(input.task);
    const previous = this.draining;
    const closing = Promise.all([previous, this.detach(), this.resolution?.catch(() => undefined)]).then(() => undefined);
    this.draining = closing;
    this.preparing = false;
    try {
      await closing;
      if (input && !ended && this.current === input && !this.closed) this.finish({ ok: false, stopped: true, summary: '', error: reason });
    } finally {
      if (this.current === input) this.current = null;
      if (this.draining === closing) this.draining = null;
    }
  }

  async interrupt(): Promise<void> {
    for (const input of this.queue) this.options.cancelled(input.task, 'Stopped by the user.');
    this.queue = [];
    await this.cancelCurrent('Stopped by the user.');
    this.pump();
  }

  async setAutonomy(value: Autonomy): Promise<void> {
    if (value === 'full') {
      // Startup-only permissions need a new provider process. Keep the current
      // turn, then retire the provider before the next one.
      this.retireBeforeNextTurn = true;
      return;
    }
    await this.child?.setAutonomy(value);
  }
  async setModel(value: string): Promise<void> { await this.child?.setModel(value); }
  async setEffort(value: string): Promise<void> { await this.child?.setEffort(value); }
  async commands(): Promise<RunnerCommand[] | undefined> { return this.child?.commands?.(); }
  close(): void { this.closed = true; void this.interrupt(); }
  async dispose(): Promise<void> { this.closed = true; await this.interrupt(); }
}
