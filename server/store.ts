import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Agent, type Channel, type ChannelPost, type Conversation, type Entry, type PeerMessage, type Project, type Settings } from '../shared/types.ts';
import { DATA_DIR } from './config.ts';
import { threadRoot, withThreadRoots } from './comms/threads.ts';
import { normalizeProjectIds } from '../shared/agentProjects.ts';

interface PersistedState {
  version: 1;
  /** Each with the old projectId beside projectIds (legacyProjectId), for an older build. */
  agents: (Agent & { projectId?: string | null })[];
  projects: Project[];
  settings: Settings;
  messages: PeerMessage[];
  conversations: Conversation[];
  channels?: Channel[];
}

/** Posts kept in memory per channel; the JSONL file keeps everything. */
const MAX_POSTS = 1000;

/** Older messages are dropped from state.json; transcripts keep their own copy. */
const MAX_MESSAGES = 2000;

/**
 * All durable state lives in ~/.podcode: one JSON file for agents, projects, settings,
 * channels and agent-to-agent mail, plus append-only JSONL files for each agent's
 * transcript and each channel's posts.
 */
export class Store {
  agents = new Map<string, Agent>();
  projects = new Map<string, Project>();
  settings: Settings = { ...DEFAULT_SETTINGS };
  messages: PeerMessage[] = [];
  conversations: Conversation[] = [];
  channels = new Map<string, Channel>();
  /** Recent posts per channel, oldest first. */
  posts = new Map<string, ChannelPost[]>();
  readonly dataDir: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private stateFile: string;
  private transcriptsDir: string;
  private channelsDir: string;

