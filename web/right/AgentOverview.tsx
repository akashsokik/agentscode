import type { ReactNode } from 'react';
import type { Agent, Approval, GitStatus } from '../../shared/types.ts';
import { rolePreset } from '../../shared/roles.ts';
import { api } from '../api.ts';
import { duration, relativeTime } from '../format.ts';
import { open, openToSide, setProject } from '../layout.ts';
import { projectLabel } from '../projects.ts';
import { attempt, useApp } from '../store.ts';
import { AgentAvatar } from '../ui/Avatar.tsx';
import { StatusMark } from '../ui/StatusMark.tsx';
import { TextButton } from '../ui/common.tsx';
import { ChevronRight, FileDiff, GitBranch, MessageMultiple, Route } from '../mono/icons.tsx';
import { whereabouts } from '../whereabouts.ts';
import { useNow } from '../ui/useNow.ts';
import { QuestionPrompt } from '../panes/Composer.tsx';
import { ApprovalRow } from '../panes/Transcript.tsx';
import { setWorkUi } from '../work/workData.ts';
import { overviewNow } from './overviewPresentation.ts';
import { useOverviewData, type OverviewOutputView } from './overviewData.ts';

const ROW = 'flex w-full min-w-0 items-start gap-[9px] rounded-md py-2 text-left hover:bg-content/5';

function Label({ children, trailing, attention = false }: { children: ReactNode; trailing?: ReactNode; attention?: boolean }) {
  return <h3 className={`mb-2 flex items-center justify-between gap-2 text-[11px] font-medium ${attention ? 'text-warning' : 'text-content/50'}`}>{children}<span className="font-normal text-content/40">{trailing}</span></h3>;
}

function NeedsYou({ approvals, waiting = [], askers }: { approvals: Approval[]; waiting?: Agent[]; askers?: Agent[] }) {
  return <section className="mt-[25px]" aria-label="Needs you">
    <Label attention={approvals.length > 0 || waiting.length > 0} trailing={approvals.length ? `${approvals.length} waiting` : undefined}>Needs you</Label>
    {approvals.length ? <div className="space-y-5">{approvals.map(a => <div key={a.id}>{a.type === 'question' ? <QuestionPrompt approval={a} compact asker={askers?.find(agent=>agent.id===a.agentId)} /> : <ApprovalRow approval={a} compact />}</div>)}</div>
      : waiting.length ? waiting.map(a => <p key={a.id} className="text-[12px] text-content/55">{a.name} is waiting for your response. <TextButton onClick={()=>message(a)}>Open conversation</TextButton></p>) : <p className="text-[12px] text-content/40">Nothing waiting on you.</p>}
  </section>;
}

function Produced({ items }: { items: OverviewOutputView[] }) {
  if (!items.length) return null;
  return <section className="mt-[25px]" aria-label="Produced">
    <Label trailing="Recent">Produced</Label>
    {items.map(item => <button key={item.id} type="button" onClick={item.open} className={ROW}>
      {item.kind === 'diff' ? <FileDiff className="mt-0.5 size-3.5 shrink-0 text-content/50" /> : item.kind === 'commit' ? <GitBranch className="mt-0.5 size-3.5 shrink-0 text-content/50" /> : item.kind === 'walkthrough' ? <Route className="mt-0.5 size-3.5 shrink-0 text-content/50" /> : <StatusMark state={item.outcome === 'failed' ? 'fail' : item.outcome === 'blocked' ? 'warn' : 'pass'} quiet className="mt-0.5 size-3.5" />}
      <span className="min-w-0 flex-1"><span className="block break-words text-[12.5px] leading-[1.45]">{item.title}</span><span className="mt-0.5 block break-words text-[11px] text-content/40">{item.detail}{item.kind !== 'diff' ? ` · ${relativeTime(item.at)} ago` : ''}</span></span>
      <ChevronRight className="size-3 shrink-0 self-center text-content/45" />
    </button>)}
  </section>;
}

function message(agent: Agent) {
  open({ kind: 'agent', agentId: agent.id });
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('section[data-pane-focused] [data-composer] textarea')?.focus());
}

