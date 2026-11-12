// When a page is older than the build the server serves (web/staleBuild.ts). Pure, so it is tested directly.

export type StaleAction = 'none' | 'notice' | 'reload';

/** No pointer or key for this long and the page counts as idle. */
export const IDLE_MS = 3 * 60_000;

/**
 * What to do. Nothing while either build is unknown or they match; otherwise reload on our own
 * only when the page is hidden or idle and nothing is typed, and only once per server build: a
 * page that is still different after reloading for it (a cached page, say) keeps the notice
 * instead of reloading again, so it can never loop.
 */
export function staleAction(o: { page: string | null; server: string | null | undefined; reloadedFor: string | null; hidden: boolean; idle: boolean; unsent: boolean }): StaleAction {
  if (!o.page || !o.server || o.page === o.server) return 'none';
  if (o.reloadedFor === o.server) return 'notice';
  return (o.hidden || o.idle) && !o.unsent ? 'reload' : 'notice';
}
