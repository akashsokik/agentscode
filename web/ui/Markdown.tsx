import { lazy, memo, Suspense, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram.tsx';
import { fencedSource, mermaidSource } from '../mermaid.ts';
import { OPENUI_FENCES } from '../../shared/openuiFences.ts';
import { rehypeWordFade } from './rehypeWordFade.ts';
import { openUiLive } from '../openuiTrust.ts';
import { rehypeRefChips } from './rehypeRefChips.ts';
import { RefChip } from '../notes/RefChip.tsx';
import { isKnownRef, useNotes } from '../notes/refsState.ts';
import { IssueKeyChip, isKnownIssueKey, useIssueKeysKey } from './IssueKeyChip.tsx';

const remarkPlugins = [remarkGfm];
const refChips = [rehypeRefChips, { known: isKnownRef, issue: isKnownIssueKey }];
const rehypePlugins = [[rehypeHighlight, { detect: false }], refChips] as never;
// Chips first, so word fading treats each chip as one word.
const wordRehypePlugins = [[rehypeHighlight, { detect: false }], refChips, rehypeWordFade] as never;

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
    span: ({ node, ...props }) => {
      const ref = node?.properties?.dataRef;
      if (typeof ref === 'string') return <RefChip id={ref} fade={node?.properties?.dataWordFade !== undefined} />;
      const issueKey = node?.properties?.dataIssueKey;
      if (typeof issueKey === 'string') return <IssueKeyChip issueKey={issueKey} fade={node?.properties?.dataWordFade !== undefined} />;
      return <span {...props} />;
    },
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
 * For text from outside PodCode (a GitHub PR description): inert as a teammate's, links only to
 * http(s), and images never loaded from someone else's server: an image is its alt text, linked.
 */
const remoteComponents: Components = {
  ...inertComponents,
  a: ({ node: _node, href, children }) => (/^https?:\/\//i.test(href ?? '') ? <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>),
  img: ({ src, alt }) => {
    const label = alt?.trim() || 'image';
    return typeof src === 'string' && /^https?:\/\//i.test(src) ? <a href={src} target="_blank" rel="noreferrer noopener">[{label}]</a> : <span>[{label}]</span>;
  },
};

/**
 * Agent prose with MonoCode's `.agent-markdown` typography. Raw HTML is not rendered. `words` sets
 * every word in its own span so a reply can fade in word by word (wordFade.ts); keep it fixed for
 * the life of the component, since switching it rebuilds the text.
 */
export const Markdown = memo(function Markdown({ text, className = '', words = false, inert = false, remote = false }: {
  text: string;
  className?: string;
  words?: boolean;
  /** Text from another agent: interactive blocks render as plain code. */
  inert?: boolean;
  /** Text from outside PodCode (GitHub): inert, http(s) links only, no remote images. */
  remote?: boolean;
}) {
  // Text is parsed again when an id is added or removed, so new ids become chips in old messages.
  const ids = useNotes(s => s.idsKey);
  // And when an issue is added or removed, so its key becomes a chip, or text again.
  const issueKeys = useIssueKeysKey();
  const rehype = useMemo(() => (words ? [...(wordRehypePlugins as unknown[])] : [...(rehypePlugins as unknown[])]) as never, [words, ids, issueKeys]);
  return (
    <div className={`agent-markdown min-w-0 font-sans text-sm leading-6 ${className}`}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehype}
        components={remote ? remoteComponents : inert ? inertComponents : components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
