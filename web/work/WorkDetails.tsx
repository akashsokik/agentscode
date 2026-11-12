import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkChanges, WorkDiff, WorkProject, WorkTarget } from '../../shared/work.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { open, openToSide } from '../layout.ts';
import { ChevronLeft, FileDiff, RefreshCw, X } from '../mono/icons.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { RefChip } from '../notes/RefChip.tsx';
import { UnifiedDiff } from '../panes/FilePane.tsx';
import { useApp } from '../store.ts';
import { HeaderButton, Loading, StatusLabel, TextButton } from '../ui/common.tsx';
import { BranchState, WorkWho as Who } from './WorkParts.tsx';
import type { WorkItem } from './workModel.ts';

/** A cancelled request cannot replace the next selection's contents. Callers key by target. */
function useRead<T>(load: () => Promise<T>, at: number) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null), [nonce, setNonce] = useState(0);
  useEffect(() => { let live = true; setError(null); load().then(value => { if (live) setData(value); }, e => { if (live) setError((e as Error).message); }); return () => { live = false; }; }, [at, nonce]);
  return { data, error, reload: () => setNonce(n => n + 1) };
}

function FileChanges({ project, target, path, at }: { project: WorkProject; target: WorkTarget; path: string; at: number }) {
  const { data, error, reload } = useRead<WorkDiff>(() => api.workDiff(project.projectId, target, path), at);
  return <div className="min-w-0">
    {error ? <p role="status" className="py-3 text-[12px] text-danger">{error}<TextButton onClick={reload}>Retry</TextButton></p>
      : !data ? <Loading className="py-4" /> : <>{data.diff ? <UnifiedDiff diff={data.diff} /> : <p className="py-3 text-[12px] text-content/50">No changes in this file.</p>}{data.truncated ? <p className="py-2 text-[11px] text-content/50">This diff is truncated.</p> : null}</>}
  </div>;
}