/** ACH-D98/D100 Work sheet: task, elapsed, attention and output; no plan steps or bars. */
export function AgentOverview({ agent, git, team = false }: { agent: Agent; git: GitStatus | null | undefined; team?: boolean }) {
  const snapshot = useApp(s => s.snapshot);
  const data = useOverviewData(agent, team);
  const now = useNow(agent.status === 'working' ? 1000 : 30_000);
  const current = overviewNow(agent, now);
  const where = whereabouts(agent, snapshot?.projects);
  const members = team ? (snapshot?.agents ?? []).filter(a => a.id !== agent.id) : [];
  const memberIds = new Set(members.map(a => a.id));
  const approvals = (snapshot?.approvals ?? []).filter(a => team ? memberIds.has(a.agentId) || a.agentId === agent.id : a.agentId === agent.id);
  const working = members.filter(a => a.status === 'working').length;
  const waiting = [...members,agent].filter(a => a.status === 'waiting' || approvals.some(p => p.agentId === a.id)).length;
  const branch = git?.branch || where?.branch || agent.worktree?.branch;
  const project = where?.project || projectLabel(agent.projectIds, snapshot?.projects);
  const openBranch = () => {
    const projectId = agent.workingIn?.projectId || agent.projectIds?.[0];
    const folder = agent.worktree?.path;
    if (projectId) { setProject(projectId); if (folder) setWorkUi(projectId, { tab: 'active', selected: { kind: 'branch', id: folder } }); }
    open({ kind: 'work' });
  };
  return <div className="min-h-0 flex-1 overflow-y-auto font-sans" data-overview-sheet>
    <div className="px-[18px] pb-8 pt-5">
      <header className="mb-6 flex min-w-0 items-center gap-[9px]">
        <AgentAvatar agent={agent} className="size-[25px]" />
        <div className="min-w-0 flex-1"><div className="flex min-w-0 items-baseline gap-1 text-[13px]"><span className="min-w-0 truncate font-semibold">{agent.name}</span><span className="min-w-0 shrink-[999] truncate text-content/50">{team ? 'Team' : rolePreset(agent.role).name}</span></div>
          <p className="mt-0.5 flex min-w-0 gap-2 text-[11px] text-content/50"><span className="min-w-0 truncate">{project}</span>{!team && branch ? <span className="min-w-0 truncate">{branch}</span> : null}</p>
        </div>
      </header>
      {team ? <>
        <p className="text-[12px] text-content/50">Team now</p>
        <h2 className="mt-2.5 text-[21px] font-medium leading-[1.35] tracking-[-.35px]">{working ? 'The team is working.' : 'The team is ready.'}{waiting ? <><br />{waiting === 1 ? 'One agent needs you.' : `${waiting} agents need you.`}</> : null}</h2>
        <p className="mt-2 text-[12px] text-content/50">{working} working · {waiting} waiting for you</p>
      </> : <>
        <div className="flex items-center gap-[7px] text-[12px] text-content/50"><StatusMark state={agent.status === 'working' ? 'pending' : agent.status === 'waiting' ? 'warn' : agent.status === 'error' ? 'fail' : 'pass'} quiet className="size-3" /><span>{current.state}{current.elapsedMs !== null ? ` · ${duration(current.elapsedMs)} elapsed` : ` · ${relativeTime(agent.lastActiveAt, now)} ago`}</span></div>
        <h2 className="my-2.5 break-words text-[21px] font-medium leading-[1.35] tracking-[-.35px]">{current.title}</h2>
        {current.activity ? <p className="break-words text-[12px] leading-relaxed text-content/50">{current.activity}</p> : null}
      </>}
      <NeedsYou approvals={approvals} askers={team?snapshot?.agents:undefined} waiting={(team ? [...members,agent] : [agent]).filter(a=>a.status==='waiting')} />
      {team ? <section className="mt-[25px]" aria-label="Team work">{members.map(a => <button type="button" key={a.id} className={`${ROW} py-[9px]`} onClick={() => open({kind:'agent',agentId:a.id})}>
        <AgentAvatar agent={a} className="mt-0.5 size-[18px]" /><span className="min-w-0 flex-1"><span className="text-[12.5px] font-medium">{a.name}</span><span className="mt-0.5 block line-clamp-2 text-[12px] text-content/55">{overviewNow(a, now).title}</span><span className="mt-0.5 block text-[10.5px] text-content/40">{a.status === 'waiting' ? 'Waiting for you' : a.activity || 'Idle'}</span></span><StatusMark state={a.status === 'working' ? 'pending' : a.status === 'waiting' ? 'warn' : 'pass'} quiet className="mt-0.5 size-3" />
      </button>)}</section> : null}
      <Produced items={data.produced} />
      <footer className="mt-6 flex flex-wrap items-center gap-1" aria-label="Overview actions">
        <TextButton className="inline-flex items-center text-content" onClick={() => message(agent)}><MessageMultiple className="mr-1 size-3" />Message</TextButton>
        {current.busy ? <TextButton onClick={() => void attempt(() => api.stop(agent.id))}>Stop</TextButton> : null}
        {team && data.produced.some(i=>i.kind==='diff') ? <TextButton onClick={()=>data.produced.find(i=>i.kind==='diff')?.open()}>Open diff</TextButton> : null}
        {!team && git?.isRepo ? <TextButton disabled={!git.files.length} onClick={() => { if (git.files[0]) openToSide({kind:'diff',root:{agent:agent.id},path:git.files[0].path}); }}>Open diff</TextButton> : null}
        {branch || team ? <TextButton onClick={openBranch}>Open branch</TextButton> : null}
      </footer>
    </div>
  </div>;
}
