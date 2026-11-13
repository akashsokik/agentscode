/**
 * The issue's activity, oldest first: who did what (a quiet line with their avatar and the time),
 * and comments as their own text. The comment box under it posts through the issue API.
 */
import type { IssueActor, IssueEvent, SuperIssue } from '../../../shared/types.ts';
import { Clock, GitBranch } from '../../mono/icons.tsx';
import { useApp } from '../../store.ts';
import { AgentAvatar } from '../../ui/Avatar.tsx';
import { Markdown } from '../../ui/Markdown.tsx';
import { StatusGlyph } from './glyphs.tsx';
import { activityLine, activityOf, actorName, commentToPost, commitEdit, TEXT_MAX } from './issueViewModel.ts';
import { writeIssue } from './issueWrites.ts';
import { useState } from 'react';
import { Kbd } from '../../ui/Kbd.tsx';
import { TEXTAREA, TextButton } from '../../ui/common.tsx';
import { Section } from './Sections.tsx';
import type { IssueStatus } from '../../../shared/types.ts';
import { ISSUE_STATUS_LABEL } from '../../../shared/issues.ts';

function when(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString() ? d.toTimeString().slice(0, 5) : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}

function Who({ actor }: { actor: IssueActor }) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const superAgent = agents.find(a => a.role === 'super');
  const agent = actor.kind === 'agent' ? agents.find(a => a.id === actor.id) : actor.kind === 'super' ? superAgent : undefined;
  if (agent) return <AgentAvatar agent={agent} animate={false} className="size-4" />;
  if (actor.kind === 'git') return <GitBranch aria-hidden className="size-4 shrink-0 p-[1px] text-content/55" strokeWidth={1.75} />;
  return <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-content/10 text-[9px] font-semibold text-content/60">{actor.kind === 'user' ? 'Y' : 'P'}</span>;
}

function EventRow({ event }: { event: IssueEvent }) {
  const agents = useApp(s => s.snapshot?.agents) ?? [];
  const name = (id: string) => agents.find(a => a.id === id)?.name;
  const issues = useApp(s => s.snapshot?.super.issues) ?? [];
  const issueKey = (id: string) => issues.find(i => i.id === id)?.key;
  const status = event.kind === 'status' && event.to && event.to in ISSUE_STATUS_LABEL ? event.to as IssueStatus : null;
  return (
    <li className="font-sans">
      <div className="flex min-h-[30px] items-center gap-2 text-[12.5px]">
        {status ? <StatusGlyph status={status} /> : <Who actor={event.by} />}
        <p className="min-w-0 flex-1 truncate text-content/60"><span className="font-medium text-content/85">{actorName(event.by, name)}</span> {activityLine(event, name, issueKey)}</p>
        <time dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()} className="shrink-0 text-[11.5px] tabular-nums text-content/40">{when(event.at)}</time>
      </div>
      {event.kind === 'comment' && event.text ? (
        <div className="mb-1 ml-6 rounded-lg bg-content/4 px-3 py-2">
          <Markdown text={event.text} className="text-[12.5px] leading-relaxed text-content/80" />
        </div>
      ) : null}
    </li>
  );
}

export function Activity({ issue }: { issue: SuperIssue }) {
  const events = activityOf(issue);
  return (
    <Section icon={Clock} title="Activity">
      <ol aria-label="Activity">{events.map((e, i) => <EventRow key={`${e.at}:${i}`} event={e} />)}</ol>
      <CommentBox issueId={issue.id} />
    </Section>
  );
}

/** A comment on the issue: Markdown, line breaks kept. ⌘⏎ posts; it clears once posted, and stays on a refusal. */
function CommentBox({ issueId }: { issueId: string }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const post = async () => {
    if (busy) return;
    setBusy(true);
    const result = await commitEdit(commentToPost(draft), comment => writeIssue(issueId, { comment }));
    setBusy(false);
    if (result === 'saved') setDraft('');
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5 font-sans">
      <textarea
        aria-label="Comment"
        placeholder="Leave a comment…"
        value={draft}
        rows={Math.min(12, Math.max(2, draft.split('\n').length + 1))}
        maxLength={TEXT_MAX}
        aria-busy={busy || undefined}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void post(); }
          if (e.key === 'Escape' && draft) { e.preventDefault(); e.stopPropagation(); setDraft(''); }
        }}
        className={`${TEXTAREA} text-[12.5px] leading-relaxed`}
      />
      <div className="flex items-center justify-end gap-2 text-[11px] text-content/45">
        <span className="mr-auto inline-flex items-center gap-1"><Kbd spec="Mod+Enter" quiet /> comment</span>
        <TextButton onClick={() => void post()} disabled={busy || !commentToPost(draft)}>Comment</TextButton>
      </div>
    </div>
  );
}
