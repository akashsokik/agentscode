import type { UsageWindow } from '../shared/types.ts';

/**
 * How the footer words subscription usage, after MonoCode's usage footer: a chip reads
 * "12% 3h 5m · 41% 4d 2h" (each window's use and the time to its reset) and its card reads
 * "Weekly limit", "41% used", "Resets in 4d 2h". Pure, so it is tested directly.
 */

/** "3h 5m", "4d 2h", "12m"; "now" once it has passed. */
export function duration(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days}d ${rest}h` : `${days}d`;
  }
  if (hours > 0) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/** A window's short name: "5h", "wk". */
export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5h';
  if (minutes === 1_440) return '1d';
  if (minutes === 10_080) return 'wk';
  if (minutes === 43_200) return 'mo';
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** A window's card title: "Weekly limit", or "Fable weekly limit" for a model's own. */
export function limitName(minutes: number, model?: string): string {
  const name = minutes === 1_440 ? 'Daily limit'
    : minutes === 10_080 ? 'Weekly limit'
    : minutes === 43_200 ? 'Monthly limit'
    : minutes === 300 ? '5-hour limit'
    : `${windowLabel(minutes)} limit`;
  return model ? `${model} ${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Whether a limit kept for one model applies to an agent known by these names (its model id, its
 * label, what its default resolves to). One way only: an agent on "Fable 5.1" counts against a
 * "Fable" limit, but one on GPT-5.3-Codex does not count against GPT-5.3-Codex-Spark's.
 */
export function modelMatches(limitModel: string, names: string[]): boolean {
  const scope = squash(limitModel);
  return scope.length >= 3 && names.some(name => squash(name).includes(scope));
}

/** The windows that bind an agent on this model: the shared ones, then its model's own. */
export function windowsFor(windows: UsageWindow[], names: string[]): UsageWindow[] {
  return [...windows.filter(w => !w.model), ...windows.filter(w => w.model && modelMatches(w.model, names))];
}

/** Time to the reset, or the window's name when it gave none. */
export function countdown(window: UsageWindow, now: number): string {
  return window.resetsAt === undefined ? windowLabel(window.minutes) : duration(window.resetsAt - now);
}

export function resetLabel(window: UsageWindow, now: number): string {
  if (window.resetsAt === undefined) return `${windowLabel(window.minutes)} window`;
  return window.resetsAt <= now ? 'Resets now' : `Resets in ${duration(window.resetsAt - now)}`;
}

export function percent(used: number): string {
  return `${Math.round(used)}%`;
}

/** The chip's text: each window's use and its countdown, a model's own limit led by its name. */
export function chipLabel(windows: UsageWindow[], now: number): string {
  return windows.map(w => `${w.model ? `${w.model} ` : ''}${percent(w.usedPercent)} ${countdown(w, now)}`).join(' · ');
}

/** The window closest to its limit, which the chip's bar shows. */
export function tightest(windows: UsageWindow[]): UsageWindow | undefined {
  return windows.reduce<UsageWindow | undefined>((best, w) => (!best || w.usedPercent > best.usedPercent ? w : best), undefined);
}

/** A bar's colour: quiet until 80%, amber to 90%, red past it. */
export function usageTone(used: number): 'danger' | 'warning' | 'quiet' {
  return used >= 90 ? 'danger' : used >= 80 ? 'warning' : 'quiet';
}

/** "Updated just now", "Updated 4m ago", for the card's header. */
export function updatedLabel(updatedAt: number | undefined, now: number): string {
  if (updatedAt === undefined) return 'Not read yet';
  const ms = now - updatedAt;
  return ms < 60_000 ? 'Updated just now' : `Updated ${duration(ms)} ago`;
}
