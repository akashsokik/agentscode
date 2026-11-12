import { useLayoutEffect, useRef, useState } from 'react';
import { svgSize } from '../diagramView.ts';
import { appColours, neutralizeColours } from './MermaidDiagram.tsx';
import { ZoomViewer } from './ZoomViewer.tsx';

/** A drawn diagram in the full-window viewer (ZoomViewer): pan, zoom, fit, Escape to close. */
export function DiagramViewer({ svg, title = 'Diagram', onClose }: { svg: string; title?: string; onClose: () => void }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  // Draw at the diagram's own size (Mermaid sets width 100% and a max-width), then let the viewer fit it.
  useLayoutEffect(() => {
    const el = canvas.current?.querySelector('svg');
    if (!el || !canvas.current) return;
    const own = svgSize(el) ?? { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
    el.setAttribute('width', String(own.width));
    el.setAttribute('height', String(own.height));
    el.style.maxWidth = 'none';
    neutralizeColours(canvas.current, appColours());
    setSize(own);
  }, [svg]);

  return (
    <ZoomViewer title={title} size={size} onClose={onClose}>
      <div
        ref={canvas}
        data-mermaid
        className="mermaid-svg"
        // The same SVG the chat shows: Mermaid's strict mode already sanitized it.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ZoomViewer>
  );
}
