/**
 * MonoCode's update UI at the foot of the sidebar (src/app/shell/SidebarUpdate.tsx and
 * UpdateRailCard.tsx in hardbeat920/monocode): an "Update to X" row while an update waits or
 * downloads, and an "Updated to X / What's new" card after one. Only the desktop app has updates;
 * in a browser the bridge is missing and nothing renders. The state comes from
 * electron/updater.ts through window.agentscodeDesktop (electron/preload.cts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandMark } from '../ui/BrandMark.tsx';
import { ArrowDownCircle, Loader, X } from '../mono/icons.tsx';
import {
  isUpdateActionable,
  releaseNotesUrl,
  updatedNotice,
  updateLabel,
  type DesktopUpdates,
  type UpdateSnapshot,
} from '../../shared/updates.ts';

declare global {
  interface Window {
    agentscodeDesktop?: { updates?: DesktopUpdates };
  }
}

const LAST_SEEN_KEY = 'agentscode:lastSeenVersion';

function desktopUpdates(): DesktopUpdates | null {
  return window.agentscodeDesktop?.updates ?? null;
}

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    // private storage: the card simply shows again next time
  }
}

/** The desktop app's update state, live; null in a browser. */
export function useDesktopUpdate(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);
  useEffect(() => {
    const updates = desktopUpdates();
    if (!updates) return;
    let cancelled = false;
    void updates.get().then(next => {
      if (!cancelled && next) setSnapshot(next);
    });
    const off = updates.onChange(next => setSnapshot(next));
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return snapshot;
}

/** The version the app was just updated to, until dismissed; records the version either way. */
function useUpdatedNotice(currentVersion: string | undefined): [string | null, () => void] {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!currentVersion) return;
    const notice = updatedNotice(readLastSeen(), currentVersion);
    if (notice) setVersion(notice);
    else writeLastSeen(currentVersion);
  }, [currentVersion]);
  const dismiss = useCallback(() => {
    if (currentVersion) writeLastSeen(currentVersion);
    setVersion(null);
  }, [currentVersion]);
  return [version, dismiss];
}

/** The sidebar's update footer: renders nothing unless there is an update to act on or announce. */
export function SidebarUpdateFooter() {
  const snapshot = useDesktopUpdate();
  const [updatedTo, dismiss] = useUpdatedNotice(snapshot?.currentVersion);
  const actionable = snapshot ? isUpdateActionable(snapshot) : false;
  if (!snapshot || (!updatedTo && !actionable)) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 p-2 pb-0">
      {updatedTo ? (
        <UpdateRailCard
          version={updatedTo}
          onOpen={() => {
            window.open(releaseNotesUrl(updatedTo), '_blank');
            dismiss();
          }}
          onDismiss={dismiss}
        />
      ) : null}
      {actionable ? <SidebarUpdate snapshot={snapshot} /> : null}
    </div>
  );
}

export function SidebarUpdate({ snapshot }: { snapshot: UpdateSnapshot }) {
  const busy = snapshot.phase === 'downloading' || snapshot.phase === 'ready';
  // `busy` only flips once the app reports the download, so a second click could still land.
  const installing = useRef(false);
  const onClick = useCallback(async () => {
    const updates = desktopUpdates();
    if (busy || installing.current || !updates) return;
    installing.current = true;
    try {
      await updates.install();
    } finally {
      installing.current = false;
    }
  }, [busy]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={snapshot.canInstall ? undefined : 'This build cannot update itself; shows how to install the new version.'}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
        busy ? 'bg-content/5 text-content/75 hover:bg-content/10 hover:text-content' : 'bg-accent/15 text-content hover:bg-accent/20'
      } disabled:cursor-default disabled:opacity-70`}
    >
      <span className="grid size-[18px] shrink-0 place-items-center">
        {busy ? <Loader className="size-4 animate-spin opacity-70" aria-hidden /> : <ArrowDownCircle className="size-4 text-accent" aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-1 items-center">
        <span className="block truncate text-[12px] font-medium leading-tight">{updateLabel(snapshot)}</span>
        <span className="ml-auto block pl-2 text-[11px] text-content/40">v{snapshot.currentVersion}</span>
      </span>
    </button>
  );
}

function UpdateRailCard({ version, onOpen, onDismiss }: { version: string; onOpen: () => void; onDismiss: () => void }) {
  return (
    <section role="status" className="relative overflow-hidden rounded-lg bg-content/12">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-2 pr-8 text-left hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center">
          <BrandMark />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium leading-tight text-content">Updated to {version}</span>
          <span className="mt-0.5 block truncate text-[11px] leading-tight text-content/50">What's new</span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss update notification"
        onClick={onDismiss}
        className="absolute right-1 top-1 grid size-6 place-items-center rounded-md text-content/45 hover:bg-content/8 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </button>
    </section>
  );
}
