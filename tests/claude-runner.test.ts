import assert from 'node:assert/strict';
import test from 'node:test';
import type { HookCallbackMatcher, query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, ApprovalDecision } from '../shared/types.ts';
import { ClaudeRunner } from '../server/agents/claude.ts';
import type { ApprovalRequest, EntryDraft, RunnerHooks, TurnResult } from '../server/agents/runner.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { COMMS_TOOLS } from '../server/comms/tools.ts';
import { settle } from './helpers.ts';

const agent: Agent = {
  id: 'a1', name: 'Ada', engine: 'claude', projectId: 'p1', worktree: null, home: '/tmp/agentscode-test/agents/a1', dreaming: true, model: 'sonnet', effort: '',
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

test('Full access answers tool prompts itself, but questions and the user\'s ask rules still reach the user', async () => {
  const captured: { options?: Options; prompts: unknown[] } = { prompts: [] };
  const live: Agent = { ...agent, autonomy: 'edits' };
  const approvals: ApprovalRequest[] = [];
  const hooks: RunnerHooks = {
    session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {},
    approval: async (request): Promise<ApprovalDecision> => { approvals.push(request); return { allow: true, answers: { q: 'yes' } }; },
    closed: () => {},
  };
  const runner = new ClaudeRunner({
    agent: () => live,
    project: { id: 'p1', name: 'App', path: '/tmp/app', createdAt: 0, exists: true, isGit: false },
    cwd: '/tmp/app', binPath: null, hooks, preparePrompt: text => text,
  }, fakeQuery(captured));
  runner.send('Tidy the build');
  await settle(10);
  const canUseTool = captured.options!.canUseTool;
  const base = () => ({ signal: new AbortController().signal, suggestions: [], toolUseID: 't1' });
  const bash = { command: "python3 - <<'EOF'\nprint(1)\nEOF" };

  // Auto-accept edits still asks before a command.
  await canUseTool('Bash', bash, base());
  assert.equal(approvals.length, 1);

  // Switched to Full access: the CLI may still route its own safety checks here, and a
  // mid-turn switch has not reached the CLI yet. Neither should prompt.
  live.autonomy = 'full';
  const allowed = await canUseTool('Bash', bash, { ...base(), decisionReason: 'Writes to .git need approval' });
  assert.equal(allowed.behavior, 'allow');
  assert.deepEqual((allowed as { updatedInput?: unknown }).updatedInput, bash);
  const edit = await canUseTool('Write', { file_path: '/tmp/app/.claude/settings.json', content: '{}' }, base());
  assert.equal(edit.behavior, 'allow');
  assert.equal(approvals.length, 1);

  // An ask rule from the user's settings still prompts.
  const ruled = await canUseTool('Bash', { command: 'git push' }, { ...base(), matchedAskRule: { source: 'userSettings', toolName: 'Bash', ruleContent: 'git push:*' } });
  assert.equal(ruled.behavior, 'allow');
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].type, 'tool');

  // The agent's own questions still need real answers.
  const asked = await canUseTool('AskUserQuestion', { questions: [{ question: 'Ship it?', header: 'Ship', options: [], multiSelect: false }] }, base());
  assert.equal(asked.behavior, 'allow');
  assert.equal(approvals.length, 3);
  assert.equal(approvals[2].type, 'question');
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

test('an agent with no project gets every project folder, and a fresh process when the list changes', async () => {
  const starts: Options[] = [];
  const factory = ((params: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Options }) => {
    starts.push(params.options);
    const input = params.prompt[Symbol.asyncIterator]();
    async function* run() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      for (;;) {
        const next = await input.next();
        if (next.done) return;
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', total_cost_usd: 0 };
      }
    }
    return Object.assign(run(), {
      interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
      applyFlagSettings: async () => {}, close: () => {},
    });
  }) as unknown as typeof query;
  let folders = ['/work/web', '/work/api'];
  const hooks: RunnerHooks = { session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {}, approval: async () => ({ allow: true }), closed: () => {} };
  const runner = new ClaudeRunner({
    agent: () => ({ ...agent, projectId: null }),
    project: null,
    cwd: '/data/agents/a1',
    binPath: null,
    hooks,
    instructions: () => 'You are not tied to one project. [built by the manager]',
    directories: () => folders,
  }, factory);

  runner.send('First');
  await settle(10);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].additionalDirectories, ['/work/web', '/work/api']);
  assert.equal(starts[0].cwd, '/data/agents/a1');
  assert.match((starts[0].systemPrompt as { append: string }).append, /built by the manager/);

  // Edit tools are kept off the agent's own home files by a PreToolUse hook, which runs in every mode.
  const guard = (starts[0].hooks as { PreToolUse: HookCallbackMatcher[] }).PreToolUse[0];
  assert.equal(guard.matcher, 'Write|Edit|MultiEdit|NotebookEdit');
  const ask = (file: string) => guard.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '/data/agents/a1' } as never, 't1', { signal: new AbortController().signal });
  const denied = await ask(`${agent.home}/soul.md`) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  assert.deepEqual(await ask(`${agent.home}/workspace/notes.md`), {});
  assert.deepEqual(await ask('/work/web/src/app.ts'), {});

  runner.send('Second, same folders');
  await settle(10);
  assert.equal(starts.length, 1, 'the running process is reused');

  folders = [...folders, '/work/docs'];
  runner.send('Third, after a project was added');
  await settle(10);
  assert.equal(starts.length, 2, 'a new project needs a fresh process');
  assert.deepEqual(starts[1].additionalDirectories, ['/work/web', '/work/api', '/work/docs']);
  runner.close();
});

