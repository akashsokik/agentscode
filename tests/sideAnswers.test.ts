import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { Agent, AgentTask, ApprovalDecision, Entry, PeerMessage } from '../shared/types.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import { ClaudeRunner, superSideTools } from '../server/agents/claude.ts';
import type { RunnerHooks, SideOptions, SideResult } from '../server/agents/runner.ts';
import { ScopedRunner } from '../server/agents/scoped.ts';
import { Mailbox, SIDE_DEFER, SIDE_LIMIT, sidePrompt, type SideAnswer } from '../server/comms/mailbox.ts';
import { COMMS_SERVER } from '../server/config.ts';
import { Store } from '../server/store.ts';
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
  t.busy.add('s');
  const task = t.mailbox.delegate('a', 's', { kind: 'implementation', task: 'Coordinate this.', acceptanceCriteria: 'Done.' });
  const news = t.mailbox.send('b', 's', 'FYI: the build is green.', false);
  await settle();
  assert.equal(t.asked.length, 0);
  assert.equal(task.status, 'queued');
  assert.equal(news.status, 'queued');
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

/** The SDK stand-in: a streaming session that stays in its turn, and one-shot forks that answer. */
function fakeQuery(calls: Call[], fork: { text?: string; fail?: boolean; hang?: boolean } = {}) {
  return ((params: { prompt: unknown; options: Options }) => {
    const call: Call = { prompt: params.prompt, options: params.options, closed: false };
    calls.push(call);
    async function* session() {
      yield { type: 'system', subtype: 'init', session_id: 'session-1' };
      await (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      yield { type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Working on it.' }] } };
      await new Promise(() => {}); // the turn keeps running
    }
    async function* side() {
      yield { type: 'system', subtype: 'init', session_id: 'fork-1' };
      if (fork.hang) {
        const signal = (params.options.abortController as AbortController).signal;
        await new Promise((_, reject) => signal.aborted ? reject(new Error('aborted')) : signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      yield { type: 'assistant', uuid: 'f1', parent_tool_use_id: null, message: { content: [{ type: 'text', text: fork.text ?? 'Base it on main.' }] } };
      if (fork.fail) yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['It broke.'], total_cost_usd: 0.01 };
      else yield { type: 'result', subtype: 'success', is_error: false, result: fork.text ?? 'Base it on main.', total_cost_usd: 0.03, usage: { input_tokens: 3, output_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 80 } };
    }
    return Object.assign(typeof params.prompt === 'string' ? side() : session(), {
      interrupt: async () => {}, setPermissionMode: async () => {}, setModel: async () => {},
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
  assert.deepEqual(fork.options.allowedTools, superSideTools());
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
  assert.equal((await fork.options.canUseTool('Read', {}, {})).behavior, 'allow');
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
  failed.runner.close();

  const hanging: Call[] = [];
  const hung = claudeRunner(hanging, { hang: true });
  hung.runner.send('Update', { summary: 'Update', source: 'system' });
  await settle(10);
  const pending = hung.runner.side('Question?', { allowedTools: [] })!;
  await hung.runner.interrupt();
  const stopped = await pending;
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error, 'Stopped.');
  hung.runner.close();
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
  return { ...h, dev, other, sup, sides, call, entries };
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
    assert.ok(t.entries(t.sup.id).some(e => e.kind === 'system' && /Answered Dev beside this turn: Base it on main\./.test(e.text)));

    // Its next turn starts with a note of what it answered; the one after that does not repeat it.
    const ctx = t.runner(t.sup.id).ctx;
    const next = ctx.preparePrompt!('Next task.');
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
