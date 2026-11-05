import { sparkPath, sparkPoints } from '../dreams.ts';

/**
 * A per-session trend in a few pixels: one quiet line, the latest point in the accent. The title
 * of each point and the label of the whole say the values, so the numbers are never color or
 * shape alone.
 */
export function Sparkline({ values, label, unit, width = 72, height = 20 }: { values: readonly number[]; label: string; unit: string; width?: number; height?: number }) {
  if (values.length < 2) return <span className="inline-block text-[11px] text-content/35" style={{ width }}>{values.length ? '' : 'none yet'}</span>;
  const points = sparkPoints(values, width, height, 3);
  const last = points[points.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}, oldest first: ${values.join(', ')}`}
      className="shrink-0 overflow-visible"
    >
      <path d={sparkPath(points)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-content/35" />
      <circle cx={last.x} cy={last.y} r={2.5} className="fill-accent" />
      {/* Hit targets larger than the marks, each naming its session. */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={6} fill="transparent">
          <title>{`Session ${i + 1} of ${values.length}: ${values[i]} ${unit}`}</title>
        </circle>
      ))}
    </svg>
  );
}
