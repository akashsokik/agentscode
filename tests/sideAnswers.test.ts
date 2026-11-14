import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentTask, ApprovalDecision, Entry, PeerMessage } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { DATA_DIR } from '../server/config.ts';
import { ClaudeRunner, superSideTools } from '../server/agents/claude.ts';
import type { RunnerHooks, SideOptions, SideResult } from '../server/agents/runner.ts';
import { ScopedRunner } from '../server/agents/scoped.ts';
import { Mailbox, SIDE_DEFER, SIDE_LIMIT, sidePrompt, type SideAnswer } from '../server/comms/mailbox.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { SIDE_ANSWER_MS } from '../server/manager.ts';
import { Store } from '../server/store.ts';
import { SuperStore } from '../server/superAgent.ts';
import { FakeRunner, harness, settle, tempDir } from './helpers.ts';

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id.toUpperCase(), engine: 'claude', projectIds: ['p1'], worktree: null, home: `/tmp/podcode-test/agents/${id}`, dreaming: true, model: '', effort: '',
    autonomy: 'edits', useMcp: false, role: 'dev', instructions: '', status: 'idle', activity: '',
    currentTask: null, sessionId: null, createdAt: 0, lastActiveAt: 0, turnStartedAt: null, unread: false,
    costUsd: 0, tokens: 0, turns: 0, queued: 0, lastSummary: '', error: null, ...overrides,
  };
}

/** A mailbox whose recipient `s` can answer beside its turn; each side answer is settled by the test. */
function setup(options: { side?: boolean; hold?: (message: PeerMessage) => string | null } = {}) {
  const store = new Store(path.join(tempDir('side'), 'data'));
  store.load();
  store.settings = { ...DEFAULT_SETTINGS };
  for (const a of [agent('a'), agent('b'), agent('c'), agent('d'), agent('s', { role: 'super' })]) store.agents.set(a.id, a);
  const busy = new Set<string>();
  const delivered: { agentId: string; text: string; task: AgentTask }[] = [];
  const asked: { message: PeerMessage; prompt: string; answer: (result: SideAnswer) => void }[] = [];
  const settled: { message: PeerMessage; reply: PeerMessage | null; reason?: string }[] = [];
  let available = options.side ?? true;
  const mailbox = new Mailbox(store, {
    ready: id => !busy.has(id),
    send: (agentId, text, task) => { busy.add(agentId); delivered.push({ agentId, text, task }); },
    changed: () => {},
    conversationChanged: () => {},
    hold: (_id, message) => options.hold?.(message) ?? null,
    inChannel: () => true,
    side: (id, message, prompt) => {
      if (id !== 's' || !available) return null;
      return new Promise<SideAnswer>(resolve => asked.push({ message, prompt, answer: resolve }));
    },
    sideSettled: (_id, message, reply, reason) => settled.push({ message, reply, reason }),
  });
  return { store, mailbox, busy, delivered, asked, settled, setAvailable: (value: boolean) => { available = value; } };
}

test('a question to a busy recipient is answered beside its turn, and the reply goes out as its own', async () => {
  const t = setup();
  t.busy.add('s');
  const question = t.mailbox.send('a', 's', 'Which branch do I base ACH-50 on?');
  await settle();
  assert.equal(t.delivered.length, 0, 'the busy recipient gets no turn');
  assert.equal(t.asked.length, 1);
  assert.equal(question.status, 'delivering');
  assert.match(t.asked[0].prompt, /Which branch do I base ACH-50 on\?/);
  assert.match(t.asked[0].prompt, new RegExp(SIDE_DEFER));

  t.asked[0].answer({ ok: true, text: 'Base it on main.' });
  await settle();
  assert.equal(question.status, 'delivered');
  const reply = t.store.messages.find(m => m.replyTo === question.id)!;
  assert.equal(reply.fromAgentId, 's');
  assert.equal(reply.toAgentId, 'a');
  assert.equal(reply.text, 'Base it on main.');
  assert.equal(reply.expectsReply, false);
  assert.equal(reply.conversationId, question.conversationId);
  assert.equal(t.delivered.at(-1)?.agentId, 'a', 'the asker gets the answer as a turn');
  assert.equal(t.settled[0].reply?.id, reply.id);

  // The recipient's own turn ends: the answered question does not come round again.
  t.busy.delete('s');
  t.mailbox.finish('s', true);
  t.mailbox.drain('s');
  await settle();
  assert.equal(t.delivered.filter(d => d.agentId === 's').length, 0);
});

