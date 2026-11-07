import type {
  Agent,
  AgentPatch,
  ApprovalDecision,
  Channel,
  ChannelInput,
  ChannelPost,
  Conversation,
  CreateAgentRequest,
  DirListing,
  EngineKind,
  EngineModels,
  EngineUsage,
  Entry,
  FileContent,
  FileDiff,
  GitStatus,
  ImageAttachment,
  AgentDreams,
  DreamRecord,
  DreamStatsReport,
  MemoryEntry,
  MemoryPatch,
  Project,
  Settings,
  Snapshot,
  TerminalInfo,
  TreeListing,
  WorktreeCleanup,
} from '../shared/types.ts';
import type { ComposerCommand, ProjectFileList } from '../shared/composer.ts';

/** Where files and git commands run: an agent's workspace, or a project folder. */
export type Root = { agent: string } | { project: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `Request failed (${response.status}).`);
  return data as T;
}

/** Where an attached image can be loaded from. */
export function attachmentUrl(agentId: string, image: Pick<ImageAttachment, 'id'>): string {
  return `/api/agents/${agentId}/attachments/${image.id}`;
}

/** Where an image attached to a channel post can be loaded from. */
export function channelAttachmentUrl(channelId: string, image: Pick<ImageAttachment, 'id'>): string {
  return `/api/channels/${channelId}/attachments/${image.id}`;
}

/** Upload one image's bytes; the server reads the type from them. */
async function upload(url: string, image: Blob, name: string): Promise<ImageAttachment> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
    body: image,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? `Upload failed (${response.status}).`);
  return data as ImageAttachment;
}

/** What a message names its images by. */
function imageRefs(images?: ImageAttachment[]) {
  return images?.length ? images.map(i => ({ id: i.id, name: i.name })) : undefined;
}

function rootQuery(root: Root, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...('agent' in root ? { agent: root.agent } : { project: root.project }), ...extra });
  return params.toString();
}

