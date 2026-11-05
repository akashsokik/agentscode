/**
 * The tokens one turn spent, and the hover text for them under a finished response. The text
 * follows MonoCode's TurnMetricsBadge (src/features/sessions/ui/AgentTranscript.tsx, MIT, see
 * NOTICE): "Cache hit 92% · Output 45 tok/s" over "1.2K input · 340 output · 9.1K cached".
 */
import { formatTokens } from './contextUsage.ts';
import type { TurnMeta, TurnUsage } from './types.ts';

/** Every token the turn moved: fresh input, cache reads and writes, and output. */
export function usageTotal(usage: TurnUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
}

/**
 * Share of the prompt served from the cache, 0 to 100, or null when the turn sent no prompt.
 * `inputTokens` excludes cache traffic, so the prompt is input plus cache reads plus writes.
 */
export function cacheHitPercent(usage: TurnUsage): number | null {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return prompt > 0 ? (usage.cacheReadTokens / prompt) * 100 : null;
}

/**
 * What a running total grew by since an earlier reading of the same total. Null when any
 * figure shrank, which means the two readings do not belong to the same running total.
 */
export function usageSince(total: TurnUsage, earlier: TurnUsage): TurnUsage | null {
  const delta: TurnUsage = {
    inputTokens: total.inputTokens - earlier.inputTokens,
    outputTokens: total.outputTokens - earlier.outputTokens,
    cacheReadTokens: total.cacheReadTokens - earlier.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - earlier.cacheWriteTokens,
  };
  return Object.values(delta).every(n => n >= 0) ? delta : null;
}

function formatCost(costUsd: number): string {
  return costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
}

/**
 * Two-line hover text for a finished turn, or null when there is nothing to show. Turns from
 * before usage was recorded fall back to their cost and plain token count.
 */
export function turnMetricsText(meta: TurnMeta | undefined): { headline: string; detail: string } | null {
  if (!meta) return null;
  const { usage, costUsd, tokens, durationMs } = meta;
  const cost = costUsd ? `Cost ${formatCost(costUsd)}` : null;
  if (!usage || usageTotal(usage) === 0) {
    if (!cost && !tokens) return null;
    return { headline: cost ?? 'Turn tokens', detail: tokens ? `${formatTokens(tokens)} tokens` : '' };
  }
  const hit = cacheHitPercent(usage);
  const seconds = durationMs ? durationMs / 1000 : 0;
  const headline = [
    hit === null ? null : `Cache hit ${Math.round(hit)}%`,
    seconds > 0 && usage.outputTokens > 0 ? `Output ${formatTokens(Math.round(usage.outputTokens / seconds))} tok/s` : null,
    cost,
  ].filter(Boolean).join(' · ') || 'Turn tokens';
  const detail = [
    `${formatTokens(usage.inputTokens)} input`,
    `${formatTokens(usage.outputTokens)} output`,
    usage.cacheReadTokens > 0 ? `${formatTokens(usage.cacheReadTokens)} cached` : null,
    usage.cacheWriteTokens > 0 ? `${formatTokens(usage.cacheWriteTokens)} cache write` : null,
  ].filter(Boolean).join(' · ');
  return { headline, detail };
}