test('two teammates asking at different times are both answered while the turn runs', async () => {
  const t = setup();
  t.busy.add('s');
  const first = t.mailbox.send('a', 's', 'First question?');
  await settle();
  const second = t.mailbox.send('b', 's', 'Second question?');
  await settle();
  assert.equal(t.asked.length, 2, 'the second does not wait for the first');
  t.asked[1].answer({ ok: true, text: 'Answer two.' });
  await settle();
  assert.equal(second.status, 'delivered');
  assert.equal(first.status, 'delivering');
  t.asked[0].answer({ ok: true, text: 'Answer one.' });
  await settle();
  assert.equal(first.status, 'delivered');
});

test('only plain questions are answered beside a turn: delegations, reports, channel mentions and news wait', async () => {
  const t = setup();
  t.store.agents.get('a')!.role = 'lead';
  // The SuperAgent handed c a task while it was free; c reports once the SuperAgent is busy again.
  const handed = t.mailbox.delegate('s', 'c', { kind: 'implementation', task: 'Build it.', acceptanceCriteria: 'Built.' });
  await settle();
  t.busy.add('s');
  const task = t.mailbox.delegate('a', 's', { kind: 'implementation', task: 'Coordinate this.', acceptanceCriteria: 'Done.' });
  const news = t.mailbox.send('b', 's', 'FYI: the build is green.', false);
  const report = t.mailbox.report('c', handed.id, { outcome: 'done', summary: 'Built.', evidence: 'Ran it.' });
  // Even a report or a mention that asked for a reply is not a plain question.
  report.expectsReply = true;
  const mention = t.mailbox.mention('d', 's', 'Can you look at this thread?', true, 'channel-1', 'post-1');
  await settle();
  t.mailbox.drain('s');
  await settle();
  assert.equal(t.asked.length, 0);
  for (const message of [task, news, report, mention]) assert.equal(message.status, 'queued');
});

test('stopping the conversation while a side answer runs sends nothing and cancels the question', async () => {
  const t = setup();
  t.busy.add('s');
  const question = t.mailbox.send('a', 's', 'Status?');
  await settle();
  assert.equal(question.status, 'delivering');
  t.mailbox.stopConversation(question.conversationId);
  t.asked[0].answer({ ok: true, text: 'All green.' });
  await settle();
  assert.equal(t.store.messages.filter(m => m.replyTo === question.id).length, 0, 'no reply into a stopped conversation');
  assert.equal(t.settled[0].reply, null);
  // Back in the queue, where the recipient's own drain cancels it with its conversation.
  t.busy.delete('s');
  t.mailbox.drain('s');
  await settle();
  assert.equal(question.status, 'cancelled');
  assert.equal(t.delivered.filter(d => d.agentId === 's').length, 0);
});

test('a side answer stays on record until the recipient\'s session is told, across a restart', async () => {
  const t = setup();
  t.busy.add('s');
  const question = t.mailbox.send('a', 's', 'Which branch?');
  await settle();
  t.asked[0].answer({ ok: true, text: 'main.' });
  await settle();
  const reply = t.store.messages.find(m => m.replyTo === question.id)!;
  assert.equal(reply.side, 'pending');

  // A restart: a new mailbox over what the store saved.
  t.store.flush();
  const store = new Store(t.store.dataDir);
  store.load();
  const restarted = new Mailbox(store, { ready: () => true, send: () => {}, changed: () => {}, conversationChanged: () => {} });
  const told = restarted.takeSideAnswers('s', 20);
  assert.equal(told.length, 1);
  assert.equal(told[0].request?.text, 'Which branch?');
  assert.equal(told[0].reply.text, 'main.');
  assert.equal(told[0].reply.side, 'noted');
  assert.deepEqual(restarted.takeSideAnswers('s', 20), [], 'told once');
});

test('a side answer that needs the main session puts the question back in the queue, once', async () => {
  const t = setup();
  t.busy.add('s');
  const question = t.mailbox.send('a', 's', 'Can you assign ACH-51 to me?');
  await settle();
  t.asked[0].answer({ ok: true, text: SIDE_DEFER });
  await settle();
  assert.equal(question.status, 'queued');
  assert.equal(t.store.messages.filter(m => m.replyTo === question.id).length, 0, 'nothing was sent to the asker');
  assert.equal(t.settled[0].reply, null);
  assert.equal(t.asked.length, 1, 'not tried beside the turn again');

  t.busy.delete('s');
  t.mailbox.finish('s', true);
  t.mailbox.drain('s');
  await settle();
  assert.equal(t.delivered.at(-1)?.agentId, 's');
  assert.equal(t.delivered.at(-1)?.task.messageId, question.id);
});

