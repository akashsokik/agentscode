import { useSyncExternalStore } from 'react';
import type { Agent, AgentDreams, Approval, Channel, ChannelPost, Conversation, DreamStatsReport, Entry, MemoryEntry, PeerMessage, Project, ServerEvent, Snapshot, TerminalInfo } from '../shared/types.ts';
import { api } from './api.ts';

export interface Toast {
  id: number;
  tone: 'error' | 'info';
  text: string;
}

export interface AppState {
  connection: 'connecting' | 'open' | 'closed';
  snapshot: Snapshot | null;
  /** Transcripts for agents whose pane has been opened, kept live by entry events. */
  entries: Record<string, Entry[]>;
  /** Posts for channels whose pane has been opened, kept live by post events. */
  posts: Record<string, ChannelPost[]>;
  /** Open terminals in every project, kept live by terminals events. */
  terminals: TerminalInfo[];
  /** What each agent remembered, oldest first, for agents whose memory has been shown; kept live by memory events. */
  memory: Record<string, MemoryEntry[]>;
  /** Each shown agent's dreams (newest first), its numbers and any soul change waiting for the user; kept live by dream events. */
  dreams: Record<string, AgentDreams>;
  /** Dreaming numbers for every agent and for the agents with dreaming on and off, once asked for. */
  dreamStats: DreamStatsReport | null;
  toasts: Toast[];
}

let state: AppState = { connection: 'connecting', snapshot: null, entries: {}, posts: {}, terminals: [], memory: {}, dreams: {}, dreamStats: null, toasts: [] };
const listeners = new Set<() => void>();

function setState(update: (current: AppState) => AppState): void {
  state = update(state);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read a slice of app state. Selectors must return stable references (state slices, not new objects). */
export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function getState(): AppState {
  return state;
}

// ---- toasts ---------------------------------------------------------------

let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'error'): void {
  const id = ++toastId;
  setState(s => ({ ...s, toasts: [...s.toasts, { id, tone, text }].slice(-4) }));
  setTimeout(() => dismissToast(id), tone === 'error' ? 7000 : 3500);
}

export function dismissToast(id: number): void {
  setState(s => ({ ...s, toasts: s.toasts.filter(t => t.id !== id) }));
}

/** Run an API call and surface its error as a toast. Resolves undefined on failure. */
export async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    toast((error as Error).message || 'Something went wrong.');
    return undefined;
  }
}

// ---- terminals ------------------------------------------------------------

/** Change the terminal list ahead of the server's own update, so a new or closed tab shows at once. */
export function updateTerminals(update: (list: TerminalInfo[]) => TerminalInfo[]): void {
  setState(s => ({ ...s, terminals: update(s.terminals) }));
}

// ---- transcripts ----------------------------------------------------------

/** Live entry events that arrive while an agent's history is being fetched, applied once it lands. */
const buffers = new Map<string, Entry[]>();

export async function loadEntries(agentId: string, force = false): Promise<void> {
  if ((!force && state.entries[agentId]) || buffers.has(agentId)) return;
  buffers.set(agentId, []);
  try {
    // Server order is first-seen order; replaying the buffered events in arrival order ends on
    // the newest version of each entry, because the server writes before it broadcasts.
    let list = await api.entries(agentId);
    for (const entry of buffers.get(agentId) ?? []) list = upsertEntry(list, entry);
    setState(s => ({ ...s, entries: { ...s.entries, [agentId]: list } }));
  } catch (error) {
    toast((error as Error).message);
  } finally {
    buffers.delete(agentId);
  }
}

// ---- memory ---------------------------------------------------------------

/** Agents whose memory is being fetched; a memory event meanwhile is newer than the fetch. */
const memoryLoads = new Map<string, { overtaken: boolean }>();

export async function loadMemory(agentId: string, force = false): Promise<void> {
  if ((!force && state.memory[agentId]) || memoryLoads.has(agentId)) return;
  const load = { overtaken: false };
  memoryLoads.set(agentId, load);
  try {
    const list = await api.memory(agentId);
    if (!load.overtaken) setState(s => ({ ...s, memory: { ...s.memory, [agentId]: list } }));
  } catch (error) {
    toast((error as Error).message);
  } finally {
    memoryLoads.delete(agentId);
  }
}

