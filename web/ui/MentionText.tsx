import { useMemo, type ReactNode } from 'react';
import { findMentions, type MentionRef } from '../../shared/mentions.ts';
import { open, setProject } from '../layout.ts';
import { useApp } from '../store.ts';
import { AgentAvatar } from './Avatar.tsx';
import { withRefChips } from '../notes/RefChip.tsx';
import { useNotes } from '../notes/refsState.ts';

/**
 * Plain text with its @mentions as quiet inline chips: agents, projects, files, and @all, @channel
 * and @here. A sent message brings the mentions it resolved when it was sent (`refs`), so a renamed
 * agent still reads as written and a removed one shows greyed; older messages are matched live.
 * Clicking a chip opens the agent, selects the project or opens the file. `agentId` is whose
 * workspace a plain @path is in; without one (a channel), files are project/path.
 * The caller's whitespace style keeps line breaks.
 */
export function MentionText({ text, refs, agentId }: { text: string; refs?: MentionRef[]; agentId?: string }) {
  const agents = useApp(s => s.snapshot?.agents);
  const projects = useApp(s => s.snapshot?.projects);
  // Note and decision ids in the plain parts become chips once the known ids are loaded.
  useNotes(s => s.idsKey);
  const mentions = useMemo(() => {
    const found = refs ?? findMentions(text, { agents: agents ?? [], projects: projects ?? [], channel: !agentId });
    // Stored refs index the text they were made from; drop any that no longer line up.
    return found.filter(m => m.start >= 0 && m.end <= text.length && text[m.start] === '@').sort((a, b) => a.start - b.start);
  }, [text, refs, agents, projects, agentId]);
  if (!mentions.length) return <>{withRefChips(text)}</>;

  const parts: ReactNode[] = [];
  let last = 0;
  for (const mention of mentions) {
    if (mention.start < last) continue;
    if (mention.start > last) parts.push(...withRefChips(text.slice(last, mention.start), `${last}:`));
    const shown = text.slice(mention.start, mention.end);
    parts.push(<Chip key={mention.start} mention={mention} shown={shown} agentId={agentId} />);
    last = mention.end;
  }
  if (last < text.length) parts.push(...withRefChips(text.slice(last), `${last}:`));
  return <>{parts}</>;
}

const LIVE = 'rounded bg-mention/10 px-0.5 font-medium text-mention';

function Chip({ mention, shown, agentId }: { mention: MentionRef; shown: string; agentId?: string }) {
  const agent = useApp(s => (mention.kind === 'agent' ? s.snapshot?.agents.find(a => a.id === mention.id) : undefined));
  const project = useApp(s => (mention.kind === 'project' ? s.snapshot?.projects.find(p => p.id === mention.id) : undefined));
  if (mention.kind === 'everyone') return <span className={LIVE}>{shown}</span>;

  let go: (() => void) | undefined;
  let title: string;
  if (mention.kind === 'agent') {
    go = agent ? () => open({ kind: 'agent', agentId: agent.id }) : undefined;
    title = agent ? (agent.name === mention.name ? `Open ${agent.name}` : `Open ${agent.name} (was ${mention.name})`) : `${mention.name} was removed`;
  } else if (mention.kind === 'project') {
    go = project ? () => setProject(project.id) : undefined;
    title = project ? `Show ${project.name}` : `${mention.name} was removed`;
  } else {
    const root = mention.projectId ? { project: mention.projectId } : agentId ? { agent: agentId } : undefined;
    go = root ? () => open({ kind: 'file', root, path: mention.path.replace(/\/$/, '') }) : undefined;
    title = go ? `Open ${mention.path}` : mention.path;
  }
  // Something that no longer exists keeps its words, greyed, and does nothing on click.
  if (!go) return <span title={title} className="rounded bg-content/6 px-0.5 font-medium text-content/45">{shown}</span>;
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => { event.stopPropagation(); go!(); }}
      className={`${LIVE} cursor-pointer transition-colors duration-150 hover:bg-mention/20`}
    >
      {agent ? <AgentAvatar agent={agent} animate={false} className="mr-0.5 inline-block size-[1em] align-[-0.15em]" /> : null}
      {shown}
    </button>
  );
}
