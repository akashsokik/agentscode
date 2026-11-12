// Composer drafts: counted as unsent text and kept across a reload in the same tab (web/staleBuild.ts).
//
// The composers keep drafts in memory, per agent and per channel, for tabs that are not on screen
// too. They register those maps here: they count as unsent text, they are saved to sessionStorage
// when the page goes away (any reload, ours, Cmd+R or the menu's), and they are put back when the
// page loads again in the same tab. Other text fields (a dialog, say) are only counted: a page with
// one of those filled in is never reloaded on its own, and a Reload click asks first.

const STASH_KEY = 'podcode:drafts-before-reload';
const stores = new Map<string, Map<string, string>>();

/** This tab's sessionStorage, typed without the DOM library so server-side tests can load this file. */
interface TabStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
function session(): TabStorage | null {
  return (globalThis as { sessionStorage?: TabStorage }).sessionStorage ?? null;
}

function readStash(): Record<string, Record<string, string>> {
  try { return JSON.parse(session()?.getItem(STASH_KEY) ?? '{}') as Record<string, Record<string, string>>; } catch { return {}; }
}

/** Register a composer's drafts map under `name`, first putting back what a reload saved for it. */
export function registerDraftStore(name: string, drafts: Map<string, string>): void {
  stores.set(name, drafts);
  const stash = readStash();
  const saved = stash[name];
  if (!saved) return;
  for (const [key, text] of Object.entries(saved)) if (typeof text === 'string' && !drafts.get(key)) drafts.set(key, text);
  delete stash[name];
  try {
    if (Object.keys(stash).length) session()?.setItem(STASH_KEY, JSON.stringify(stash));
    else session()?.removeItem(STASH_KEY);
  } catch { /* private mode */ }
}

/** Save every registered draft that has text, for the page that loads next in this tab. */
export function stashDrafts(): void {
  const stash: Record<string, Record<string, string>> = {};
  for (const [name, drafts] of stores) {
    const kept = Object.fromEntries([...drafts].filter(([, text]) => text.trim()));
    if (Object.keys(kept).length) stash[name] = kept;
  }
  try {
    if (Object.keys(stash).length) session()?.setItem(STASH_KEY, JSON.stringify(stash));
  } catch { /* private mode: nothing more we can do */ }
}

/** Whether any registered draft has text. */
export function draftsHaveText(): boolean {
  return [...stores.values()].some(drafts => [...drafts.values()].some(text => text.trim()));
}