test('the edit guard is registered in every permission mode and denies soul.md in each', async () => {
  const hooks: RunnerHooks = { session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {}, approval: async () => ({ allow: true }), closed: () => {} };
  const modes = { readonly: 'plan', ask: 'default', edits: 'acceptEdits', full: 'bypassPermissions' } as const;
  for (const [autonomy, mode] of Object.entries(modes) as [Agent['autonomy'], string][]) {
    const captured: { options?: Options; prompts: unknown[] } = { prompts: [] };
    const runner = new ClaudeRunner({
      agent: () => ({ ...agent, projectId: null, autonomy }),
      project: null,
      cwd: `${agent.home}/workspace`,
      binPath: null,
      hooks,
    }, fakeQuery(captured));
    runner.send('Go.');
    await settle(10);
    assert.equal(captured.options!.permissionMode, mode, autonomy);
    const matchers = (captured.options!.hooks as { PreToolUse?: HookCallbackMatcher[] } | undefined)?.PreToolUse ?? [];
    assert.equal(matchers.length, 1, `${autonomy}: registered`);
    assert.equal(matchers[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit');
    const decide = async (tool: string, file: string) => {
      const out = await matchers[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file, notebook_path: file }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: `${agent.home}/workspace` } as never, 't', { signal: new AbortController().signal });
      return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? 'allow';
    };
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.equal(await decide(tool, `${agent.home}/soul.md`), 'deny', `${autonomy} ${tool}`);
    assert.equal(await decide('Edit', '../memory.md'), 'deny', `${autonomy}: relative to the workspace`);
    assert.equal(await decide('Write', `${agent.home}/workspace/notes.md`), 'allow', autonomy);
    runner.close();
  }
});

test('a SuperAgent session gets only read tools, its commands, none of the user\'s MCP servers, and every other tool refused', async () => {
  const captured: { options?: Options; prompts: unknown[] } = { prompts: [] };
  const approvals: ApprovalRequest[] = [];
  const hooks: RunnerHooks = {
    session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {}, closed: () => {},
    approval: async request => { approvals.push(request); return { allow: true }; },
  };
  const boss: Agent = { ...agent, id: 's1', name: 'SuperAgent', role: 'super', autonomy: 'readonly', projectId: null, useMcp: true };
  const runner = new ClaudeRunner({ agent: () => boss, project: null, cwd: '/tmp/home', binPath: null, hooks, commsToken: 'tok-s' }, fakeQuery(captured));
  runner.send('Run the team.');
  await settle(10);
  const options = captured.options!;
  assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
  for (const tool of ['Edit', 'Write', 'Bash', 'Agent', 'Task', 'Skill']) assert.ok((options.disallowedTools as string[]).includes(tool), tool);
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.strictMcpConfig, true);
  assert.ok((options.allowedTools as string[]).includes(`mcp__${COMMS_SERVER}__create_agent`));
  assert.ok(!(options.allowedTools as string[]).includes(`mcp__${COMMS_SERVER}__browser_eval`));
  const servers = options.mcpServers as Record<string, { env: Record<string, string> }>;
  assert.equal(servers[COMMS_SERVER].env.AGENTSCODE_EXECUTIVE, '1');
  const signal = new AbortController().signal;
  for (const tool of ['Bash', 'Edit', 'Write', 'mcp__other__write']) {
    const decision = await options.canUseTool(tool, {}, { signal, suggestions: [] });
    assert.equal(decision.behavior, 'deny', tool);
  }
  assert.equal(approvals.length, 0, 'refused without asking the user');
  runner.close();
});