  constructor(dataDir = DATA_DIR) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'state.json');
    this.transcriptsDir = path.join(dataDir, 'transcripts');
    this.channelsDir = path.join(dataDir, 'channels');
  }

  load(): void {
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
    fs.mkdirSync(this.channelsDir, { recursive: true });
    if (!fs.existsSync(this.stateFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Partial<PersistedState>;
      for (const p of raw.projects ?? []) this.projects.set(p.id, p);
      // Projects are read first, so a damaged project choice can fall back to a project that exists.
      for (const a of raw.agents ?? []) this.agents.set(a.id, migrateAgentProjects(a, id => this.projects.has(id)));
      this.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
      this.messages = raw.messages ?? [];
      this.conversations = raw.conversations ?? [];
      for (const c of raw.channels ?? []) {
        this.channels.set(c.id, c);
        this.posts.set(c.id, this.readPosts(c.id));
      }
    } catch (err) {
      const backup = `${this.stateFile}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.stateFile, backup);
      console.error(`[store] could not parse ${this.stateFile}; moved a copy to ${backup}`, err);
    }
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 150);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
      // A conversation whose mail is all gone goes too; one newer than the oldest kept message may
      // be about to get its first.
      const live = new Set(this.messages.map(m => m.conversationId));
      const oldest = this.messages[0]?.ts ?? 0;
      this.conversations = this.conversations.filter(c => live.has(c.id) || c.createdAt >= oldest);
    }
    const state: PersistedState = {
      version: 1,
      // projectId too, for an older build: the start folder, or null only for an agent on every project.
      agents: [...this.agents.values()].map(a => ({ ...a, projectId: legacyProjectId(a) })),
      projects: [...this.projects.values()],
      settings: this.settings,
      messages: this.messages,
      conversations: this.conversations,
      channels: [...this.channels.values()],
    };
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, this.stateFile);
  }

  private transcriptPath(agentId: string): string {
    return path.join(this.transcriptsDir, `${agentId}.jsonl`);
  }

  /** Entries are upserts: a later line with the same id replaces the earlier one. */
  appendEntry(entry: Entry): void {
    fs.appendFileSync(this.transcriptPath(entry.agentId), `${JSON.stringify(entry)}\n`);
  }

  readEntries(agentId: string, limit = 500): Entry[] {
    const file = this.transcriptPath(agentId);
    if (!fs.existsSync(file)) return [];
    const byId = new Map<string, Entry>();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as Entry;
        byId.set(entry.id, { ...byId.get(entry.id), ...entry });
      } catch {
        // a torn final line after a crash; skip it
      }
    }
    return [...byId.values()].slice(-limit);
  }

  deleteTranscript(agentId: string): void {
    fs.rmSync(this.transcriptPath(agentId), { force: true });
  }

  private postsPath(channelId: string): string {
    return path.join(this.channelsDir, `${channelId}.jsonl`);
  }

  /** Add or update a post in memory and on disk. Like entries, a later line with the same id wins. */
  savePost(post: ChannelPost): void {
    const list = this.posts.get(post.channelId) ?? [];
    const index = list.findIndex(p => p.id === post.id);
    if (index === -1) list.push(post);
    else list[index] = post;
    this.posts.set(post.channelId, list.length > MAX_POSTS ? withThreadRoots(list, MAX_POSTS) : list);
    fs.mkdirSync(this.channelsDir, { recursive: true });
    fs.appendFileSync(this.postsPath(post.channelId), `${JSON.stringify(post)}\n`);
  }

  private readPosts(channelId: string): ChannelPost[] {
    const file = this.postsPath(channelId);
    if (!fs.existsSync(file)) return [];
    const byId = new Map<string, ChannelPost>();
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const post = JSON.parse(line) as ChannelPost;
        byId.set(post.id, post);
      } catch {
        // a torn final line after a crash; skip it
      }
    }
    // Resolve legacy chains before trimming, while every historical parent is available.
    const migrated: ChannelPost[] = [];
    for (const post of byId.values()) {
      if (post.threadId || !post.inReplyTo || post.kind === 'event') continue;
      const root = threadRoot(byId, post.id, channelId);
      if (root) {
        post.threadId = root.id;
        migrated.push(post);
      }
    }
    if (migrated.length) {
      const separator = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(file, separator + migrated.map(p => `${JSON.stringify(p)}\n`).join(''));
    }
    return withThreadRoots([...byId.values()], MAX_POSTS);
  }

  deletePosts(channelId: string): void {
    this.posts.delete(channelId);
    fs.rmSync(this.postsPath(channelId), { force: true });
  }
}

/**
 * What an agent with no usable project choice is saved with in the old projectId field: an id no
 * project has, so a build from before projectIds fails closed on it (no folder) instead of reading
 * a missing value as every project.
 */
export const NO_PROJECT_LEGACY = 'no-project';

/**
 * The old single-project field written beside projectIds on save, so a build from before agents
 * could have several projects reads each agent at its narrowest: its start folder, or every project
 * only when it really has every project.
 */
export function legacyProjectId(agent: Pick<Agent, 'projectIds'>): string | null {
  if (agent.projectIds === null) return null;
  return agent.projectIds[0] ?? NO_PROJECT_LEGACY;
}

/**
 * Read an agent's project choice as stored, always at the narrowest safe scope:
 * - projectIds that read (null, or a list of ids) win: the newer field is the authority;
 * - stored before projectIds existed: the old projectId, an id becoming [id] and null staying null
 *   (it really was an agent on every project);
 * - anything unreadable (a damaged projectIds, or no usable field at all): the old projectId when it
 *   names a project that exists, else [] (no projects: the agent keeps only its own folder, and the
 *   app asks you to pick its projects). Never every project.
 * The old key is dropped in memory; save writes it back from projectIds (legacyProjectId).
 */
export function migrateAgentProjects(agent: Agent, projectExists: (id: string) => boolean = () => true): Agent {
  const raw = agent as Agent & { projectId?: unknown };
  const stored: unknown = raw.projectIds;
  const legacy = raw.projectId;
  const readable = stored === null || (Array.isArray(stored) && stored.every(id => typeof id === 'string' && id !== ''));
  if (readable) {
    raw.projectIds = stored === null ? null : [...new Set(stored as string[])];
  } else if (stored === undefined && legacy === null) {
    raw.projectIds = null;
  } else if (stored === undefined && typeof legacy === 'string' && legacy && legacy !== NO_PROJECT_LEGACY) {
    raw.projectIds = [legacy];
  } else {
    const ids = normalizeProjectIds(undefined, legacy);
    raw.projectIds = ids && ids.length === 1 && ids[0] !== NO_PROJECT_LEGACY && projectExists(ids[0]) ? ids : [];
    console.error(`[store] ${raw.name ?? raw.id}'s projects could not be read; it now has ${raw.projectIds.length ? 'its old project only' : 'no projects until you pick some in its settings'}.`);
  }
  delete raw.projectId;
  return raw;
}
