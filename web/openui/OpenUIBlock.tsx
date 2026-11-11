import type { OpenUIError } from '@openuidev/lang-core';
import { Renderer } from '@openuidev/react-lang';
import { useContext, useState } from 'react';
import { Code } from '../mono/icons.tsx';
import { toast } from '../store.ts';
import { clickOutcome } from './charts.ts';
import { OpenUIActionContext } from './context.ts';
import { podcodeLibrary } from './library.tsx';

/**
 * An ```openui-lang block from an agent, drawn with Podcode's components. Buttons send their
 * message to the agent whose transcript holds the block; elsewhere they say where to answer.
 */
export default function OpenUIBlock({ source }: { source: string }) {
  const send = useContext(OpenUIActionContext);
  const [errors, setErrors] = useState<OpenUIError[]>([]);
  const [showSource, setShowSource] = useState(false);
  const problems = errors.filter(e => e.severity !== 'warning');

  const onAction = (event: Parameters<NonNullable<Parameters<typeof Renderer>[0]['onAction']>>[0]) => {
    const outcome = clickOutcome(event);
    if (!outcome) return;
    if (outcome.kind === 'open') { window.open(outcome.url, '_blank', 'noopener,noreferrer'); return; }
    if (send) send(outcome.text);
    else toast('Open the agent to answer from here.', 'info');
  };

  return (
    <figure data-openui className="group/openui relative my-3 min-w-0 font-sans">
      <button
        type="button"
        onClick={() => setShowSource(s => !s)}
        aria-pressed={showSource}
        title={showSource ? 'Show the UI' : 'Show source'}
        aria-label={showSource ? 'Show the UI' : 'Show source'}
        className="absolute -right-1 -top-1 z-10 grid size-6 place-items-center rounded text-content/40 opacity-0 transition-opacity duration-150 hover:bg-content/10 hover:text-content group-hover/openui:opacity-100 focus-visible:opacity-100"
      >
        <Code className="size-3.5" strokeWidth={1.75} />
      </button>
      {showSource ? (
        <pre className="overflow-x-auto rounded-lg border border-content/10 bg-content/[0.03] px-3.5 py-3 font-mono text-[var(--code-font-size)] leading-[1.6] text-content/75">{source}</pre>
      ) : (
        <Renderer response={source} library={podcodeLibrary} onAction={onAction} onError={setErrors} publishObservability={false} />
      )}
      {problems.length ? (
        <figcaption className="mt-1.5 text-[11.5px] text-danger/90" title={problems.map(p => p.message).join('\n')}>
          Part of this could not be drawn: {problems[0].message.split('\n')[0]}
        </figcaption>
      ) : null}
    </figure>
  );
}
