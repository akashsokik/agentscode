// A page left open from an older build (a forgotten browser tab, a window kept across a restart)
// would run old code against the new server. The server says which build it serves now (the
// 'build' event, server/buildStamp.ts); when that is not this page's build, the page reloads on
// its own while nobody is using it, or shows a quiet notice to reload (StaleBuildNotice).
import { useEffect, useState } from 'react';
import { buildId } from '../shared/buildInfo.ts';
import { IDLE_MS, staleAction, type StaleAction } from '../shared/staleBuild.ts';
import { BUILD } from './buildInfo.ts';
import { useApp } from './store.ts';
import { draftsHaveText, stashDrafts } from './draftStore.ts';
import { fieldsHaveText } from './unsent.ts';

/** sessionStorage: the server build this tab already reloaded for, so it never reloads twice for it. */
export const RELOADED_KEY = 'podcode:reloaded-for-build';

/** This page's build, or null in `npm run dev`, whose stamp is Vite's start time, not a build's. */
export function pageBuildId(): string | null {
  return import.meta.env?.DEV ? null : buildId(BUILD);
}

function reloadedFor(): string | null {
  try { return sessionStorage.getItem(RELOADED_KEY); } catch { return null; }
}

/** Reload now, for the server build `server` (remembered, so this tab does it once for that build). */
export function reloadFor(server: string): void {
  try { sessionStorage.setItem(RELOADED_KEY, server); } catch { /* private mode */ }
  stashDrafts();
  location.reload();
}

/**
 * Watches for a newer server build. Returns the server build to offer a reload for (show the
 * notice), or null. Reloads by itself when that is safe (staleAction).
 */
export function useStaleBuild(): string | null {
  const server = useApp(s => s.serverBuild);
  const [action, setAction] = useState<StaleAction>('none');
  useEffect(() => {
    const page = pageBuildId();
    if (!page || !server || page === server) { setAction('none'); return; }
    let lastInput = Date.now();
    const check = () => {
      const next = staleAction({
        page, server, reloadedFor: reloadedFor(), hidden: document.visibilityState === 'hidden',
        idle: Date.now() - lastInput >= IDLE_MS, unsent: draftsHaveText() || fieldsHaveText(),
      });
      if (next === 'reload') reloadFor(server);
      else setAction(next);
    };
    const input = () => { lastInput = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, input, { passive: true, capture: true });
    document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 30_000);
    check();
    return () => {
      for (const e of events) window.removeEventListener(e, input, { capture: true });
      document.removeEventListener('visibilitychange', check);
      window.clearInterval(timer);
    };
  }, [server]);
  return action === 'notice' && server ? server : null;
}