// ---- dreams ---------------------------------------------------------------

/** Fetches in flight; one asked for again meanwhile runs once more when it lands, so the numbers end current. */
const dreamLoads = new Map<string, { again: boolean }>();

export async function loadDreams(agentId: string, force = false): Promise<void> {
  const running = dreamLoads.get(agentId);
  if (running) { if (force) running.again = true; return; }
  if (!force && state.dreams[agentId]) return;
  const load = { again: false };
  dreamLoads.set(agentId, load);
  try {
    const { dreams, stats, proposal } = await api.dreams(agentId);
    setState(s => ({ ...s, dreams: { ...s.dreams, [agentId]: { dreams, stats, proposal } } }));
  } catch (error) {
    toast((error as Error).message);
  } finally {
    dreamLoads.delete(agentId);
  }
  if (load.again) void loadDreams(agentId, true);
}

let teamLoad: { again: boolean } | null = null;

export async function loadDreamStats(force = false): Promise<void> {
  if (teamLoad) { if (force) teamLoad.again = true; return; }
  if (!force && state.dreamStats) return;
  const load = { again: false };
  teamLoad = load;
  try {
    const stats = await api.dreamStats();
    setState(s => ({ ...s, dreamStats: stats }));
  } catch (error) {
    toast((error as Error).message);
  } finally {
    teamLoad = null;
  }
  if (load.again) void loadDreamStats(true);
}

// ---- channel posts --------------------------------------------------------

/** Post events that arrive while a channel's history is being fetched, applied once it lands. */
const postBuffers = new Map<string, ChannelPost[]>();

export async function loadPosts(channelId: string, force = false): Promise<void> {
  if ((!force && state.posts[channelId]) || postBuffers.has(channelId)) return;
  postBuffers.set(channelId, []);
  try {
    let list = await api.channelPosts(channelId);
    for (const post of postBuffers.get(channelId) ?? []) list = upsertById(list, post);
    setState(s => ({ ...s, posts: { ...s.posts, [channelId]: list } }));
  } catch (error) {
    toast((error as Error).message);
  } finally {
    postBuffers.delete(channelId);
  }
}

function upsertEntry(list: Entry[], entry: Entry): Entry[] {
  const index = list.findIndex(e => e.id === entry.id);
  if (index === -1) return [...list, entry];
  const next = list.slice();
  next[index] = { ...next[index], ...entry, ts: next[index].ts };
  return next;
}

