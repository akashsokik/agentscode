import { createLibrary, defineComponent, useIsStreaming, useTriggerAction, type ComponentRenderer } from '@openuidev/react-lang';
import { useMemo, useState } from 'react';
import { OPENUI_COMPONENTS, OPENUI_ROOT, type OpenUIComponentName } from '../../shared/openui.ts';
import { cx, StatusLabel, type Tone } from '../ui/common.tsx';
import { MermaidDiagram } from '../ui/MermaidDiagram.tsx';
import { chartSource, sortRows } from './charts.ts';

// AgentsCode's OpenUI components, drawn with the app's own classes: theme greys, the app font,
// its status hues for Status only. Schemas and descriptions come from shared/openui.ts.

type Props<N extends OpenUIComponentName> = Parameters<ComponentRenderer<import('zod').infer<(typeof OPENUI_COMPONENTS)[N]['props']>>>[0];

const GAP = { s: 'gap-2', m: 'gap-3', l: 'gap-5' } as const;

const renderers: { [N in OpenUIComponentName]: (props: Props<N>) => React.ReactNode } = {
  Stack: ({ props, renderNode }) => (
    <div className={cx('flex min-w-0', props.direction === 'row' ? 'flex-row flex-wrap items-stretch [&>*]:min-w-[140px] [&>*]:flex-1' : 'flex-col', GAP[props.gap ?? 'm'])}>
      {renderNode(props.children)}
    </div>
  ),
  Card: ({ props, renderNode }) => (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-content/10 bg-content/[0.03] px-4 py-3.5">
      {props.title ? <h4 className="text-[13px] font-medium text-content/85">{props.title}</h4> : null}
      {renderNode(props.children)}
    </section>
  ),
  Heading: ({ props }) => {
    const level = props.level ?? 2;
    const size = level === 1 ? 'text-[17px]' : level === 2 ? 'text-[15px]' : 'text-[13px]';
    return <p role="heading" aria-level={level + 2} className={cx('font-semibold tracking-tight text-content', size)}>{props.text}</p>;
  },
  Text: ({ props }) => <p className={cx('whitespace-pre-wrap text-[13px] leading-relaxed', props.tone === 'muted' ? 'text-content/50' : 'text-content/80')}>{props.text}</p>,
  Metric: ({ props }) => (
    <div className="min-w-0 rounded-xl border border-content/10 bg-content/[0.03] px-3.5 py-3">
      <div className="truncate text-[12px] text-content/50">{props.label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className="text-xl font-semibold leading-7 tabular-nums text-content">{props.value}</span>
        {props.delta ? <span className="text-[12px] tabular-nums text-content/55">{props.delta}</span> : null}
      </div>
      {props.hint ? <div className="mt-0.5 truncate text-[11.5px] text-content/40">{props.hint}</div> : null}
    </div>
  ),
  Table: ({ props }) => <SortableTable columns={props.columns} rows={props.rows} />,
  Chart: ({ props }) => <MermaidDiagram source={chartSource(props)} className="!my-0" />,
  Diagram: ({ props }) => <MermaidDiagram source={props.source} className="!my-0" />,
  List: ({ props }) => {
    const Tag = props.ordered ? 'ol' : 'ul';
    return (
      <Tag className={cx('flex flex-col gap-1 pl-5 text-[13px] leading-relaxed text-content/80', props.ordered ? 'list-decimal' : 'list-disc marker:text-content/30')}>
        {props.items.map((item, i) => <li key={i}>{item}</li>)}
      </Tag>
    );
  },
  Status: ({ props }) => {
    const tone: Tone = props.tone === 'neutral' ? 'muted' : props.tone;
    return <StatusLabel tone={tone} className="text-[12.5px]">{props.label}</StatusLabel>;
  },
  Progress: ({ props }) => {
    const max = props.max ?? 100;
    const share = Math.max(0, Math.min(1, props.value / max));
    return (
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="truncate text-content/75">{props.label}</span>
          <span className="shrink-0 tabular-nums text-content/45">{max === 100 ? `${Math.round(share * 100)}%` : `${props.value} / ${max}`}</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-content/10" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={props.value} aria-label={props.label}>
          <div className="h-full rounded-full bg-content/60" style={{ width: `${share * 100}%` }} />
        </div>
      </div>
    );
  },
  Code: ({ props }) => (
    <pre className="overflow-x-auto rounded-lg border border-content/10 bg-content/[0.03] px-3.5 py-3 font-mono text-[var(--code-font-size)] leading-[1.6] text-content/80">{props.code}</pre>
  ),
  Button: ({ props }) => <ActionButton label={props.label} action={props.action} variant={props.variant} />,
  Buttons: ({ props, renderNode }) => <div className="flex flex-wrap gap-2">{renderNode(props.buttons)}</div>,
};

function SortableTable({ columns, rows }: { columns: string[]; rows: (string | number | boolean | null)[][] }) {
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const sorted = useMemo(() => (sort ? sortRows(rows, sort.column, sort.descending) : rows), [rows, sort]);
  return (
    <div className="overflow-x-auto rounded-lg border border-content/10">
      <table className="min-w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-content/10 bg-content/[0.03]">
            {columns.map((column, i) => (
              <th key={i} scope="col" className="p-0 text-left font-medium text-content/60">
                <button
                  type="button"
                  onClick={() => setSort(s => (s?.column === i ? { column: i, descending: !s.descending } : { column: i, descending: false }))}
                  className="flex w-full items-center gap-1 px-3 py-1.5 text-left transition-colors duration-100 hover:text-content"
                  aria-sort={sort?.column === i ? (sort.descending ? 'descending' : 'ascending') : undefined}
                >
                  {column}
                  <span aria-hidden className="text-[10px] text-content/35">{sort?.column === i ? (sort.descending ? '▼' : '▲') : ''}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, r) => (
            <tr key={r} className="border-b border-content/5 last:border-b-0">
              {columns.map((_, c) => (
                <td key={c} className={cx('px-3 py-1.5 text-content/80', typeof row[c] === 'number' && 'tabular-nums')}>{row[c] === null || row[c] === undefined ? '' : String(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionButton({ label, action, variant }: { label: string; action?: unknown; variant?: 'primary' | 'secondary' }) {
  const trigger = useTriggerAction();
  const streaming = useIsStreaming();
  return (
    <button
      type="button"
      disabled={streaming}
      onClick={() => void trigger(label, undefined, action as Parameters<typeof trigger>[2])}
      className={cx(
        'h-7 rounded-md px-3 text-[12.5px] font-medium transition-[transform,background-color,opacity] duration-150 active:scale-[0.97] disabled:opacity-40',
        variant === 'secondary' ? 'border border-content/15 text-content/80 hover:bg-content/5 hover:text-content' : 'bg-content text-background-base hover:bg-content/90',
      )}
    >
      {label}
    </button>
  );
}

export const agentsCodeLibrary = createLibrary({
  root: OPENUI_ROOT,
  components: (Object.keys(OPENUI_COMPONENTS) as OpenUIComponentName[]).map(name => defineComponent({
    name,
    props: OPENUI_COMPONENTS[name].props,
    description: OPENUI_COMPONENTS[name].description,
    // The schema and the renderer are paired by name in this file; the map types each pairing.
    component: renderers[name] as unknown as ComponentRenderer<any>,
  })),
});
