import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { rehypeWordFade } from './rehypeWordFade.ts';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;
const wordRehypePlugins = [[rehypeHighlight, { detect: false }], rehypeWordFade] as never;

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
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