// ---- snapshot reducer -----------------------------------------------------

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex(x => x.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function apply(snapshot: Snapshot, event: ServerEvent): Snapshot {
  switch (event.type) {
    case 'agent':
      return { ...snapshot, agents: upsertById<Agent>(snapshot.agents, event.agent) };
    case 'agentRemoved':
      return {
        ...snapshot,
        agents: snapshot.agents.filter(a => a.id !== event.id),
        approvals: snapshot.approvals.filter(a => a.agentId !== event.id),
      };
    case 'project':
      return { ...snapshot, projects: upsertById<Project>(snapshot.projects, event.project) };
    case 'projectRemoved':
      return { ...snapshot, projects: snapshot.projects.filter(p => p.id !== event.id) };
    case 'message':
      return { ...snapshot, messages: upsertById<PeerMessage>(snapshot.messages, event.message).slice(-800) };
    case 'conversation':
      return { ...snapshot, conversations: upsertById<Conversation>(snapshot.conversations, event.conversation) };
    case 'channel':
      return { ...snapshot, channels: upsertById<Channel>(snapshot.channels, event.channel) };
    case 'channelRemoved':
      return { ...snapshot, channels: snapshot.channels.filter(c => c.id !== event.id) };
    case 'approval':
      return { ...snapshot, approvals: upsertById<Approval>(snapshot.approvals, event.approval) };
    case 'approvalResolved':
      return { ...snapshot, approvals: snapshot.approvals.filter(a => a.id !== event.id) };
    case 'settings':
      return { ...snapshot, settings: event.settings };
    case 'models':
      return { ...snapshot, models: event.models };
    case 'profile':
      return { ...snapshot, profile: event.profile };
    case 'super':
      return { ...snapshot, super: event.super };
    default:
      return snapshot;
  }
}

function handle(event: ServerEvent): void {
  if (event.type === 'snapshot') {
    const known = Object.keys(state.entries);
    const channels = Object.keys(state.posts);
    const remembered = Object.keys(state.memory);
    const dreamed = Object.keys(state.dreams);
    setState(s => ({ ...s, snapshot: event.data }));
    // Anything may have happened while disconnected; reload the open transcripts and channels.
    for (const id of known) {
      if (event.data.agents.some(a => a.id === id)) void loadEntries(id, true);
    }
    for (const id of channels) {
      if (event.data.channels.some(c => c.id === id)) void loadPosts(id, true);
    }
    for (const id of remembered) {
      if (event.data.agents.some(a => a.id === id)) void loadMemory(id, true);
    }
    for (const id of dreamed) {
      if (event.data.agents.some(a => a.id === id)) void loadDreams(id, true);
    }
    if (state.dreamStats) void loadDreamStats(true);
    return;
  }
  if (event.type === 'post') {
    const { post } = event;
    postBuffers.get(post.channelId)?.push(post);
    if (!state.posts[post.channelId]) return;
    setState(s => ({ ...s, posts: { ...s.posts, [post.channelId]: upsertById(s.posts[post.channelId] ?? [], post) } }));
    return;
  }
  if (event.type === 'channelRemoved') {
    setState(s => {
      const posts = { ...s.posts };
      delete posts[event.id];
      return { ...s, posts };
    });
  }
  if (event.type === 'entry') {
    const { entry } = event;
    buffers.get(entry.agentId)?.push(entry);
    if (!state.entries[entry.agentId]) return;
    setState(s => ({ ...s, entries: { ...s.entries, [entry.agentId]: upsertEntry(s.entries[entry.agentId] ?? [], entry) } }));
    return;
  }
  if (event.type === 'dream') {
    const { agentId, dream } = event;
    // The record shows at once; the numbers it moved come with a fresh fetch.
    setState(s => {
      const current = s.dreams[agentId];
      if (!current) return s;
      const rest = current.dreams.filter(d => d.id !== dream.id);
      const dreams = [dream, ...rest].sort((a, b) => b.at - a.at);
      return { ...s, dreams: { ...s.dreams, [agentId]: { ...current, dreams } } };
    });
    if (state.dreams[agentId]) void loadDreams(agentId, true);
    if (state.dreamStats) void loadDreamStats(true);
    return;
  }
  if (event.type === 'soulProposal') {
    const { agentId, proposal } = event;
    setState(s => {
      const current = s.dreams[agentId];
      return current ? { ...s, dreams: { ...s.dreams, [agentId]: { ...current, proposal } } } : s;
    });
    return;
  }
  if (event.type === 'memory') {
    // Every event carries the whole list, so it simply replaces what is here.
    const loading = memoryLoads.get(event.agentId);
    if (loading) loading.overtaken = true;
    setState(s => ({ ...s, memory: { ...s.memory, [event.agentId]: event.entries } }));
    return;
  }
  if (event.type === 'terminals') {
    setState(s => ({ ...s, terminals: event.terminals }));
    return;
  }
  if (event.type === 'agentRemoved') {
    setState(s => {
      const entries = { ...s.entries };
      delete entries[event.id];
      const memory = { ...s.memory };
      delete memory[event.id];
      const dreams = { ...s.dreams };
      delete dreams[event.id];
      return { ...s, entries, memory, dreams };
    });
  }
  if (!state.snapshot) return;
  setState(s => ({ ...s, snapshot: s.snapshot && apply(s.snapshot, event) }));
}

// ---- connection -----------------------------------------------------------

let socket: WebSocket | null = null;
let retry = 0;

export function connect(): void {
  if (socket) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;
  setState(s => ({ ...s, connection: s.snapshot ? s.connection : 'connecting' }));
  ws.onopen = () => {
    retry = 0;
    setState(s => ({ ...s, connection: 'open' }));
  };
  ws.onmessage = (message) => {
    try {
      handle(JSON.parse(String(message.data)) as ServerEvent);
    } catch (error) {
      console.error('[ws] bad event', error);
    }
  };
  ws.onclose = () => {
    socket = null;
    setState(s => ({ ...s, connection: 'closed' }));
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}
