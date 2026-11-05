import assert from 'node:assert/strict';
import test from 'node:test';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, ApprovalDecision } from '../shared/types.ts';
import { ClaudeRunner } from '../server/agents/claude.ts';
import type { ApprovalRequest, EntryDraft, RunnerHooks, TurnResult } from '../server/agents/runner.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { COMMS_TOOLS } from '../server/comms/tools.ts';
import { settle } from './helpers.ts';

const agent: Agent = {
  id: 'a1', name: 'Ada', engine: 'claude', projectId: 'p1', worktree: null, model: 'sonnet', effort: '',
  autonomy: 'ask', useMcp: false, role: 'dev', instructions: 'Prefer small diffs.', status: 'idle', activity: '',
  currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
  costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null,
};

type Options = Record<string, unknown> & {
  canUseTool: (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
};

/** A stand-in for the SDK query: answers one user message with a reply and a result. */
function fakeQuery(captured: { options?: Options; prompts: unknown[] }) {
  return ((params: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Options }) => {
    captured.options = params.options;
    const input = params.prompt[Symbol.asyncIterator]();
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      const first = await input.next();
      captured.prompts.push(first.value?.message.content);
      yield { type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Working on it.' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'All done.', total_cost_usd: 0.02 };
      await new Promise(() => {}); // the process stays open between turns
    }
    return Object.assign(run(), {
      interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      applyFlagSettings: async () => {}, close: () => {},
    });
  }) as unknown as typeof query;
}

test('the Claude runner wires the comms server, instructions and turn results', async () => {
  const captured: { options?: Options; prompts: unknown[] } = { prompts: [] };
  const sessions: string[] = [];
  const entries: EntryDraft[] = [];
  const results: TurnResult[] = [];
  const approvals: ApprovalRequest[] = [];
  const hooks: RunnerHooks = {
    session: id => sessions.push(id),
    entry: entry => entries.push(entry),
    activity: () => {},
    turnStart: () => {},
    turnEnd: result => results.push(result),
    approval: async (request): Promise<ApprovalDecision> => { approvals.push(request); return { allow: false, message: 'not now' }; },
    closed: () => {},
  };
  const runner = new ClaudeRunner({
    agent: () => agent,
    project: { id: 'p1', name: 'App', path: '/tmp/app', createdAt: 0, exists: true, isGit: false },
    cwd: '/tmp/app',
    binPath: '/usr/local/bin/claude',
    hooks,
    commsToken: 'tok-123',
    preparePrompt: text => `[team snapshot]\n${text}`,
  }, fakeQuery(captured));

  runner.send('Add a health check', { summary: 'Add a health check', source: 'user' });
  await settle(10);

  const options = captured.options!;
  const servers = options.mcpServers as Record<string, { env: Record<string, string> }>;
  assert.deepEqual(Object.keys(servers), [COMMS_SERVER]);
  assert.equal(servers[COMMS_SERVER].env.AGENTSCODE_TOKEN, 'tok-123');
  assert.deepEqual(options.allowedTools, COMMS_TOOLS.map(name => `mcp__${COMMS_SERVER}__${name}`));
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.strictMcpConfig, true);
  const append = (options.systemPrompt as { append: string }).append;
  assert.match(append, /You are Ada/);
  assert.match(append, /Prefer small diffs/);
  assert.match(append, /send_message/);

  assert.equal(captured.prompts[0], '[team snapshot]\nAdd a health check');
  assert.deepEqual(sessions, ['session-1']);
  assert.equal(entries[0].kind, 'agent');
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].summary, 'All done.');
  assert.equal(results[0].costUsd, 0.02);

  // Tool permission prompts go to the IDE, and a denial carries the user's note back.
  const decision = await options.canUseTool('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, suggestions: [] });
  assert.equal(approvals[0].type, 'tool');
  assert.match(approvals[0].title, /rm -rf build/);
  assert.equal(decision.behavior, 'deny');
  assert.match(decision.message ?? '', /not now/);
  runner.close();
});

test('slash commands reach Claude Code unchanged', async () => {
  const captured: { options?: Options; prompts: unknown[] } = { prompts: [] };
  const hooks: RunnerHooks = { session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {}, approval: async () => ({ allow: true }), closed: () => {} };
  const runner = new ClaudeRunner({
    agent: () => agent,
    project: { id: 'p1', name: 'App', path: '/tmp/app', createdAt: 0, exists: true, isGit: false },
    cwd: '/tmp/app', binPath: null, hooks, preparePrompt: text => `[team snapshot]\n${text}`,
  }, fakeQuery(captured));
  runner.send('/review src/auth.ts');
  await settle(10);
  assert.equal(captured.prompts[0], '/review src/auth.ts');
  runner.close();
});

test('the Claude runner reports the main loop prompt size and the model window', async () => {
  const readings: { used?: number; window?: number }[] = [];
  const hooks: RunnerHooks = {
    session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {},
    approval: async () => ({ allow: true }), closed: () => {},
    context: reading => readings.push(reading),
  };
  const usageQuery = ((params: { prompt: AsyncIterable<unknown> }) => {
    const input = params.prompt[Symbol.asyncIterator]();
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      await input.next();
      yield {
        type: 'assistant', uuid: 'u1', parent_tool_use_id: null,
        message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Reading.' }], usage: { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40_000, output_tokens: 50 } },
      };
      // A subagent's bigger prompt is not this session's context.
      yield { type: 'assistant', uuid: 'u2', parent_tool_use_id: 'tool-1', message: { model: 'claude-haiku-5-5', content: [], usage: { input_tokens: 90_000 } } };
      // A synthetic error message carries zeros; it must not reset the meter.
      yield { type: 'assistant', uuid: 'u3', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [], usage: { input_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null } } };
      yield {
        type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0.01,
        modelUsage: {
          'claude-haiku-5-5': { inputTokens: 90_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 200_000 },
          'claude-opus-5-5': { inputTokens: 12, cacheReadInputTokens: 40_000, cacheCreationInputTokens: 3000, contextWindow: 1_000_000 },
        },
      };
      await new Promise(() => {});
    }
    return Object.assign(run(), {
      interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      applyFlagSettings: async () => {}, close: () => {},
    });
  }) as unknown as typeof query;
  const runner = new ClaudeRunner({
    agent: () => agent,
    project: { id: 'p1', name: 'App', path: '/tmp/app', createdAt: 0, exists: true, isGit: false },
    cwd: '/tmp/app', binPath: null, hooks,
  }, usageQuery);
  runner.send('Read the code');
  await settle(10);
  assert.deepEqual(readings, [{ used: 43_012 }, { window: 1_000_000 }]);
  runner.close();
});
