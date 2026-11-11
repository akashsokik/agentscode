// @mentions of agents, projects and files, the same on the server (what the receiving agent is told)
// and in the app (chips). Pure, so it is tested directly.
//
// What a mention means:
// - @Agent in an agent's prompt box is a reference: the agent is told who that is (name, id, role,
//   project) so it can message or delegate correctly. It messages nobody by itself.
// - @Agent in a channel also starts a turn for that member (the client sends mention ids, as before).
// - @all, @channel and @here address every channel member.
// - @Project tells the agent the project's name and path.
// - @path is a file or folder. In an agent's prompt box it is relative to the agent's workspace, as
//   before; in a channel it is project/path, resolved to an absolute path.

export interface MentionAgent {
  id: string;
  name: string;
  role?: string;
  /** Its projects, the start folder first; null for all projects (shared/agentProjects.ts). */
  projectIds?: string[] | null;
}

export interface MentionProject {
  id: string;
  name: string;
  path: string;
}

/** A mention as stored with a sent message, so a chip still reads right after a rename or removal. */
export type MentionRef =
  | { kind: 'agent'; start: number; end: number; id: string; name: string }
  | { kind: 'project'; start: number; end: number; id: string; name: string }
  | { kind: 'file'; start: number; end: number; name: string; path: string; projectId?: string }
  | { kind: 'everyone'; start: number; end: number; name: string };

const EVERYONE = ['all', 'channel', 'here'];

/** Whether `index` sits inside inline code (`...`) or a fenced block (```...```). */
export function inCode(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const fences = before.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) return true;
  // Inline code: count single backticks on the current line, outside fences.
  const line = before.slice(before.lastIndexOf('\n') + 1).replace(/```/g, '');
  return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

/** An @ that starts a mention: not inside a word, an email or a path, and not in code. */
export function mentionStart(text: string, index: number): boolean {
  if (text[index] !== '@') return false;
  const prev = index > 0 ? text[index - 1] : '';
  if (prev && /[\w@./\\`-]/.test(prev)) return false;
  return !inCode(text, index);
}

const boundary = (ch: string | undefined) => ch === undefined || !/[\w-]/.test(ch);

