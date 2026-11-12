import { useState } from 'react';
import type { CleanupFolder, WorkProject } from '../../shared/work.ts';
import { api } from '../api.ts';
import { shortPath } from '../format.ts';
import { AlertCircle } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { attempt, useApp } from '../store.ts';
import { PRIMARY, TextButton } from '../ui/common.tsx';
import { loadWork } from './workData.ts';
import { WorkWho as Who, WorkLabel as Label } from './WorkParts.tsx';

export function CleanupRow({ projects }: { projects: WorkProject[] }) {
  const [dialog, setDialog] = useState(false);
  const branches = projects.reduce((n, p) => n + p.cleanup.branches.length, 0);
  const folders = projects.reduce((n, p) => n + p.cleanup.folders.length, 0);
  if (!branches && !folders) return null;
  return (
    <>
      <TextButton onClick={() => setDialog(true)} title={`${branches} merged branches, ${folders} leftover folders`}>Cleanup ({branches + folders})</TextButton>
      {dialog ? <CleanupDialog projects={projects.filter(p => p.cleanup.branches.length || p.cleanup.folders.length)} onClose={() => setDialog(false)} /> : null}
    </>
  );
}

function Box({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={`grid size-3.5 shrink-0 place-items-center rounded-[4px] ${on ? 'bg-content text-background-base' : 'border border-content/30'} disabled:opacity-40`}
    >
      {on ? <svg aria-hidden viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth={2.6}><path d="m3 8.5 3 3 7-7" /></svg> : null}
    </button>
  );
}

function folderNote(f: CleanupFolder): string {
  if (f.reason === 'missing') return 'folder already gone';
  const real = f.changes.changed + f.changes.untracked - f.changes.links;
  if (real) return `${real} ${real === 1 ? 'file' : 'files'} uncommitted`;
  // Ignored files git never saw (.env and the like) go with the folder: name them.
  if (f.changes.ignored.length) return `ignored: ${f.changes.ignored.slice(0, 2).join(', ')}${f.changes.ignored.length > 2 ? ` +${f.changes.ignored.length - 2}` : ''}`;
  if (f.changes.built) return 'clean (build output)';
  if (f.changes.links) return 'clean (a linked folder)';
  return f.reason === 'detached' ? 'detached, clean' : 'clean';
}

/**
 * The confirm list. Branches start ticked; folders start ticked unless they have uncommitted
 * changes, and ticking one of those asks again. Nothing is removed until Delete.
 */