test('a failed or empty side answer falls back to the recipient\'s own turn', async () => {
  for (const result of [{ ok: false, text: '', error: 'boom' }, { ok: true, text: '   ' }]) {
    const t = setup();
    t.busy.add('s');
    const question = t.mailbox.send('a', 's', 'Status?');
    await settle();
    t.asked[0].answer(result);
    await settle();
    assert.equal(question.status, 'queued');
    assert.equal(t.store.messages.filter(m => m.replyTo === question.id).length, 0);
  }
});

test('mail that may not start a turn now may not start a side answer either', async () => {
  const t = setup({ hold: () => 'Quiet hours.' });
  t.busy.add('s');
  const question = t.mailbox.send('a', 's', 'Status?');
  await settle();
  assert.equal(t.asked.length, 0);
  assert.equal(question.status, 'queued');
});

test('when a side answer is not possible the question waits for the turn, as before', async () => {
  const t = setup({ side: false });
  t.busy.add('s');
  const question = t.mailbox.send('a', 's', 'Status?');
  await settle();
  assert.equal(question.status, 'queued');
  t.busy.delete('s');
  t.mailbox.drain('s');
  await settle();
  assert.equal(t.delivered.at(-1)?.task.messageId, question.id);
});

test('an idle recipient still gets the question as a normal turn', async () => {
  const t = setup();
  const question = t.mailbox.send('a', 's', 'Status?');
  await settle();
  assert.equal(t.asked.length, 0);
  assert.equal(t.delivered.at(-1)?.task.messageId, question.id);
});

test('side answers are capped per recipient, and a stop drops one in flight', async () => {
  const t = setup();
  t.busy.add('s');
  const questions = ['a', 'b', 'c'].map(from => t.mailbox.send(from, 's', `Question from ${from}?`));
  await settle();
  assert.equal(t.asked.length, SIDE_LIMIT);
  assert.equal(questions[2].status, 'queued');

  t.mailbox.stop('s');
  t.asked[0].answer({ ok: true, text: 'Too late.' });
  await settle();
  assert.equal(questions[0].status, 'cancelled');
  assert.equal(t.store.messages.filter(m => m.replyTo === questions[0].id).length, 0, 'no reply after a stop');
});

test('the side prompt tells the copy to read only, to defer when unsure, and not to use the reply tool', () => {
  const prompt = sidePrompt({ id: 'm1', conversationId: 'c1', fromAgentId: 'a', fromName: 'Ada', toAgentId: 's', toName: 'SuperAgent', text: 'Where is the plan?', expectsReply: true, ts: 0, status: 'queued' });
  assert.match(prompt, /copy of your session/);
  assert.match(prompt, /You can only read here/);
  assert.match(prompt, new RegExp(`exactly ${SIDE_DEFER}`));
  assert.match(prompt, /Do not call the reply tool/);
  assert.match(prompt, /From: Ada \(a\)\. Message ID: m1\./);
  assert.match(prompt, /Where is the plan\?/);
});

// ---- the Claude runner ---------------------------------------------------------

