import claudeLogo from '../assets/claude.svg';
import codexLogo from '../assets/codex.svg';
import orcacodeLogo from '../assets/orcacode.svg';
import { ENGINE_LABELS, type EngineKind } from '../../shared/types.ts';

const LOGOS: Record<EngineKind, string> = { claude: claudeLogo, codex: codexLogo, orcacode: orcacodeLogo };
export const ENGINE_NAMES: Record<EngineKind, string> = ENGINE_LABELS;

/** Single-color marks drawn in the text color, so they read on dark and light themes alike. */
const MONOCHROME = new Set<EngineKind>(['orcacode']);

/** A one-color SVG mark painted with currentColor (MonoCode's MonoIcon). */
export function MonoMark({ src, label, className = 'size-4' }: { src: string; label: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-block shrink-0 bg-current ${className}`}
      style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")`, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }}
    />
  );
}

/** Provider logo (from MonoCode's provider assets and the OrcaCode site; trademarks of their owners). */
export function EngineIcon({ engine, className = 'size-4' }: { engine: EngineKind; className?: string }) {
  if (MONOCHROME.has(engine)) return <MonoMark src={LOGOS[engine]} label={ENGINE_NAMES[engine]} className={className} />;
  return <img src={LOGOS[engine]} alt={ENGINE_NAMES[engine]} title={ENGINE_NAMES[engine]} className={`shrink-0 select-none ${className}`} draggable={false} />;
}
