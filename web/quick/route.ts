/**
 * Where a quick message goes and what the team is doing, for the quick composer. Pure, apart from
 * the api it is handed, so it is tested directly.
 */
import { alignHints, type MentionHint } from '../../shared/mentions.ts';
import type { Agent, Approval, CreateAgentRequest, EngineKind, SuperState } from '../../shared/types.ts';

/** The SuperAgent (the default), an agent you already have, or a new agent in a project (null: all projects). */
export type QuickTarget =
  | { kind: 'super' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'new'; projectId: string | null; engine: EngineKind; model: string };

/** What the composer needs from the server; the page passes `api`, tests a fake. */
export interface QuickApi {
  send(agentId: string, text: string, images?: undefined, mentionHints?: MentionHint[]): Promise<unknown>;
  createSuper(): Promise<Agent>;
  createAgent(input: CreateAgentRequest): Promise<Agent>;
  answerSuper(askId: string, body: { answer: string } | { dismiss: true }): Promise<SuperState>;
}

/** Names teammates read in messages; a new agent takes the first one free. */
export const AGENT_NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fen', 'Gus', 'Hal', 'Ivy', 'Jun', 'Kai', 'Lux', 'Mo', 'Nia', 'Oz', 'Pia', 'Quin', 'Rae', 'Sol', 'Tam', 'Uma', 'Vic', 'Wren', 'Xan'];

export function newAgentName(agents: readonly Pick<Agent, 'name'>[]): string {
  const taken = new Set(agents.map(a => a.name.toLowerCase()));
  const free = AGENT_NAMES.find(n => !taken.has(n.toLowerCase()));
  if (free) return free;
  for (let i = 2; ; i++) {
    const name = `Agent ${i}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * Send a quick message to its target and return the agent that has it: the SuperAgent (set up on
 * the way if there is none), an existing agent, or a new agent whose first task it is. `picks`: what
 * was picked from the @ picker, so a name shared by an agent and a project keeps the kind picked.
 */
export async function sendQuick(target: QuickTarget, rawText: string, team: { agents: readonly Agent[]; superId: string | null }, api: QuickApi, picks: readonly MentionHint[] = []): Promise<{ agentId: string; created: boolean }> {
  const text = rawText.trim();
  if (!text) throw new Error('Write something first.');
  const hints = alignHints(text, picks);
  const mentionHints = hints.length ? hints : undefined;
  if (target.kind === 'super') {
    const id = team.superId ?? (await api.createSuper()).id;
    await api.send(id, text, undefined, mentionHints);
    return { agentId: id, created: !team.superId };
  }
  if (target.kind === 'agent') {
    if (!team.agents.some(a => a.id === target.agentId)) throw new Error('That agent is gone. Pick another.');
    await api.send(target.agentId, text, undefined, mentionHints);
    return { agentId: target.agentId, created: false };
  }
  const agent = await api.createAgent({
    name: newAgentName(team.agents), engine: target.engine, projectId: target.projectId, role: 'dev',
    ...(target.model ? { model: target.model } : {}), task: text, ...(mentionHints ? { mentionHints } : {}),
  });
  return { agentId: agent.id, created: true };
}

/** Answer one of the SuperAgent's questions with a choice, or put it aside. */
export function answerQuick(api: QuickApi, askId: string, choice: string | null): Promise<SuperState> {
  return api.answerSuper(askId, choice === null ? { dismiss: true } : { answer: choice });
}

export type TeamState = 'needs-you' | 'stuck' | 'working' | 'failed' | 'done' | 'idle';

/** A turn running this long counts as stuck (as the SuperAgent's watcher counts it). */
export const STUCK_MS = 45 * 60_000;

export interface TeamMember {
  id: string;
  name: string;
  state: TeamState;
  /** What it is on, for the tooltip. */
  detail: string;
}

const ORDER: TeamState[] = ['needs-you', 'stuck', 'working', 'failed', 'done', 'idle'];

/** The team at a glance, the SuperAgent left out: who needs you first, then stuck, working, failed, done and idle. */
export function teamStatus(agents: readonly Agent[], approvals: readonly Pick<Approval, 'agentId'>[], now: number): TeamMember[] {
  return agents
    .filter(a => a.role !== 'super')
    .map((a): TeamMember => {
      const waiting = a.status === 'waiting' || approvals.some(p => p.agentId === a.id);
      const state: TeamState = waiting ? 'needs-you'
        : a.status === 'working' ? (a.turnStartedAt && now - a.turnStartedAt > STUCK_MS ? 'stuck' : 'working')
        : a.status === 'error' ? 'failed'
        : a.status === 'done' ? 'done' : 'idle';
      const detail = state === 'needs-you' ? (a.activity || 'Waiting for you')
        : state === 'stuck' ? `On one turn for ${Math.round((now - (a.turnStartedAt ?? now)) / 60_000)} min`
        : state === 'working' ? (a.activity || 'Working')
        : state === 'failed' ? (a.error || 'Hit a problem')
        : a.lastSummary || (state === 'done' ? 'Done' : 'Idle');
      return { id: a.id, name: a.name, state, detail };
    })
    .sort((x, y) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state) || x.name.localeCompare(y.name));
}

/** The agent a target's replies come from, if it exists yet. */
export function targetAgentId(target: QuickTarget, superId: string | null): string | null {
  return target.kind === 'super' ? superId : target.kind === 'agent' ? target.agentId : null;
}

/**
 * Where Home's composer sends: a message that opens with @Name goes to that agent (or the
 * SuperAgent), with the mention taken off since it only addressed it; anything else goes to the
 * chip that is picked. The longest matching name wins, so "@Agent 12" is not read as "Agent 1".
 */
export function homeTarget(rawText: string, agents: readonly Pick<Agent, 'id' | 'name' | 'role'>[], picked: QuickTarget): { target: QuickTarget; text: string } {
  const text = rawText.trim();
  if (!text.startsWith('@')) return { target: picked, text };
  const rest = text.slice(1);
  const lower = rest.toLowerCase();
  const named = [...agents.map(a => ({ name: a.name, target: (a.role === 'super' ? { kind: 'super' } : { kind: 'agent', agentId: a.id }) as QuickTarget })), { name: 'SuperAgent', target: { kind: 'super' } as QuickTarget }]
    .filter(entry => entry.name && lower.startsWith(entry.name.toLowerCase()) && !/[\p{L}\p{N}_-]/u.test(rest.charAt(entry.name.length)))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!named) return { target: picked, text };
  return { target: named.target, text: rest.slice(named.name.length).replace(/^[\s,:]+/, '') };
}

/** Home's "pick up where you left off": the agents that need you first, then the most recently active. */
export function homeRecent<A extends Pick<Agent, 'id' | 'status' | 'lastActiveAt'>>(agents: readonly A[], pendingIds: ReadonlySet<string>, limit: number): A[] {
  const needs = (a: A) => (a.status === 'waiting' || pendingIds.has(a.id) ? 0 : 1);
  return [...agents].sort((a, b) => needs(a) - needs(b) || b.lastActiveAt - a.lastActiveAt).slice(0, limit);
}