type Options = Record<string, unknown> & {
  canUseTool: (name: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;
  hooks: { PreToolUse: { matcher?: string; hooks: ((input: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>)[] }[] };
};
type Call = { prompt: unknown; options: Options; closed: boolean };

/** The SDK stand-in: a streaming session that stays in its turn, and forks that answer one prompt. */
function fakeQuery(calls: Call[], fork: { text?: string; fail?: boolean; hang?: boolean; interruptible?: boolean } = {}) {
  return ((params: { prompt: AsyncIterable<{ message: { content: unknown } }>; options: Options }) => {
    const call: Call = { prompt: undefined, options: params.options, closed: false };
    calls.push(call);
    let interrupted: (() => void) | undefined;
    async function* session() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      call.prompt = (await params.prompt[Symbol.asyncIterator]().next()).value?.message.content;
      yield { type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Working on it.' }] } };
      await new Promise(() => {}); // the turn keeps running
    }
    async function* side() {
      yield { type: 'system', subtype: 'init', session_id: 'fork-1' };
      call.prompt = (await params.prompt[Symbol.asyncIterator]().next()).value?.message.content;
      if (fork.hang) {
        const signal = (params.options.abortController as AbortController).signal;
        const how = await new Promise<string>((resolve, reject) => {
          interrupted = () => resolve('interrupted');
          if (signal.aborted) reject(new Error('aborted'));
          else signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        // An interrupted turn still ends with a result that says what it spent.
        if (how === 'interrupted') { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], total_cost_usd: 0.02 }; return; }
      }
      yield { type: 'assistant', uuid: 'f1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: fork.text ?? 'Base it on main.' }] } };
      if (fork.fail) yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['It broke.'], total_cost_usd: 0.01 };
      else yield { type: 'result', subtype: 'success', is_error: false, result: fork.text ?? 'Base it on main.', total_cost_usd: 0.03, usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 80 } };
    }
    return Object.assign(params.options.forkSession ? side() : session(), {
      interrupt: async () => { if (fork.interruptible) interrupted?.(); }, setPermissionMode: async () => {}, setModel: async () => {},
      applyFlagSettings: async () => {}, close: () => { call.closed = true; }, return: async () => ({ done: true, value: undefined }),
    });
  }) as unknown as typeof query;
}

function claudeRunner(calls: Call[], fork: Parameters<typeof fakeQuery>[1] = {}) {
  const boss = agent('s', { role: 'super', autonomy: 'readonly', name: 'SuperAgent' });
  const hooks: RunnerHooks = {
    session: id => { boss.sessionId = id; }, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {},
    approval: async (): Promise<ApprovalDecision> => ({ allow: false }), closed: () => {},
  };
  const runner = new ClaudeRunner({ agent: () => boss, project: null, cwd: '/tmp/home', binPath: null, hooks, commsToken: 'tok-s' }, fakeQuery(calls, fork));
  return { runner, boss };
}

test('the Claude runner answers beside a turn from a fork of the session, with the same prompt and read-only tools', async () => {
  const calls: Call[] = [];
  const { runner } = claudeRunner(calls);
  assert.equal(runner.side('Question?', { allowedTools: superSideTools() }), null, 'nothing to copy before a turn runs');

  runner.send('Update from PodCode', { summary: 'Update', source: 'system' });
  await settle(10);
  const result = await runner.side('Question?', { allowedTools: superSideTools() })!;
  assert.deepEqual(result, { ok: true, text: 'Base it on main.', error: undefined, costUsd: 0.03, usage: { inputTokens: 3, outputTokens: 20, cacheReadTokens: 9000, cacheWriteTokens: 80 } });

  const [main, fork] = calls;
  assert.equal(fork.prompt, 'Question?');
  assert.equal(fork.options.resume, 'session-1');
  assert.equal(fork.options.forkSession, true);
  assert.equal(fork.options.persistSession, false);
  // The cache is keyed on the tools and the system prompt: the fork repeats the session's.
  for (const key of ['systemPrompt', 'tools', 'disallowedTools', 'mcpServers', 'model', 'cwd', 'settingSources', 'strictMcpConfig']) {
    assert.deepEqual(fork.options[key], main.options[key], key);
  }
  // Only the MCP read tools run unasked. A built-in read keeps Claude Code's own rules, so it
  // works in the session's folders only: there is no allow rule for Read, Grep or Glob on any path.
  const preapproved = fork.options.allowedTools as string[];
  assert.deepEqual(preapproved, superSideTools().filter(name => name.startsWith('mcp__')));
  for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(!preapproved.includes(tool), tool);
  assert.ok(fork.closed, 'the fork process is closed when it has answered');
  assert.equal(main.closed, false);

  // Reading is let through; everything else is refused by the hook and by the permission callback.
  const hook = fork.options.hooks.PreToolUse[0];
  assert.equal(hook.matcher, undefined, 'the hook covers every tool');
  const decide = async (tool: string) => (await hook.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: tool })).hookSpecificOutput?.permissionDecision;
  assert.equal(await decide('Read'), undefined);
  assert.equal(await decide(`mcp__${COMMS_SERVER}__list_issues`), undefined);
  for (const tool of ['Bash', 'Edit', 'WebFetch', 'Agent', `mcp__${COMMS_SERVER}__reply`, `mcp__${COMMS_SERVER}__send_message`, `mcp__${COMMS_SERVER}__delegate_task`, `mcp__${COMMS_SERVER}__update_issue`, `mcp__${COMMS_SERVER}__ask_user`, `mcp__${COMMS_SERVER}__decision_add`, `mcp__${COMMS_SERVER}__take_action`]) {
    assert.equal(await decide(tool), 'deny', tool);
    assert.equal((await fork.options.canUseTool(tool, {}, {})).behavior, 'deny', tool);
  }
  // What reaches the permission callback is what the session would ask the user about, such as a
  // read outside its folders: the copy asks nobody and is refused.
  for (const [tool, input] of [['Read', { file_path: `${DATA_DIR}/agents/other/workspace/report.md` }], ['Read', { file_path: '/private/tmp/claude-image.png' }], ['Grep', { path: '/tmp', pattern: 'logs' }], ['Glob', { path: DATA_DIR, pattern: '**/*.md' }], ['Read', { file_path: '/Users/someone/.ssh/id_ed25519' }], ['Grep', { pattern: 'token', path: '/Users/someone/.aws' }], ['Glob', { pattern: '**/*', path: '/Users/someone/.config' }]] as const) {
    assert.equal((await fork.options.canUseTool(tool, input, {})).behavior, 'deny', tool);
  }
  runner.close();
});

