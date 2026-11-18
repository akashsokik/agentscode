import { agentLook, AVATAR_FILL } from '../../shared/avatar.ts';
import { useApp } from '../store.ts';
import type { StorageCleanupCandidate, StorageCleanupResult } from '../../shared/storageCleanup.ts';
import { Modal } from '../mono/Modal.tsx';
import { useContext, useEffect, useRef, useState } from 'react';
import { storageSize, type StorageSnapshot } from '../../shared/storage.ts';
import { api } from '../api.ts';
import { Group, Row, RevealedSetting } from '../mono/settings.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { FolderOpen, RefreshCw, ChevronRight, Archive } from '../mono/icons.tsx';
import { RevealHeight } from '../mono/RevealHeight.tsx';
import { HoverCard, useHoverCard } from '../ui/HoverCard.tsx';
import { IS_MAC } from '../platform.ts';
import { StatusMark } from '../ui/StatusMark.tsx';

const revealLabel = IS_MAC ? 'Reveal in Finder' : 'Show in folder';

interface Part { key: string; label: string; bytes: number; color: string }
const Dot = ({ color }: { color: string }) => <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />;

/** Storage-specific segments and legend share the existing hover/focus card lifecycle. */
function StoragePart({ part, total, bar = false }: { part: Part; total: number; bar?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null), hover = useHoverCard();
  return <>
    <button ref={anchor} type="button" {...hover.chipEvents} tabIndex={bar ? -1 : 0} aria-label={`${part.label}: ${storageSize(part.bytes)}`} aria-describedby={hover.open ? hover.cardId : undefined}
      className={bar ? 'h-full min-w-0 shrink-0 hover:brightness-110 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-content' : 'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded text-[12px] leading-[18px] text-content/75 hover:text-content'}
      style={bar ? { width: `${total ? part.bytes / total * 100 : 0}%`, background: part.color } : undefined}>
      {!bar ? <><Dot color={part.color} /><span className="min-w-0 truncate">{part.label}</span><span className="shrink-0 tabular-nums text-content/40">{storageSize(part.bytes)}</span></> : null}
    </button>
    {hover.open ? <HoverCard id={hover.cardId} anchor={anchor.current} width={220} padding="px-3 py-2" onEnter={hover.onCardEnter} onLeave={hover.onCardLeave} onClose={hover.close}>
      <span className="flex items-center gap-2 text-[12px]"><Dot color={part.color} /><span className="min-w-0 flex-1 break-words">{part.label}</span><span className="shrink-0 tabular-nums text-content/60">{storageSize(part.bytes)}</span></span>
    </HoverCard> : null}
  </>;
}

