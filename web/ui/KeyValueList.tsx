import type { ReactNode } from 'react';

/**
 * A detail pane's properties: a quiet label on the left, its value on the right, one 28px row each
 * (the Notes detail and the Pull requests detail). `label` is the row's key, so labels are unique.
 * A value of several lines (an issue's commits) keeps its label on its first line.
 */
export function KeyValueList({ rows, labelWidth = '6.5rem' }: { rows: [string, ReactNode][]; labelWidth?: string }) {
  return (
    <dl className="grid text-[12px]" style={{ gridTemplateColumns: `${labelWidth} minmax(0,1fr)` }}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="flex min-h-7 items-center self-start text-content/45">{label}</dt>
          <dd className="flex min-h-7 min-w-0 items-center gap-1.5 text-content/85">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
