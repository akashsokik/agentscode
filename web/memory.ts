/** An agent's soul and memory, as the settings show them. Pure, so it is tested directly. */

/** soul.md holds at most this many characters; the server keeps to the same cap. */
export const SOUL_MAX = 8000;
/** The server's limits on one memory entry. */
export const MEMORY_TEXT_MAX = 1000;
export const MEMORY_WHY_MAX = 500;

/** Where an agent's soul lives, in its own folder. */
export function soulPath(home: string): string {
  return `${home.replace(/\/+$/, '')}/soul.md`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayStart(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** When a memory entry was saved: Today, Yesterday, Nov 3, or Nov 3, 2025 in another year. */
export function memoryDate(ts: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const d = new Date(ts);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}