test('a side answer runs on the model, effort and tier the agent has now, with its own comms credential', async () => {
  const calls: Call[] = [];
  const { runner, boss } = claudeRunner(calls);
  boss.model = 'claude-opus-5-5';
  boss.effort = 'high';
  runner.send('Update', { summary: 'Update', source: 'system' });
  await settle(10);
  // The user switches mid-session: the live process follows, its start options do not.
  boss.model = 'claude-sonnet-5-5';
  boss.effort = 'low';
  boss.serviceTier = 'fast';
  await runner.side('Question?', { allowedTools: superSideTools(), commsToken: 'tok-side' })!;
  const [main, fork] = calls;
  assert.equal(main.options.model, 'claude-opus-5-5');
  assert.equal(fork.options.model, 'claude-sonnet-5-5');
  assert.equal(fork.options.effort, 'low');
  assert.deepEqual(fork.options.settings, { fastMode: true });
  const token = (options: Options) => (options.mcpServers as Record<string, { env: Record<string, string> }>)[COMMS_SERVER].env.PODCODE_TOKEN;
  assert.equal(token(main.options), 'tok-s');
  assert.equal(token(fork.options), 'tok-side');
  assert.equal(fork.prompt, 'Question?');
  runner.close();
});

test('a side answer that fails, or is stopped with the agent, reports it instead of throwing', async () => {
  const failing: Call[] = [];
  const failed = claudeRunner(failing, { fail: true });
  failed.runner.send('Update', { summary: 'Update', source: 'system' });
  await settle(10);
  const result = await failed.runner.side('Question?', { allowedTools: [] })!;
  assert.equal(result.ok, false);
  assert.equal(result.text, '');
  assert.match(result.error ?? '', /It broke/);
  assert.equal(result.costUsd, 0.01, 'a failed answer still reports what it spent');
  failed.runner.close();

  // Stopped with the agent: it is interrupted, and the result it ends with carries its cost.
  const hung = claudeRunner([], { hang: true, interruptible: true });
  hung.runner.send('Update', { summary: 'Update', source: 'system' });
  await settle(10);
  const pending = hung.runner.side('Question?', { allowedTools: [] })!;
  await settle(10);
  await hung.runner.interrupt();
  const stopped = await pending;
  assert.deepEqual({ ok: stopped.ok, error: stopped.error, costUsd: stopped.costUsd }, { ok: false, error: 'Stopped.', costUsd: 0.02 });
  hung.runner.close();
});

test('a side answer stopped by its caller that does not end on its own is ended after the grace time', async () => {
  const grace = ClaudeRunner.sideStopGraceMs;
  ClaudeRunner.sideStopGraceMs = 20;
  try {
    const calls: Call[] = [];
    const stuck = claudeRunner(calls, { hang: true });
    stuck.runner.send('Update', { summary: 'Update', source: 'system' });
    await settle(10);
    const controller = new AbortController();
    const pending = stuck.runner.side('Question?', { allowedTools: [], signal: controller.signal })!;
    await settle(10);
    controller.abort();
    const stopped = await pending;
    assert.equal(stopped.ok, false);
    assert.equal(stopped.error, 'Stopped.');
    assert.ok(calls[1].closed);
    stuck.runner.close();
  } finally { ClaudeRunner.sideStopGraceMs = grace; }
});