function CleanupDialog({ projects, onClose }: { projects: WorkProject[]; onClose: () => void }) {
  const home = useApp(s => s.snapshot?.home);
  const [branches, setBranches] = useState(() => new Set(projects.flatMap(p => p.cleanup.branches.map(b => `${p.projectId}\n${b.name}`))));
  const [folders, setFolders] = useState(() => new Set(projects.flatMap(p => p.cleanup.folders.filter(f => !f.dirty).map(f => `${p.projectId}\n${f.path}`))));
  const [confirmDirty, setConfirmDirty] = useState<string | null>(null);
  const [forced, setForced] = useState(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const flip = (set: Set<string>, key: string, update: (next: Set<string>) => void) => { const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); update(next); };
  const byRecord = projects.some(p => p.cleanup.branches.some(b => b.by === 'record'));
  const run = async (withFolders: boolean) => {
    setBusy(true);
    let removed = 0;
    let skipped = 0;
    for (const p of projects) {
      const pick = (set: Set<string>) => [...set].filter(k => k.startsWith(`${p.projectId}\n`)).map(k => k.slice(p.projectId.length + 1));
      const result = await attempt(() => api.workCleanup({ projectId: p.projectId, branches: pick(branches), folders: withFolders ? pick(folders) : [], forceFolders: withFolders ? pick(forced) : [] }));
      if (result) { removed += result.removed.branches.length + result.removed.folders.length; skipped += result.skipped.length; }
    }
    setBusy(false);
    await loadWork(true);
    setDone(`Removed ${removed}${skipped ? `; ${skipped} left as they were` : ''}.`);
  };
  const nBranches = branches.size;
  const nFolders = folders.size;
  return (
    <Modal
      title="Clean up merged work"
      description="Branches whose work is on main, and the folders agents made for them. Main, backup branches and folders in use are never listed."
      size="md"
      fitViewport
      onClose={onClose}
      footer={done ? <button type="button" className={PRIMARY} onClick={onClose}>Done</button> : (
        <>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <SecondaryButton disabled={busy || !nBranches} onClick={() => void run(false)}>Delete {nBranches} {nBranches === 1 ? 'branch' : 'branches'} only</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || (!nBranches && !nFolders)} onClick={() => void run(true)}>{busy ? 'Removing…' : `Delete ${nBranches ? 'branches and ' : ''}${nFolders} ${nFolders === 1 ? 'folder' : 'folders'}`}</button>
        </>
      )}
    >
      <div className="px-4 pb-4 pt-1 font-sans">
        {done ? <p className="py-3 text-[13px] text-content/80">{done}</p> : projects.map(p => (
          <section key={p.projectId} className="pt-2">
            {projects.length > 1 ? <p className="pb-1 text-[12.5px] font-medium text-content">{p.name}</p> : null}
            {p.cleanup.branches.length ? (
              <>
                <Label count={`${p.cleanup.branches.length}${p.cleanup.branches.some(b => b.by === 'record' && b.evidence !== 'main') ? ', some merged by our records' : ''}`}>Branches</Label>
                {p.cleanup.branches.map(b => {
                  const key = `${p.projectId}\n${b.name}`;
                  return (
                    <div key={b.name} className="flex h-7 items-center gap-2 whitespace-nowrap text-[12px]">
                      <Box on={branches.has(key)} label={`Delete branch ${b.name}`} onToggle={() => flip(branches, key, setBranches)} />
                      <Who name={b.agentName} size="size-3.5" />
                      <span className="min-w-0 truncate font-mono text-[11.5px]">{b.name}</span>
                      <span className="ml-auto shrink-0 text-content/40" title={b.backup ? `Its commits stay in ${b.backup}` : undefined}>{b.inFolder ? 'goes with its folder' : b.backup ? `kept in ${b.backup}` : b.evidence === 'content' ? 'merged, history rewritten' : 'merged'}</span>
                    </div>
                  );
                })}
              </>
            ) : null}
            {p.cleanup.folders.length ? (
              <>
                <Label count={`${p.cleanup.folders.length}, need your OK`}>Folders</Label>
                {p.cleanup.folders.map(f => {
                  const key = `${p.projectId}\n${f.path}`;
                  const asking = confirmDirty === key;
                  return (
                    <div key={f.path}>
                      <div className="flex h-7 items-center gap-2 whitespace-nowrap text-[12px]">
                        <Box
                          on={folders.has(key)}
                          label={`Remove folder ${f.path}`}
                          onToggle={() => {
                            if (f.dirty && !folders.has(key)) { setConfirmDirty(key); return; }
                            flip(folders, key, setFolders);
                            if (f.dirty) flip(forced, key, setForced);
                          }}
                        />
                        <Who id={f.agentId} name={f.agentName} size="size-3.5" />
                        <span className="min-w-0 truncate font-mono text-[11.5px] text-content/70" title={f.path}>{shortPath(f.path, home)}</span>
                        <span className={`ml-auto shrink-0 ${f.dirty ? 'text-content/70' : 'text-content/40'}`}>{folderNote(f)}</span>
                      </div>
                      {asking ? (
                        <div className="mb-1 ml-6 flex items-center gap-2 rounded-md bg-content/5 px-2 py-1.5 text-[12px] text-content/70">
                          <span className="min-w-0 flex-1">Remove it with its uncommitted changes? They are lost.</span>
                          <SecondaryButton onClick={() => setConfirmDirty(null)}>Keep</SecondaryButton>
                          <SecondaryButton danger onClick={() => { flip(folders, key, setFolders); flip(forced, key, setForced); setConfirmDirty(null); }}>Remove anyway</SecondaryButton>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </>
            ) : null}
          </section>
        ))}
        {!done ? (
          <p className="mt-3 flex gap-2 rounded-lg bg-content/5 px-2.5 py-2 text-[12px] leading-normal text-content/60">
            <AlertCircle aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
            <span>
              {byRecord ? 'After a history rewrite, git no longer sees some of these branches as merged; PodCode knows from its merge and review records, so they wait for your OK here. ' : ''}
              Only merges with proof their work is on main are listed. Removing a folder deletes its files, ignored ones too (a linked node_modules is only unlinked), so it always waits for you; folders with uncommitted or ignored files ask twice. Nothing here is pushed, and main is never touched.
            </span>
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
