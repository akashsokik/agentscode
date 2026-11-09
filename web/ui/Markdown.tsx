import { lazy, memo, Suspense } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram.tsx';
import { fencedSource, mermaidSource } from '../mermaid.ts';
import { OPENUI_FENCES } from '../../shared/openuiFences.ts';
import { rehypeWordFade } from './rehypeWordFade.ts';
import { openUiLive } from '../openuiTrust.ts';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;
const wordRehypePlugins = [[rehypeHighlight, { detect: false }], rehypeWordFade] as never;

/** OpenUI loads with the first block that uses it. */
const OpenUIBlock = lazy(() => import('../openui/OpenUIBlock.tsx'));

const link: Components['a'] = ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />;

/**
 * Code blocks: a mermaid fence draws as a diagram, an openui-lang fence as live UI when openUiLive
 * allows it (never for text another agent wrote), anything else as code.
 */
function componentsFor(fromAnotherAgent: boolean): Components {
  return {
    a: link,
    pre: ({ node, ...props }) => {
      const diagram = mermaidSource(node);
      if (diagram !== null) return <MermaidDiagram source={diagram} />;
      const ui = fencedSource(node, OPENUI_FENCES);
      if (ui !== null && openUiLive(true, fromAnotherAgent)) return <Suspense fallback={<pre {...props} />}><OpenUIBlock source={ui} /></Suspense>;
      return <pre {...props} />;
    },
  };
}

const components = componentsFor(false);
/** For a teammate's message: its openui-lang blocks stay code, since their buttons would answer as you. */
const inertComponents = componentsFor(true);

/**
 * Agent prose with MonoCode's `.agent-markdown` typography. Raw HTML is not rendered. `words` sets
 * every word in its own span so a reply can fade in word by word (wordFade.ts); keep it fixed for
 * the life of the component, since switching it rebuilds the text.
 */
export const Markdown = memo(function Markdown({ text, className = '', words = false, inert = false }: {
  text: string;
  className?: string;
  words?: boolean;
  /** Text from another agent: interactive blocks render as plain code. */
  inert?: boolean;
}) {
  return (
    <div className={`agent-markdown min-w-0 font-sans text-sm leading-6 ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={words ? wordRehypePlugins : rehypePlugins}
        components={inert ? inertComponents : components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