test('the scoped runner passes a side answer to the provider only while a turn is running', async () => {
  const sides: string[] = [];
  let child: (FakeRunner & { side?: (prompt: string, options: SideOptions) => Promise<SideResult> | null }) | undefined;
  const hooks: RunnerHooks = { session: () => {}, entry: () => {}, activity: () => {}, turnStart: () => {}, turnEnd: () => {}, approval: async () => ({ allow: false }), closed: () => {} };
  const scoped = new ScopedRunner({
    resolve: () => ({ cwd: '/tmp/x', context: h => ({ agent: () => agent('s'), project: null, cwd: '/tmp/x', binPath: null, hooks: h }) }),
    create: ctx => {
      child = new FakeRunner(ctx);
      child.side = async prompt => { sides.push(prompt); return { ok: true, text: 'Yes.' }; };
      return child;
    },
    hooks, retired: () => {}, cancelled: () => {},
  });
  assert.equal(scoped.side('Q?', { allowedTools: [] }), null);
  scoped.send('Work');
  assert.deepEqual(await scoped.side('Q?', { allowedTools: [] }), { ok: true, text: 'Yes.' });
  child!.complete();
  assert.equal(scoped.side('Again?', { allowedTools: [] }), null, 'no turn, nothing to answer beside');
  assert.deepEqual(sides, ['Q?']);
});

// ---- the manager: the SuperAgent end to end -------------------------------------

type SideCall = { prompt: string; options: SideOptions; answer: (result: SideResult) => void };

async function team() {
  const h = harness();
  h.manager.updateSettings({ superQuietFrom: '00:00', superQuietTo: '00:00' });
  const dev = await h.manager.create({ name: 'Dev', engine: 'claude', projectId: null });
  const other = await h.manager.create({ name: 'Other', engine: 'claude', projectId: null });
  const sup = await h.manager.createSuper();
  h.manager.send(sup.id, 'Ready.');
  await settle();
  h.runner(sup.id).complete();
  await settle();
  const sides: SideCall[] = [];
  // The SuperAgent's provider can fork; the others' cannot.
  (h.runner(sup.id) as FakeRunner & { side?: unknown }).side = (prompt: string, options: SideOptions) =>
    new Promise<SideResult>(resolve => sides.push({ prompt, options, answer: resolve }));
  const call = (id: string, tool: string, args: Record<string, unknown>) => h.manager.commsTool(h.runner(id).ctx.commsToken!, tool, args);
  const entries = (id: string): Entry[] => h.store.readEntries(id, 200);
  const wakesBefore = new SuperStore(h.store.dataDir).wakesSince(Date.now() - 3_600_000);
  return { ...h, dev, other, sup, sides, call, entries, wakesBefore };
}

