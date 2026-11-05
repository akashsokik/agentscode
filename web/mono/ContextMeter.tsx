/**
 * Vendored from MonoCode's src/features/sessions/ui/ContextMeter.tsx (MIT, see NOTICE). Changes:
 * the ring uses AgentsCode's warning and danger tokens, and the Compact now action is left out.
 */
import { useRef, useState } from 'react';
import type { ContextUsage } from '../../shared/types.ts';
import { contextRatio, contextTooltip } from '../../shared/contextUsage.ts';
import { Popover } from './Popover.tsx';

const SIZE = 14;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The ring turns amber, then red, as the window fills. */
function ringClass(ratio: number): string {
  if (ratio >= 0.9) return 'text-danger';
  if (ratio >= 0.75) return 'text-warning';
  return 'text-content/45';
}

/**
 * A circular gauge for how full the model's context window is. It renders nothing until the
 * engine has reported both halves, since a ring guessing at a number is worse than no ring.
 * A session with nothing in it yet is the exception: its context is known to be empty, so
 * `empty` shows a bare ring.
 */
export function ContextMeter({ usage, empty = false }: { usage?: ContextUsage; empty?: boolean }) {
  const [hovered, setHovered] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ratio = contextRatio(usage);
  if (!usage || ratio === null) {
    return empty ? (
      <span title="No context used yet" className="grid shrink-0">
        <MeterRing ratio={0} label="No context used yet" />
      </span>
    ) : null;
  }

  const { headline, detail } = contextTooltip(usage);
  return (
    <div ref={root} className="relative grid shrink-0" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <MeterRing ratio={ratio} label={`${headline}, ${detail}`} />
      {hovered ? (
        <Popover anchor={root} side="top" align="end" className="pointer-events-none w-max px-2.5 py-1.5">
          <div className="text-[12px] leading-4 text-content">{headline}</div>
          <div className="text-[11px] leading-4 text-content/50">{detail}</div>
        </Popover>
      ) : null}
    </div>
  );
}

function MeterRing({ ratio, label }: { ratio: number; label?: string }) {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className={ringClass(ratio)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="currentColor" strokeWidth={STROKE} className="opacity-25" />
      {/* A round cap would leave a dot on an empty ring. */}
      {ratio > 0 ? (
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      ) : null}
    </svg>
  );
}