export const api = {
  state: () => request<Snapshot>('GET', '/api/state'),

  createAgent: (input: CreateAgentRequest) => request<Agent>('POST', '/api/agents', input),
  updateAgent: (id: string, patch: AgentPatch) => request<Agent>('PATCH', `/api/agents/${id}`, patch),
  removeAgent: (id: string, worktree: WorktreeCleanup = 'keep') => request<void>('DELETE', `/api/agents/${id}?worktree=${worktree}`),
  entries: (id: string) => request<Entry[]>('GET', `/api/agents/${id}/entries`),
  send: (id: string, text: string, images?: ImageAttachment[]) =>
    request<{ ok: true }>('POST', `/api/agents/${id}/messages`, { text, images: imageRefs(images) }),
  /** Upload one image for the agent's next message. */
  attach: (id: string, image: Blob, name: string) => upload(`/api/agents/${id}/attachments`, image, name),
  stop: (id: string) => request<{ ok: true }>('POST', `/api/agents/${id}/stop`),
  seen: (id: string) => request<{ ok: true }>('POST', `/api/agents/${id}/seen`),
  newSession: (id: string) => request<{ ok: true }>('POST', `/api/agents/${id}/new-session`),
  /** The skills and commands the agent's engine can run, for the composer's `/` picker. */
  commands: (id: string) => request<ComposerCommand[]>('GET', `/api/agents/${id}/commands`),
  /** What the agent remembered, oldest first. Changes also arrive as `memory` events. */
  memory: (id: string) => request<MemoryEntry[]>('GET', `/api/agents/${id}/memory`),
  /** Rewrite one memory entry; returns the updated entry. */
  updateMemory: (id: string, entryId: string, patch: MemoryPatch) => request<MemoryEntry>('PATCH', `/api/agents/${id}/memory/${entryId}`, patch),
  forgetMemory: (id: string, entryId: string) => request<void>('DELETE', `/api/agents/${id}/memory/${entryId}`),
  /** The agent's dreams (newest first), its dreaming stats and any soul proposal waiting. */
  dreams: (id: string) => request<AgentDreams>('GET', `/api/agents/${id}/dreams`),
  /** Dream now. Returns once the dream has started; its record arrives as a `dream` event. 409 when busy, locked or off. */
  dreamNow: (id: string) => request<{ ok: true }>('POST', `/api/agents/${id}/dream`),
  /** Undo the latest dream: memory goes back to how it was before. Returns the updated record. */
  undoDream: (id: string, dreamId: string) => request<DreamRecord>('POST', `/api/agents/${id}/dreams/${dreamId}/undo`),
  /** Accept or reject the soul proposal waiting for the agent. */
  soulProposal: (id: string, action: 'accept' | 'reject') => request<{ ok: true }>('POST', `/api/agents/${id}/soul-proposal`, { action }),
  /** Dreaming stats for each agent, and for agents with dreaming on and off as groups. */
  dreamStats: () => request<DreamStatsReport>('GET', '/api/dream-stats'),

  resolveApproval: (id: string, decision: ApprovalDecision) => request<{ ok: true }>('POST', `/api/approvals/${id}`, decision),
  stopConversation: (id: string) => request<Conversation>('POST', `/api/conversations/${id}/stop`),

  createChannel: (input: ChannelInput) => request<Channel>('POST', '/api/channels', input),
  updateChannel: (id: string, input: ChannelInput) => request<Channel>('PATCH', `/api/channels/${id}`, input),
  removeChannel: (id: string) => request<void>('DELETE', `/api/channels/${id}`),
  channelPosts: (id: string) => request<ChannelPost[]>('GET', `/api/channels/${id}/posts`),
  /** `threadId` posts into the thread under that top-level post. */
  post: (id: string, text: string, mentions: string[], threadId?: string, images?: ImageAttachment[]) =>
    request<ChannelPost>('POST', `/api/channels/${id}/posts`, { text, mentions, threadId, images: imageRefs(images) }),
  /** Upload one image for the user's next post in the channel. */
  attachToChannel: (id: string, image: Blob, name: string) => upload(`/api/channels/${id}/attachments`, image, name),
  channelSeen: (id: string) => request<{ ok: true }>('POST', `/api/channels/${id}/seen`),

  addProject: (input: { path: string; name?: string; create?: boolean }) => request<Project>('POST', '/api/projects', input),
  renameProject: (id: string, name: string) => request<Project>('PATCH', `/api/projects/${id}`, { name }),
  removeProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),

  tree: (root: Root, path = '') => request<TreeListing>('GET', `/api/files/tree?${rootQuery(root, { path })}`),
  readFile: (root: Root, path: string) => request<FileContent>('GET', `/api/files/read?${rootQuery(root, { path })}`),
  /** Every file in the workspace (git's view of it when it is a repository), for the `@` picker. */
  projectFiles: (root: Root) => request<ProjectFileList>('GET', `/api/files/list?${rootQuery(root)}`),
  gitStatus: (root: Root) => request<GitStatus>('GET', `/api/git/status?${rootQuery(root)}`),
  gitDiff: (root: Root, path: string) => request<FileDiff>('GET', `/api/git/diff?${rootQuery(root, { path })}`),

  listDirs: (path: string, hidden = false) => request<DirListing>('GET', `/api/fs?${new URLSearchParams({ path, hidden: hidden ? '1' : '0' })}`),
  mkdir: (path: string) => request<{ path: string }>('POST', '/api/fs/mkdir', { path }),

  /**
   * A shell in the project's folder; `cols` and `rows` start it at about its size. `from` splits
   * that terminal: the new shell starts in the folder the other one is in now.
   */
  createTerminal: (projectId: string, size?: { cols: number; rows: number }, from?: string) => request<TerminalInfo>('POST', '/api/terminals', { projectId, ...size, from }),
  /** Of these terminals, the ones running a program, with its name. */
  terminalsBusy: (ids: string[]) => request<Record<string, string>>('GET', `/api/terminals/busy?${new URLSearchParams({ ids: ids.join(',') })}`),
  closeTerminal: (id: string) => request<void>('DELETE', `/api/terminals/${id}`),

  refreshModels: () => request<Record<EngineKind, EngineModels>>('POST', '/api/models/refresh'),
  usage: (engine: EngineKind) => request<EngineUsage>('GET', `/api/usage/${engine}`),
  refreshUsage: (engine: EngineKind) => request<EngineUsage>('POST', `/api/usage/${engine}/refresh`),
  updateSettings: (settings: Partial<Settings>) => request<Settings>('PATCH', '/api/settings', settings),
};
