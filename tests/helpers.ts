import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTask, Autonomy, EngineInfo, EngineKind, ServerEvent } from '../shared/types.ts';
import type { Runner, RunnerContext, RunnerImage } from '../server/agents/runner.ts';
import type { DreamEngine, DreamEngineRequest } from '../server/dream.ts';
import { AgentManager } from '../server/manager.ts';
import { Store } from '../server/store.ts';

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentscode-${prefix}-`));
}

export const tick = () => new Promise<void>(resolve => setImmediate(resolve));

export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}

/** A provider stand-in: one turn at a time, completed by the test. */
export class FakeRunner implements Runner {
  ctx: RunnerContext;
  busy = false;
  sent: { text: string; task?: AgentTask; images?: RunnerImage[] }[] = [];
  closed = false;

  constructor(ctx: RunnerContext) {
    this.ctx = ctx;
  }

  send(text: string, task?: AgentTask, images?: RunnerImage[]): void {
    this.busy = true;
    this.sent.push({ text, task, images });
    this.ctx.hooks.turnStart(task);
  }

  complete(ok = true, summary = 'Finished the work.'): void {
    if (!this.busy) throw new Error('No turn is running.');
    this.busy = false;
    this.ctx.hooks.turnEnd(ok ? { ok, summary } : { ok, summary: '', error: summary });
    this.ctx.hooks.ready?.();
  }

  async interrupt(): Promise<void> {
    if (!this.busy) return;
    this.busy = false;
    this.ctx.hooks.turnEnd({ ok: false, stopped: true, summary: '' });
    this.ctx.hooks.ready?.();
  }

  async setAutonomy(_autonomy: Autonomy): Promise<void> {}
  async setModel(_model: string): Promise<void> {}
  async setEffort(_effort: string): Promise<void> {}
  close(): void { this.closed = true; this.busy = false; }
}

/** A dream engine for tests: answers from a queue (or with no changes) and records every prompt. */
export class FakeDreamEngine {
  requests: DreamEngineRequest[] = [];
  replies: (string | Error)[] = [];
  /** Usage reported with each reply. */
  tokens = 1200;
  costUsd = 0.004;
  engine: DreamEngine = async request => {
    this.requests.push(request);
    const reply = this.replies.shift() ?? JSON.stringify({ memory: [], soul: null, diary: 'Nothing to change.', corrections: [] });
    if (reply instanceof Error) throw reply;
    return { text: reply, tokens: this.tokens, costUsd: this.costUsd };
  };
}

export interface Harness {
  dir: string;
  store: Store;
  manager: AgentManager;
  events: ServerEvent[];
  runners: Map<string, FakeRunner[]>;
  dreams: FakeDreamEngine;
  /** The newest fake provider for an agent. */
  runner(agentId: string): FakeRunner;
}

export function harness(engines: Partial<Record<EngineKind, EngineInfo>> = {}, options: { idleProcessMs?: number } = {}): Harness {
  const dir = tempDir('state');
  // Named like the real ~/.agentscode: a dot folder, which Express refuses to serve files from unless told.
  const store = new Store(path.join(dir, '.agentscode'));
  store.load();
  const events: ServerEvent[] = [];
  const runners = new Map<string, FakeRunner[]>();
  // Dreams never reach a real model in tests.
  const dreams = new FakeDreamEngine();
  const available: EngineInfo = { available: true, path: '/usr/bin/false', version: '0.0.0' };
  const manager = new AgentManager(store, { broadcast: event => events.push(event) }, {
    claude: engines.claude ?? available,
    codex: engines.codex ?? available,
  }, {
    createRunner: ctx => {
      const runner = new FakeRunner(ctx);
      const id = ctx.agent().id;
      runners.set(id, [...(runners.get(id) ?? []), runner]);
      return runner;
    },
    worktreesRoot: path.join(dir, 'worktrees'),
    dreamEngine: dreams.engine,
    idleProcessMs: options.idleProcessMs,
  });
  manager.init();
  return {
    dir, store, manager, events, runners, dreams,
    runner: (agentId: string) => {
      const list = runners.get(agentId);
      if (!list?.length) throw new Error('This agent has no provider yet.');
      return list[list.length - 1];
    },
  };
}

export function projectDir(dir: string, name: string): string {
  const full = path.join(dir, name);
  fs.mkdirSync(full, { recursive: true });
  return full;
}