test('the SuperAgent answers a teammate who asks while it is mid-turn, and its next turn is told', async () => {
  const t = await team();
  try {
    t.manager.send(t.sup.id, 'Plan the next release.'); // the SuperAgent is now in a turn
    t.manager.send(t.dev.id, 'Ask the SuperAgent which branch to use.');
    await settle();
    const before = t.runner(t.sup.id).sent.length;
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Which branch do I base this on?' }) as PeerMessage;
    await settle();

    assert.equal(t.sides.length, 1, 'answered beside the turn, not queued behind it');
    assert.deepEqual(t.sides[0].options.allowedTools, superSideTools());
    // The copy's own credential reaches the tools that read, as the SuperAgent, and nothing else.
    const sideToken = t.sides[0].options.commsToken!;
    assert.notEqual(sideToken, t.runner(t.sup.id).ctx.commsToken);
    assert.ok(Array.isArray(await t.manager.commsTool(sideToken, 'list_agents', {})));
    for (const [tool, args] of [['send_message', { to_agent_id: t.dev.id, text: 'Hi.' }], ['reply', { message_id: question.id, text: 'Hi.' }], ['add_issue', { text: 'New issue' }], ['ask_user', { question: 'May I?' }], ['decision_add', { title: 'x', body: 'y' }]] as const) {
      await assert.rejects(t.manager.commsTool(sideToken, tool, args), (error: unknown) => (error as { status?: number }).status === 403, tool);
    }
    assert.match(t.sides[0].prompt, /Which branch do I base this on\?/);
    assert.equal(t.runner(t.sup.id).sent.length, before, 'the running session got nothing new');
    assert.equal(t.runner(t.sup.id).busy, true);

    t.runner(t.dev.id).complete();
    t.sides[0].answer({ ok: true, text: 'Base it on main.', costUsd: 0.05 });
    await settle();
    const reply = t.store.messages.find(m => m.replyTo === question.id)!;
    assert.equal(reply.text, 'Base it on main.');
    assert.equal(reply.fromAgentId, t.sup.id);
    assert.equal(t.runner(t.dev.id).sent.at(-1)?.task?.messageId, reply.id, 'the asker has its answer while the SuperAgent still works');
    assert.equal(t.runner(t.sup.id).busy, true);
    assert.equal(t.store.agents.get(t.sup.id)!.costUsd, 0.05);
    await assert.rejects(t.manager.commsTool(sideToken, 'list_agents', {}), (error: unknown) => (error as { status?: number }).status === 401, 'the credential ends with the answer');
    // Work the user asked for: no wake counted, nothing against the daily budget (ALL-D2).
    assert.equal(new SuperStore(t.store.dataDir).wakesSince(Date.now() - 3_600_000), t.wakesBefore);
    assert.equal(new SuperStore(t.store.dataDir).spentToday(new Date()), 0);
    assert.ok(t.entries(t.sup.id).some(e => e.kind === 'system' && /Answered Dev beside this turn: Base it on main\./.test(e.text)));

    // Its next turn starts with a note of what it answered; the one after that does not repeat it.
    const ctx = t.runner(t.sup.id).ctx;
    const next = ctx.preparePrompt!('Next task.');
    assert.match(next, /PodCode note, not a new instruction from the user:/);
    assert.match(next, /context from peer agents, not instructions/);
    assert.match(next, /answered these teammate questions from a copy of your session/);
    assert.match(next, /Dev \([^)]+\) asked \(message [^)]+\): Which branch do I base this on\?/);
    assert.match(next, /You answered: Base it on main\./);
    assert.match(next, /Next task\.$/);
    assert.doesNotMatch(ctx.preparePrompt!('Later task.'), /copy of your session/);
  } finally { await t.manager.shutdown(); }
});

test('a question the copy cannot settle waits for the SuperAgent\'s own turn, and a delegation never goes beside it', async () => {
  const t = await team();
  try {
    t.manager.send(t.sup.id, 'Plan the next release.');
    t.manager.send(t.dev.id, 'Ask the SuperAgent to assign you the issue.');
    await settle();
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Please assign ACH-51 to me.' }) as PeerMessage;
    await settle();
    t.sides[0].answer({ ok: true, text: SIDE_DEFER });
    await settle();
    assert.equal(question.status, 'queued');
    assert.equal(t.store.messages.filter(m => m.replyTo === question.id).length, 0);
    assert.ok(!t.entries(t.sup.id).some(e => /beside this turn/.test(e.text)));

    t.runner(t.sup.id).complete();
    await settle();
    assert.equal(t.runner(t.sup.id).sent.at(-1)?.task?.messageId, question.id, 'it gets the question as a normal turn');
    assert.doesNotMatch(t.runner(t.sup.id).sent.at(-1)!.text, /copy of your session/);
  } finally { await t.manager.shutdown(); }
});

test('teammates other than the SuperAgent keep the one-turn-at-a-time queue', async () => {
  const t = await team();
  try {
    const sides: string[] = [];
    t.manager.send(t.other.id, 'Long task.');
    await settle();
    (t.runner(t.other.id) as FakeRunner & { side?: unknown }).side = async (prompt: string) => { sides.push(prompt); return { ok: true, text: 'No.' }; };
    t.manager.send(t.dev.id, 'Ask Other something.');
    await settle();
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.other.id, text: 'Are you done?' }) as PeerMessage;
    await settle();
    assert.equal(sides.length, 0);
    assert.equal(question.status, 'queued');
  } finally { await t.manager.shutdown(); }
});