/** File-like text after an @: no spaces, a slash or a dot inside, trailing punctuation left off. */
const FILE = /^[^\s@`]+/;

function fileToken(rest: string): string | null {
  const raw = FILE.exec(rest)?.[0];
  if (!raw) return null;
  const token = raw.replace(/[.,;:!?)\]}'"]+$/, '');
  if (!token || !/[/.]/.test(token)) return null;
  return token;
}

/**
 * Which one the user picked from the @ picker where the text alone cannot tell: an agent and a project
 * (or two agents) with the same name. `start` is the @'s index in the text as sent (alignHints).
 */
export interface MentionHint {
  kind: 'agent' | 'project';
  id: string;
  name: string;
  start: number;
}

export interface FindOptions {
  agents: MentionAgent[];
  projects: MentionProject[];
  /** A channel: file mentions are project/path. Otherwise they are relative to the agent's workspace. */
  channel?: boolean;
  /** Picks that settle a name shared by more than one agent or project, by the @'s position. */
  hints?: readonly MentionHint[];
}

/**
 * The mentions in `text`, in order. A name wins over a path, the longest name wins ("@Ada Lovelace"
 * over "@Ada"), and on the same name the one the user picked there wins (`hints`), else an agent
 * over a project. Matching ignores case.
 */
export function findMentions(text: string, options: FindOptions): MentionRef[] {
  const names = [
    ...options.agents.map(a => ({ kind: 'agent' as const, id: a.id, name: a.name })),
    ...options.projects.map(p => ({ kind: 'project' as const, id: p.id, name: p.name })),
  ].filter(n => n.name).sort((a, b) => b.name.length - a.name.length || (a.kind === 'agent' ? -1 : 1));
  const out: MentionRef[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!mentionStart(text, i)) continue;
    const rest = text.slice(i + 1);
    const lower = rest.toLowerCase();
    const everyone = EVERYONE.find(word => lower.startsWith(word) && boundary(rest[word.length]));
    // A path such as "@web/app.ts" is a file even when "web" is also a name.
    const file = fileToken(rest);
    const matches = names.filter(n => lower.startsWith(n.name.toLowerCase()) && boundary(rest[n.name.length]));
    // The longest name; when several share it, the one picked at this @.
    const same = matches.filter(n => n.name.length === matches[0]?.name.length);
    const hint = same.length > 1 ? options.hints?.find(h => h.start === i && same.some(n => n.kind === h.kind && n.id === h.id)) : undefined;
    const named = hint ? same.find(n => n.kind === hint.kind && n.id === hint.id) : matches[0];
    if (named && !(file && file.length > named.name.length)) {
      const end = i + 1 + named.name.length;
      out.push({ kind: named.kind, start: i, end, id: named.id, name: named.name });
      i = end - 1;
    } else if (everyone && !file) {
      const end = i + 1 + everyone.length;
      out.push({ kind: 'everyone', start: i, end, name: everyone });
      i = end - 1;
    } else if (file) {
      const end = i + 1 + file.length;
      if (options.channel) {
        const slash = file.indexOf('/');
        const project = slash > 0 ? options.projects.find(p => p.name.toLowerCase() === file.slice(0, slash).toLowerCase()) : undefined;
        if (project) out.push({ kind: 'file', start: i, end, name: file, path: file.slice(slash + 1), projectId: project.id });
      } else {
        out.push({ kind: 'file', start: i, end, name: file, path: file });
      }
      i = end - 1;
    }
  }
  return out;
}

/**
 * `rel` inside `base`, with "." and ".." resolved; null when it would leave `base`, so the note
 * never names a path outside the project the user picked.
 */
export function joinPath(base: string, rel: string): string | null {
  const parts: string[] = [];
  for (const part of rel.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  const root = base.replace(/[\\/]+$/, '');
  return parts.length ? `${root}/${parts.join('/')}` : root;
}

/**
 * The note added to the receiving agent's prompt so it knows exactly who and what was mentioned:
 * agents with their canonical name, id, role and project; projects with their path; channel files
 * with their absolute path. '' when the message mentions nothing that needs saying. Files in an
 * agent's own prompt box are left as written: they are relative to its workspace already.
 */
export function mentionContext(
  refs: MentionRef[],
  lookup: { agents: MentionAgent[]; projects: MentionProject[]; roleName?: (role: string) => string; channel?: boolean },
): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.kind === 'file' ? `${ref.projectId ?? ''}/${ref.path}` : 'id' in ref ? ref.id : ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === 'agent') {
      const agent = lookup.agents.find(a => a.id === ref.id);
      if (!agent) continue;
      const projects = (agent.projectIds ?? []).flatMap(id => lookup.projects.filter(p => p.id === id));
      const role = agent.role ? (lookup.roleName?.(agent.role) ?? agent.role) : '';
      const where = projects.length === 1 ? `, project ${projects[0].name} at ${projects[0].path}`
        : projects.length ? `, projects ${projects.map(p => `${p.name} at ${p.path}`).join(' and ')} (starts in ${projects[0].name})`
        : agent.projectIds === null ? ', all projects' : '';
      lines.push(`- @${ref.name}: the agent ${agent.name} (agent id ${agent.id}${role ? `, ${role}` : ''}${where}).`);
    } else if (ref.kind === 'project') {
      const project = lookup.projects.find(p => p.id === ref.id);
      if (project) lines.push(`- @${ref.name}: the project ${project.name} at ${project.path}.`);
    } else if (ref.kind === 'file' && ref.projectId) {
      const project = lookup.projects.find(p => p.id === ref.projectId);
      const full = project ? joinPath(project.path, ref.path) : null;
      if (full) lines.push(`- @${ref.name}: the file or folder ${full}.`);
    }
  }
  if (!lines.length) return '';
  const heading = lookup.channel
    ? 'Mentioned in this post (who and what it refers to):'
    : 'Mentioned in this message (references to help you; mentioning an agent here does not message it):';
  return [heading, ...lines].join('\n');
}

/** Every place `@name` stands as a mention (mentionStart, a word boundary after it), by the @'s index. */
function occurrences(text: string, name: string): number[] {
  const out: number[] = [];
  const needle = `@${name}`.toLowerCase();
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
    if (mentionStart(text, at) && boundary(text[at + needle.length])) out.push(at);
  }
  return out;
}

/**
 * The picks still in the text as it is sent, each moved to the nearest `@name` from where it was
 * picked (typing before a mention moves it), at most one pick per @. Picks whose @ was deleted drop.
 */
export function alignHints(text: string, hints: readonly MentionHint[]): MentionHint[] {
  const taken = new Set<number>();
  const out: MentionHint[] = [];
  for (const hint of hints.slice(-100)) {
    const near = occurrences(text, hint.name).filter(at => !taken.has(at)).sort((a, b) => Math.abs(a - hint.start) - Math.abs(b - hint.start))[0];
    if (near === undefined) continue;
    taken.add(near);
    out.push({ ...hint, start: near });
  }
  return out;
}

/** Hints as the server takes them from a request: well formed, at most 100. */
export function parseHints(raw: unknown): MentionHint[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100).flatMap((h): MentionHint[] => {
    const v = h as Partial<MentionHint> | null;
    if (!v || (v.kind !== 'agent' && v.kind !== 'project') || typeof v.id !== 'string' || typeof v.name !== 'string') return [];
    if (!Number.isInteger(v.start) || (v.start as number) < 0) return [];
    return [{ kind: v.kind, id: v.id.slice(0, 200), name: v.name.slice(0, 200), start: v.start as number }];
  });
}

/**
 * The channel members a post starts, from the same parse as its chips: every member for @all,
 * @channel or @here, else each member it names, in order. A name inside code, an email or a path
 * starts nobody; neither does a project that shares a member's name when the project was picked.
 */
export function channelRecipients(text: string, memberIds: readonly string[], options: FindOptions): string[] {
  const refs = findMentions(text, { ...options, channel: true });
  if (refs.some(r => r.kind === 'everyone')) return [...memberIds];
  const named = refs.flatMap(r => (r.kind === 'agent' && memberIds.includes(r.id) ? [r.id] : []));
  return [...new Set(named)];
}
