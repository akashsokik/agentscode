import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentTask, Autonomy } from '../../shared/types.ts';
import type { Runner, RunnerContext } from '../../server/agents/runner.ts';
import type { FakeTurn, Scenario } from './scenario.ts';

/** Where the harness is; the dry engine reads it to know which scripted turn to play. */
export interface Progress {
  session: 1 | 2;
  step: number;
}

/**
 * The dry-run engine: plays the scenario's scripted turn instead of calling a model. It knows a lesson
 * only when the lesson is in its context, the way a model would: in the session's instructions (where
 * memory.md goes) or in the prompt. When the scenario says so (plain corrections), it saves a lesson
 * with the real remember tool, over the comms endpoint, in the turn it is told it, as real agents do.
 */
export class FakeAgent implements Runner {
  busy = false;
  private ctx: RunnerContext;
  private scenario: Scenario;
  private progress: Progress;
  private instructions: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private remembered = new Set<string>();

  constructor(ctx: RunnerContext, scenario: Scenario, progress: Progress) {
    this.ctx = ctx;
    this.scenario = scenario;
    this.progress = progress;
  }

  send(text: string, task?: AgentTask): void {
    // A real runner builds the session's instructions when it starts, then prepares each prompt.
    if (this.instructions === null) this.instructions = this.ctx.instructions?.() ?? '';
    const prompt = this.ctx.preparePrompt?.(text) ?? text;
    this.busy = true;
    this.ctx.hooks.turnStart(task);
    this.timer = setTimeout(() => void this.play(prompt), 5);
  }

  private async remember(text: string): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/comms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.ctx.commsToken ?? ''}` },
      body: JSON.stringify({ tool: 'remember', args: { text, why: 'The user told me this.' } }),
    });
    const body = await response.json() as { error?: string };
    this.ctx.hooks.entry({
      id: randomUUID(), kind: 'tool', text: '',
      tool: { name: 'mcp__podcode__remember', summary: response.ok ? `Remembered: ${text}` : `remember failed: ${body.error}`, status: response.ok ? 'ok' : 'error' },
    });
  }

  private async play(prompt: string): Promise<void> {
    this.timer = null;
    const hooks = this.ctx.hooks;
    const root = this.ctx.cwd;
    const inside = (rel: string) => {
      const full = path.resolve(root, rel);
      if (!full.startsWith(root + path.sep)) throw new Error(`The dry engine only writes inside the project: ${rel}`);
      return full;
    };
    const context = `${this.instructions}\n${prompt}`;
    const turn: FakeTurn = {
      session: this.progress.session,
      step: this.progress.step,
      knows: id => this.scenario.lessons.filter(l => !id || l.id === id).every(l => l.knows.test(context)),
      read: rel => {
        try {
          return fs.readFileSync(inside(rel), 'utf8');
        } catch {
          return null;
        }
      },
      write: (rel, text) => {
        const full = inside(rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
        hooks.entry({ id: randomUUID(), kind: 'tool', text: '', tool: { name: 'Write', summary: rel, status: 'ok' } });
      },
      remove: rel => fs.rmSync(inside(rel), { force: true }),
      run: (command, result = {}) => {
        const ok = result.ok ?? true;
        hooks.entry({ id: randomUUID(), kind: 'tool', text: '', tool: { name: 'Bash', summary: command.split('\n')[0], detail: command, output: result.output, status: ok ? 'ok' : 'error' } });
      },
    };
    try {
      if (this.scenario.fakeRemembers) {
        for (const lesson of this.scenario.lessons) {
          if (lesson.knows.test(prompt) && !this.remembered.has(lesson.id)) {
            this.remembered.add(lesson.id);
            await this.remember(lesson.text);
          }
        }
      }
      const reply = this.scenario.fake(turn);
      hooks.entry({ id: randomUUID(), kind: 'agent', text: reply });
      this.busy = false;
      hooks.turnEnd({ ok: true, summary: reply });
    } catch (err) {
      this.busy = false;
      hooks.turnEnd({ ok: false, summary: '', error: (err as Error).message });
    }
    hooks.ready?.();
  }

  async interrupt(): Promise<void> {
    if (!this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.busy = false;
    this.ctx.hooks.turnEnd({ ok: false, stopped: true, summary: '' });
    this.ctx.hooks.ready?.();
  }

  async setAutonomy(_autonomy: Autonomy): Promise<void> {}
  async setModel(_model: string): Promise<void> {}
  async setEffort(_effort: string): Promise<void> {}

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.busy = false;
  }

  async dispose(): Promise<void> {
    this.close();
  }
}

interface PromptItem {
  id: string;
  kind: string;
  trusted: boolean;
  text: string;
}

/**
 * The digest items in a dream prompt: "[d3] user correction (<time>): <text>", "[d4] agent summary
 * (confirmed by the user) (<time>): ...". Any number of parenthesized tags may follow the kind.
 */
function digestItems(prompt: string): PromptItem[] {
  return prompt.split('\n').flatMap(line => {
    const match = /^\[(d\d+)\] (\w+) (\w+)((?: \([^)]*\))*):\s?(.*)$/.exec(line);
    return match ? [{ id: match[1], kind: match[3], trusted: match[2] === 'user' || match[4].includes('(confirmed by the user)'), text: match[5] }] : [];
  });
}

/** The memory section of a dream prompt. */
function memorySection(prompt: string): string {
  const start = prompt.indexOf('memory.md, oldest first');
  const end = prompt.indexOf('Digest of the session', start);
  return start >= 0 && end > start ? prompt.slice(start, end) : '';
}

/**
 * The dry-run dream pass: an ideal dream within the rules. For each lesson memory does not already hold,
 * it cites the digest item that carries the lesson's evidence, a trusted one when there is one, and
 * writes the lesson. The server still checks the citation, so a lesson whose only trace is untrusted
 * is rejected, and one the digest dropped is never learned: what a real dream would be up against.
 */
export function fakeDreamReply(prompt: string, scenario: Scenario): string {
  const items = digestItems(prompt);
  const memory = memorySection(prompt);
  const notes: string[] = [];
  const ops = scenario.lessons.flatMap(lesson => {
    if (lesson.knows.test(memory)) {
      notes.push(`${lesson.id}: already in memory`);
      return [];
    }
    const carrying = items.filter(item => item.text.includes(lesson.evidence));
    const cite = carrying.find(item => item.trusted) ?? carrying[0];
    if (!cite) {
      notes.push(`${lesson.id}: no digest item carries "${lesson.evidence}" (${items.length} items parsed)`);
      return [];
    }
    return [{ op: 'add', text: lesson.text, why: `From the session (${cite.id}).`, evidence: [cite.id] }];
  });
  return JSON.stringify({
    memory: ops,
    soul: null,
    diary: [`Learned ${ops.length} lesson(s) from the session.`, ...notes].join('\n'),
    corrections: items.filter(item => item.kind === 'correction').map(item => ({ digestId: item.id, matchesMemoryId: null })),
  });
}