export function StorageSettings() {
  const [data, setData] = useState<StorageSnapshot | null>(null);
  const liveAgents = useApp(s => s.snapshot?.agents);
  const revealed = useContext(RevealedSetting);
  useEffect(() => {
    if (data && revealed?.startsWith('storage-')) document.getElementById(revealed)?.scrollIntoView({ block: 'center' });
  }, [data, revealed]);
  const colorOf = (id: string, fallback: string) => { const agent = liveAgents?.find(a => a.id === id); return agent ? AVATAR_FILL[agentLook(agent).color] : fallback; };
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [clean, setClean] = useState(false), [empty, setEmpty] = useState(false);
  const alive = useRef(true);
  const load = async (force = false) => {
    setBusy(true); setError('');
    try { const next = await api.storage(force); if (alive.current) setData(next); }
    catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
  const reveal = async (body: { agentId: string } | { target: 'data' | 'backups' }) => {
    try { await api.revealStorage(body); } catch (e) { setError((e as Error).message); }
  };
  const toggle = (id: string) => setOpened(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const shared = data?.shared;
  const parts: Part[] = data ? [
    ...data.agents.map(a => ({ key: a.id, label: a.name, bytes: a.total, color: colorOf(a.id, a.color) })),
    { key: 'unassignedWorktrees', label: 'Unassigned worktrees', bytes: data.shared.unassignedWorktrees, color: '#77777d' },
    { key: 'unassignedAgents', label: 'Unassigned agent folders', bytes: data.shared.unassignedAgents, color: '#8b8b92' },
    { key: 'transcripts', label: 'Transcripts', bytes: data.shared.transcripts, color: '#a0a0a5' },
    { key: 'channels', label: 'Channels', bytes: data.shared.channels, color: '#b0b0b5' },
    { key: 'attachments', label: 'Attachments', bytes: data.shared.attachments, color: '#66666d' },
    { key: 'archive', label: 'Archive', bytes: data.shared.archive, color: '#bcbcc1' },
    { key: 'backups', label: 'Backups', bytes: data.shared.backups, color: '#81818a' },
    { key: 'other', label: 'Other', bytes: data.shared.other + data.shared.projects + data.shared.state, color: '#93939a' },
  ] : [];
  return <>
    <div className="mb-6 flex flex-wrap items-center gap-3 text-[12px] text-content/45">
      <span>{data ? `Measured ${new Date(data.measuredAt).toLocaleString()}` : 'Measuring disk usage'}</span>
      <SecondaryButton disabled={busy} onClick={() => void load(true)}>{busy ? <StatusMark state="pending" label="Measuring disk usage" /> : <RefreshCw className="size-3.5" />}Refresh</SecondaryButton>
    </div>
    {error ? <p role="alert" className="mb-4 text-[13px] text-danger">{error}</p> : null}
    {data?.status !== 'complete' && data ? <p role="status" className="mb-4 text-[13px] text-content/60">{data.status === 'error' ? 'The data folder could not be measured. The totals below are incomplete.' : `Some folders could not be measured (${data.errors}). Totals are partial; try Refresh.`}</p> : null}
    {data ? <>
      <section id="storage-usage" data-setting-id="storage-usage" className="rounded-xl border border-content/10 bg-content/3 px-6 py-5">
        <div className="flex flex-wrap items-baseline gap-2.5"><span className="text-[28px] font-semibold leading-tight tracking-tight tabular-nums">{storageSize(data.total)}</span><span className="text-[13px] text-content/55">used by PodCode{data.status !== 'complete' ? ' (partial)' : ''}</span></div>
        <p className="mt-2 text-[12px] text-content/40">Agents, workspaces and shared data</p>
        <div role="group" aria-label="PodCode disk usage by category" className="mt-6 flex h-7 w-full overflow-hidden rounded-md">
          {parts.filter(p => p.bytes > 0).map(part => <StoragePart key={part.key} part={part} total={data.total} bar />)}
        </div>
        <div aria-label="Storage legend" className="mt-4 flex flex-wrap gap-x-[18px] gap-y-2.5">{parts.filter(p => p.bytes > 0 || ['channels', 'backups', ...data.agents.map(a => a.id)].includes(p.key)).map(part => <StoragePart key={part.key} part={part} total={data.total} />)}</div>
      </section>
      <Group id="storage-agents" title="Agents" description="Largest first. Open an agent to see its folders.">
        {data.agents.length ? data.agents.map(a => <div key={a.id} className="border-b border-content/5 last:border-b-0">
          <button type="button" onClick={() => toggle(a.id)} aria-expanded={opened.has(a.id)} aria-controls={`storage-agent-${a.id}`} className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13px] font-medium hover:bg-content/3">
            <Dot color={colorOf(a.id, a.color)} /><span className="min-w-0 truncate">{a.name}</span><span className="ml-auto shrink-0 text-[12px] font-normal tabular-nums text-content/60">{storageSize(a.total)}</span><ChevronRight className={`ml-1 size-3.5 shrink-0 text-content/35 ${opened.has(a.id) ? 'rotate-90' : ''}`} />
          </button>
          <RevealHeight open={opened.has(a.id)}><div id={`storage-agent-${a.id}`} className="px-10 pb-4 text-[12px] text-content/50">
            {([['Home / memory', a.home], ['Workspace', a.workspace], ['Worktrees', a.worktrees]] as const).map(([label, size]) => <div key={label} className="flex justify-between gap-4 py-1.5"><span>{label}</span><span className="tabular-nums">{storageSize(size)}</span></div>)}
            <div className="mt-2"><SecondaryButton onClick={() => void reveal({ agentId: a.id })}><FolderOpen className="size-3.5" />{revealLabel}</SecondaryButton></div>
          </div></RevealHeight>
        </div>) : <p className="px-4 py-3.5 text-[12px] text-content/45">No agent folders yet.</p>}
      </Group>
      <Group id="storage-worktrees" title="Worktrees" description="Kept separate from private workspaces.">
        <Row label="Unassigned worktrees" description="Retained in the total until ownership is known."><span className="text-[13px] tabular-nums">{storageSize(shared!.unassignedWorktrees)}</span></Row>
        <Row label="Agent worktrees" description="Registered worktrees are attributed to their agent above."><span className="text-[13px] tabular-nums">{storageSize(data.agents.reduce((n, a) => n + a.worktrees, 0))}</span></Row>
        {shared!.unassignedAgents ? <Row label="Unassigned agent folders" description="Folders without a current agent record."><span className="text-[13px] tabular-nums">{storageSize(shared!.unassignedAgents)}</span></Row> : null}
      </Group>
      <Group id="storage-shared" title="Shared data" description="App data shared across the team.">
        {([['Transcripts', shared!.transcripts], ['Channels', shared!.channels], ['Attachments', shared!.attachments], ['Archive', shared!.archive], ['Projects', shared!.projects], ['state.json', shared!.state], ['Backups', shared!.backups], ['Other', shared!.other]] as const).map(([label, size]) => <Row key={label} label={label}><span className="text-[13px] tabular-nums">{storageSize(size)}</span></Row>)}
      </Group>
      <Group id="storage-manage" title="Manage storage" description="Nothing is removed automatically.">
        <Row label={revealLabel} description="Open PodCode’s data folder."><SecondaryButton onClick={() => void reveal({ target: 'data' })}><FolderOpen className="size-3.5" />Reveal</SecondaryButton></Row>
        <Row label="Review clean up" description="Review merged worktrees and build outputs. Back up before removing anything."><SecondaryButton onClick={() => setClean(true)}><Archive className="size-3.5" />Review</SecondaryButton></Row>
        <Row label="Empty backups" description="Permanently remove storage-cleanup backups. Other backups are kept."><SecondaryButton disabled={!shared!.backups} onClick={() => setEmpty(true)}>Empty backups</SecondaryButton></Row>
      </Group>
      <p className="mt-6 text-[12px] leading-relaxed text-content/40">Only managed PodCode folders are counted once. Linked folders and original project checkouts are excluded. Allocated disk usage is an estimate.</p>
    </> : null}
    {clean ? <StorageCleanupDialog onClose={() => setClean(false)} onChanged={() => void load(true)} /> : null}
    {empty ? <EmptyBackupsDialog onClose={() => setEmpty(false)} onChanged={() => void load(true)} /> : null}
  </>;
}


/** Storage's two-step review keeps selection separate from the explicit destructive confirmation. */
function StorageCleanupDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [candidates, setCandidates] = useState<StorageCleanupCandidate[]>([]), [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const [error, setError] = useState(''), [result, setResult] = useState<StorageCleanupResult | null>(null);
  useEffect(() => {
    let alive = true;
    void api.storageCandidates().then(r => { if (alive) setCandidates(r.candidates); }).catch(e => { if (alive) setError((e as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);
  const chosen = candidates.filter(c => selected.has(c.id));
  const run = async () => {
    if (!confirm || !chosen.length || busy) return;
    setBusy(true); setError('');
    try { setResult(await api.cleanupStorage(chosen.map(c => c.id))); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={result ? 'Clean up result' : confirm ? 'Confirm selected items' : 'Review clean up'} size="md" fitViewport onClose={() => { if (!busy) onClose(); }}
    footer={<div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={onClose}>{result ? 'Done' : 'Cancel'}</SecondaryButton>{!result ? <SecondaryButton danger={confirm} disabled={loading || busy || !chosen.length || Boolean(error)} onClick={() => confirm ? void run() : setConfirm(true)}>{busy ? <StatusMark state="pending" label="Backing up selected items" /> : null}{confirm ? 'Back up and remove selected' : `Review ${chosen.length} selected`}</SecondaryButton> : null}</div>}>
    <div className="px-4 py-4"><p className="text-[13px] leading-relaxed text-content/60">Build outputs move to backups and free space only after Empty backups. Clean merged worktrees are removed after their Git backup reference and recovery manifest are saved. Every selected item is checked again before removal.</p>
    {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
    {loading ? <div className="mt-4 flex items-center gap-2 text-[12px] text-content/50"><StatusMark state="pending" label="Finding cleanup candidates" />Finding candidates</div> : null}
    {!loading && !result ? <>
      {!candidates.length && !error ? <p className="mt-4 text-[13px] text-content/50">No eligible clean, idle worktrees or build outputs.</p> : null}
      <div className="mt-4 divide-y divide-stroke">{(confirm ? chosen : candidates).map(c => <label key={c.id} className="flex items-start gap-3 py-3">
        {!confirm ? <input type="checkbox" checked={selected.has(c.id)} onChange={event => setSelected(previous => { const next = new Set(previous); event.target.checked ? next.add(c.id) : next.delete(c.id); return next; })} className="mt-1 size-3.5 shrink-0 accent-current" /> : null}
        <span className="min-w-0 flex-1"><span className="block break-words text-[13px] font-medium">{c.label}</span><span className="mt-1 block break-words text-[12px] text-content/45">{c.relPath}</span><span className="mt-1 block text-[12px] text-content/45">{c.reason}</span></span><span className="shrink-0 text-[12px] tabular-nums text-content/60">{storageSize(c.bytes)}</span>
      </label>)}</div>
      {confirm && chosen.length ? <p className="mt-4 text-[12px] text-content/60">Only these {chosen.length} selected items will be processed. Backups are kept in PodCode’s backups folder. Nothing is removed automatically.</p> : null}
      {confirm ? <div className="mt-3"><SecondaryButton disabled={busy} onClick={() => { setConfirm(false); setError(''); }}>Change selection</SecondaryButton></div> : null}
    </> : null}
    {result ? <div role="status" className="mt-4 space-y-3 text-[13px] text-content/60">
      <p>{result.removed.length} {result.removed.length === 1 ? 'item' : 'items'} processed. {result.skipped.length} skipped.</p>
      {result.backupDir ? <p className="break-words">Backup: {result.backupDir}</p> : null}
      {result.skipped.map(s => <p key={s.id}>{s.reason}</p>)}
      <p>Build outputs still occupy disk space in backups. Empty backups has a separate confirmation.</p>
    </div> : null}
    </div>
  </Modal>;
}

function EmptyBackupsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  const run = async () => {
    setBusy(true); setError('');
    try { await api.emptyStorageBackups(); setDone(true); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={done ? 'Storage-cleanup backups emptied' : 'Permanently empty backups?'} size="sm" onClose={() => { if (!busy) onClose(); }} footer={<div className="flex justify-end gap-2"><SecondaryButton disabled={busy} onClick={onClose}>{done ? 'Done' : 'Cancel'}</SecondaryButton>{!done ? <SecondaryButton danger disabled={busy} onClick={() => void run()}>{busy ? <StatusMark state="pending" label="Emptying backups" /> : null}Permanently empty backups</SecondaryButton> : null}</div>}>
    <div className="px-4 py-4"><p className="text-[13px] leading-relaxed text-content/60">{done ? 'The request finished. Other backups and Git backup references are kept. Refresh shows the remaining disk usage.' : 'This permanently removes recognised storage-cleanup backup folders. Build outputs in those backups cannot be restored afterwards. Other backups and Git backup references are kept.'}</p>
    {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
    </div>
  </Modal>;
}