export function WorkDetails({ project, target, item, wide, at, onBack }: { project: WorkProject; target: WorkTarget; item: WorkItem; wide: boolean; at: number; onBack: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null), focusFile = useRef<string | null>(null), focusHeading = useRef(false);
  const area = useRef<HTMLElement>(null);
  const agents = useApp(s => s.snapshot?.agents), home = useApp(s => s.snapshot?.home);
  const { data, error, reload } = useRead<WorkChanges>(() => api.workChanges(project.projectId, target), at + refresh);
  const merge = item.kind === 'merge' ? item.data : item.kind === 'commit' ? project.merged.find(m => m.hash === item.data.hash) : undefined;
  const branch = item.kind === 'branch' ? item.data : undefined;
  const commit = item.kind === 'commit' ? item.data : undefined;
  const agentId = branch?.agentId ?? merge?.agentIds[0] ?? commit?.agentIds[0] ?? project.laneOwners[commit?.key ?? ''];
  const name = (branch?.agentName ?? merge?.names.join(', ') ?? commit?.names.join(', ')) || agents?.find(a => a.id === agentId)?.name;
  const title = branch ? branch.last?.subject ?? branch.branch : commit?.subject ?? merge!.branch;
  const subtitle = branch?.branch ?? commit?.hash.slice(0, 7) ?? merge?.hash?.slice(0, 7) ?? 'History rewritten';
  const conversation = branch?.conversationId ?? merge?.conversationId;
  const refs = branch?.refs ?? merge?.refs ?? [];
  const reviewer = branch?.reviewer ?? merge?.reviewer ?? commit?.reviewer;
  const rows: [string, ReactNode][] = [
    ['Owner', name ? <><Who id={agentId} name={name} />{name}</> : 'Not recorded'],
    ['Status', branch ? <BranchState branch={branch} /> : <StatusLabel tone="neutral">{merge ? 'Merged' : commit?.key === 'main' ? `On ${project.defaultBranch}` : 'On branch'}</StatusLabel>],
    ['Review', reviewer ? `${reviewer}${branch?.state === 'reviewing' ? ' is reviewing' : ', approved'}` : 'Not recorded'],
    ...(branch ? [['vs main', `${branch.ahead} ahead, ${branch.behind} behind`], ['Folder', <span title={branch.folder} className="truncate">{shortPath(branch.folder, home)}</span>]] as [string, ReactNode][] : []),
    ...(merge ? [['Remote', merge.pushed === true ? 'Present at last fetch' : merge.pushed === false ? 'Absent at last fetch' : 'Unknown'], ['History', merge.evidence.kind === 'backup' ? `Original kept in ${merge.evidence.backup}` : merge.rewritten ? 'History rewritten; work retained' : 'As merged']] as [string, ReactNode][] : []),
  ];
  const back = () => { if (file) { focusFile.current = file; setFile(null); } else onBack(); };
  useEffect(() => {
    if (focusHeading.current) { heading.current?.focus(); focusHeading.current = false; }
    if (focusFile.current && !file) { Array.from(area.current?.querySelectorAll<HTMLButtonElement>('[data-work-file]') ?? []).find(el => el.dataset.workFile === focusFile.current)?.focus(); focusFile.current = null; }
  }, [file]);
  return <section ref={area} aria-label="Selected work details" className="min-w-0 px-1.5" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); back(); } }}>
    <div className="flex h-8 items-center gap-1">{!wide || file ? <HeaderButton icon={ChevronLeft} label={file ? 'Back to details' : 'Back to Work'} onClick={back} /> : null}<span className="text-[11px] text-content/50">{file ? 'Changed file' : item.kind === 'branch' ? 'Branch' : item.kind === 'merge' ? 'Merge' : 'Commit'}</span><HeaderButton icon={RefreshCw} label={file ? 'Refresh diff' : 'Refresh changed files'} className="ml-auto" onClick={() => setRefresh(n => n + 1)} />{wide ? <HeaderButton icon={X} label="Close details" onClick={onBack} /> : null}</div>
    <h2 ref={heading} data-work-heading tabIndex={-1} className="mt-1 break-words text-[15px] font-medium text-content/90">{file ? file.split('/').pop() : title}</h2>
    <p className="mt-1 break-all font-mono text-[11px] text-content/50">{file ?? subtitle}</p>
    {file ? <FileChanges key={file} project={project} target={target} path={file} at={at + refresh} /> : <>
      <dl className="mt-5 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[12px]">{rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-content/50">{label}</dt><dd className="flex min-w-0 flex-wrap items-center gap-1.5 break-words text-content/75">{value}</dd></div>)}</dl>
      <div className="mt-6 flex items-center justify-between text-[11px] text-content/55"><span>{data?.basis === 'uncommitted' ? 'Uncommitted changes' : data?.basis === 'branch' ? `Changes since branching from ${project.defaultBranch}` : 'Changed files'}</span><span>{data?.files.length}</span></div>
      {error ? <p role="status" className="py-2 text-[12px] text-danger">{error}<TextButton onClick={reload}>Retry</TextButton></p> : !data ? <Loading className="py-3" /> : <>
        {!data.files.length ? <p className="py-2 text-[12px] text-content/50">No changed files.</p> : data.files.map(f => <TextButton key={f.path} data-work-file={f.path} className="flex w-full items-center gap-2 py-2 text-left" onClick={() => { focusHeading.current = true; setFile(f.path); }}><FileDiff className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate text-[11.5px]" title={f.path}>{f.path}</span><span className="shrink-0 font-mono text-[10px]"><span className="text-diff-add-fg">+{f.added}</span> <span className="text-diff-del-fg">−{f.removed}</span></span></TextButton>)}
        {data.truncated ? <p className="py-2 text-[11px] text-content/50">Showing the first 500 changed files.</p> : null}
      </>}
      {refs.length ? <div className="mt-4 flex flex-wrap gap-1.5">{refs.map(id => <RefChip key={id} id={id} />)}</div> : null}
      <div className="mt-5 flex flex-wrap gap-2">{conversation ? <SecondaryButton onClick={() => openToSide({ kind: 'comms', conversationId: conversation })}>View task</SecondaryButton> : null}{agentId && agents?.some(a => a.id === agentId) ? <SecondaryButton onClick={() => open({ kind: 'agent', agentId })}>Open chat</SecondaryButton> : null}</div>
    </>}
  </section>;
}
