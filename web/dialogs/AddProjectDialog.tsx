import { useEffect, useState } from 'react';
import type { DirListing } from '../../shared/types.ts';
import { api } from '../api.ts';
import { attempt, useApp } from '../store.ts';
import { shortPath } from '../format.ts';
import { INPUT, Loading, PRIMARY } from '../ui/common.tsx';
import { ArrowLeft, ChevronRight, Folder, FolderPlus, GitBranch } from '../mono/icons.tsx';
import { Modal } from '../mono/Modal.tsx';
import { SecondaryButton } from '../mono/SecondaryButton.tsx';
import { Group, Row } from '../mono/settings.tsx';
import { submitKey } from './submitKey.ts';

/** Pick a folder on this machine to open as a project. */
export function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded?: (projectId: string) => void }) {
  const home = useApp(s => s.snapshot?.home ?? '');
  const [path, setPath] = useState(home);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const browse = (dir: string) => {
    setError(null);
    api.listDirs(dir).then(result => { setListing(result); setPath(result.path); }, err => setError((err as Error).message));
  };

  useEffect(() => { browse(home); }, [home]);

  const add = async (create = false) => {
    setBusy(true);
    const project = await attempt(() => api.addProject({ path, name: name.trim() || undefined, create }));
    setBusy(false);
    if (project) {
      onAdded?.(project.id);
      onClose();
    }
  };

  return (
    <Modal
      title="Add project"
      description="Agents work inside this folder, or in worktrees of its repository."
      size="md"
      fitViewport
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto min-w-0 truncate font-mono text-[11px] text-content/45" title={path}>{shortPath(path, home)}</span>
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="button" className={PRIMARY} disabled={busy || !path.trim()} onClick={() => void add()}>Open this folder</button>
        </>
      }
    >
      <div className="px-4 pb-5 pt-4">
        <form className="pb-3" onSubmit={e => { e.preventDefault(); browse(path); }}>
          <input value={path} onChange={e => setPath(e.target.value)} className={`${INPUT} font-mono`} spellCheck={false} aria-label="Folder" />
        </form>
        <Group title="Folders" description="Folders that look like code projects are marked with a branch.">
          <div className="h-64 overflow-y-auto p-1">
            {error ? (
              <div className="p-2 font-sans text-[12px]">
                <p className="text-danger">{error}</p>
                <div className="mt-2"><SecondaryButton onClick={() => void add(true)}><FolderPlus className="size-3.5" strokeWidth={1.75} /> Create this folder</SecondaryButton></div>
              </div>
            ) : !listing ? <Loading className="p-2" /> : (
              <>
                {listing.parent ? (
                  <button type="button" onClick={() => browse(listing.parent!)} title={listing.parent} className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left font-sans text-[12px] text-content/60 transition-colors duration-100 hover:bg-content/5 hover:text-content">
                    <ArrowLeft className="size-3.5" strokeWidth={1.75} /> Up one folder
                  </button>
                ) : null}
                {listing.dirs.map(dir => (
                  <button key={dir.path} type="button" onClick={() => browse(dir.path)} className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left font-sans text-[12px] transition-colors duration-100 hover:bg-content/5">
                    {dir.isProject ? <GitBranch className="size-3.5 shrink-0 text-accent" strokeWidth={1.75} /> : <Folder className="size-3.5 shrink-0 text-content/45" strokeWidth={1.75} />}
                    <span className={`min-w-0 truncate ${dir.isProject ? 'text-content' : 'text-content/75'}`}>{dir.name}</span>
                    <ChevronRight className="ml-auto size-3 shrink-0 text-content/30" strokeWidth={1.75} />
                  </button>
                ))}
                {!listing.dirs.length ? <p className="p-2 font-sans text-[12px] text-content/45">No subfolders.</p> : null}
              </>
            )}
          </div>
        </Group>
        <Group title="Project">
          <Row label="Display name" description="Optional. Defaults to the folder name.">
            <input value={name} onChange={e => setName(e.target.value)} onKeyDown={submitKey(!busy && Boolean(path.trim()), () => void add())} placeholder={path.split('/').filter(Boolean).pop() ?? ''} className={`${INPUT} w-44`} />
          </Row>
        </Group>
      </div>
    </Modal>
  );
}
