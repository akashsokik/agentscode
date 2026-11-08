import { lazy, memo, Suspense } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram.tsx';
import { fencedSource, mermaidSource } from '../mermaid.ts';
import { OPENUI_FENCES } from '../../shared/openuiFences.ts';
import { rehypeWordFade } from './rehypeWordFade.ts';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;
const wordRehypePlugins = [[rehypeHighlight, { detect: false }], rehypeWordFade] as never;

/** OpenUI loads with the first block that uses it. */
const OpenUIBlock = lazy(() => import('../openui/OpenUIBlock.tsx'));

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: ({ node, ...props }) => {
    const diagram = mermaidSource(node);
    if (diagram !== null) return <MermaidDiagram source={diagram} />;
    const ui = fencedSource(node, OPENUI_FENCES);
    if (ui !== null) return <Suspense fallback={<pre {...props} />}><OpenUIBlock source={ui} /></Suspense>;
    return <pre {...props} />;
  },
};

/**
 * Agent prose with MonoCode's `.agent-markdown` typography. Raw HTML is not rendered. `words` sets
 * every word in its own span so a reply can fade in word by word (wordFade.ts); keep it fixed for
 * the life of the component, since switching it rebuilds the text.
 */
export const Markdown = memo(function Markdown({ text, className = '', words = false }: { text: string; className?: string; words?: boolean }) {
  return (
    <div className={`agent-markdown min-w-0 font-sans text-sm leading-6 ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={words ? wordRehypePlugins : rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