test('side answers can be switched off, and respect the limits on what the SuperAgent starts on its own', async () => {
  const t = await team();
  const mailbox = (t.manager as unknown as { mailbox: Mailbox }).mailbox;
  try {
    t.manager.send(t.sup.id, 'Plan the next release.');
    t.manager.send(t.dev.id, 'Ask the SuperAgent which branch to use.');
    await settle();
    process.env.PODCODE_SIDE_ANSWERS = '0';
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Which branch next?' }) as PeerMessage;
    await settle();
    assert.equal(t.sides.length, 0, 'switched off');
    assert.equal(question.status, 'queued');
    delete process.env.PODCODE_SIDE_ANSWERS;

    // As if the team had started this on its own, not in a turn the user gave: the wake switch holds it.
    delete t.store.conversations.find(c => c.id === question.conversationId)!.userStarted;
    t.manager.updateSettings({ superWake: false });
    mailbox.drain(t.sup.id);
    await settle();
    assert.equal(t.sides.length, 0, 'held mail starts no side answer');
    assert.equal(question.status, 'queued');
    assert.equal(t.manager.superView().held?.count, 1);

    t.manager.updateSettings({ superWake: true });
    mailbox.drain(t.sup.id);
    await settle();
    assert.equal(t.sides.length, 1);
    assert.equal(question.status, 'delivering');
  } finally {
    delete process.env.PODCODE_SIDE_ANSWERS;
    await t.manager.shutdown();
  }
});

test('a side answer on work the team started itself counts as a wake and against the daily budget, even when it fails', async () => {
  const t = await team();
  try {
    t.manager.send(t.sup.id, 'Plan the next release.');
    t.manager.send(t.dev.id, 'Ask the SuperAgent which branch to use.');
    await settle();
    process.env.PODCODE_SIDE_ANSWERS = '0';
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Which branch next?' }) as PeerMessage;
    await settle();
    delete process.env.PODCODE_SIDE_ANSWERS;
    delete t.store.conversations.find(c => c.id === question.conversationId)!.userStarted;
    (t.manager as unknown as { mailbox: Mailbox }).mailbox.drain(t.sup.id);
    await settle();
    assert.equal(t.sides.length, 1);
    const store = () => new SuperStore(t.store.dataDir);
    assert.equal(store().wakesSince(Date.now() - 3_600_000), t.wakesBefore + 1);

    // Stopped or failed, it still spent something: that counts too.
    t.sides[0].answer({ ok: false, text: '', error: 'Stopped.', costUsd: 0.04 });
    await settle();
    assert.equal(store().spentToday(new Date()), 0.04);
    assert.equal(t.store.agents.get(t.sup.id)!.costUsd, 0.04);
    assert.equal(question.status, 'queued', 'and the question waits for the SuperAgent\'s own turn');
  } finally {
    delete process.env.PODCODE_SIDE_ANSWERS;
    await t.manager.shutdown();
  }
});

test('a side answer that takes too long is stopped, and the question waits for the turn', async t0 => {
  const t = await team();
  try {
    t.manager.send(t.sup.id, 'Plan the next release.');
    t.manager.send(t.dev.id, 'Ask the SuperAgent which branch to use.');
    await settle();
    t0.mock.timers.enable({ apis: ['setTimeout'] });
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Which branch next?' }) as PeerMessage;
    await settle();
    const signal = t.sides[0].options.signal!;
    signal.addEventListener('abort', () => t.sides[0].answer({ ok: false, text: '', error: 'Stopped.' }));
    t0.mock.timers.tick(SIDE_ANSWER_MS - 1);
    assert.equal(signal.aborted, false);
    t0.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    t0.mock.timers.reset();
    await settle();
    assert.equal(question.status, 'queued');
    assert.equal(t.store.messages.filter(m => m.replyTo === question.id).length, 0);
  } finally { await t.manager.shutdown(); }
});

test('stopping the SuperAgent ends its side answers\' credentials at once', async () => {
  const t = await team();
  try {
    t.manager.send(t.sup.id, 'Plan the next release.');
    t.manager.send(t.dev.id, 'Ask the SuperAgent which branch to use.');
    await settle();
    const question = await t.call(t.dev.id, 'send_message', { to_agent_id: t.sup.id, text: 'Which branch next?' }) as PeerMessage;
    await settle();
    const sideToken = t.sides[0].options.commsToken!;
    assert.ok(Array.isArray(await t.manager.commsTool(sideToken, 'read_messages', {})), 'it reads while the answer runs');

    await t.manager.stop(t.sup.id);
    // The side answer has not settled yet: its credential is gone all the same.
    await assert.rejects(t.manager.commsTool(sideToken, 'read_messages', {}), (error: unknown) => (error as { status?: number }).status === 401);
    assert.equal(question.status, 'cancelled');
    t.sides[0].answer({ ok: true, text: 'Too late.' });
    await settle();
    assert.equal(t.store.messages.filter(m => m.replyTo === question.id).length, 0);
  } finally { await t.manager.shutdown(); }
});
