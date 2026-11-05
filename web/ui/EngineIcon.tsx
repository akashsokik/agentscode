import claudeLogo from '../assets/claude.svg';
import codexLogo from '../assets/codex.svg';
import type { EngineKind } from '../../shared/types.ts';

const LOGOS: Record<EngineKind, string> = { claude: claudeLogo, codex: codexLogo };
export const ENGINE_NAMES: Record<EngineKind, string> = { claude: 'Claude Code', codex: 'Codex' };

/** Provider logo (from MonoCode's provider assets; trademarks of their owners). */
export function EngineIcon({ engine, className = 'size-4' }: { engine: EngineKind; className?: string }) {
  return <img src={LOGOS[engine]} alt={ENGINE_NAMES[engine]} title={ENGINE_NAMES[engine]} className={`shrink-0 select-none ${className}`} draggable={false} />;
}
