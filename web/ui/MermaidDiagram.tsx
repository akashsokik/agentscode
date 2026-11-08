import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, Code, Copy, Maximize2, Minimize2 } from '../mono/icons.tsx';
import { hasHue, mermaidTheme, overlappingPairs, parseRgb, themeGrey, type AppColours, type Rgb } from '../mermaidTheme.ts';

type MermaidApi = typeof import('mermaid').default;

/** Mermaid is large, so it loads on the first diagram, once. */
let loading: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then(module => module.default);
  return loading;
}

/** One render at a time: Mermaid's renderer shares state between calls. */
let queue: Promise<unknown> = Promise.resolve();

/** A colour token as the page resolves it now (it follows the theme's hue and lightness settings). */
function resolved(token: string, fallback: Rgb): Rgb {
  const probe = document.createElement('span');
  probe.style.color = `var(${token})`;
  probe.style.display = 'none';
  document.body.append(probe);
  const rgb = parseRgb(getComputedStyle(probe).color);
  probe.remove();
  return rgb ?? fallback;
}

/** The app's current ink, background and font. */
function appColours(): AppColours {
  const light = document.documentElement.classList.contains('theme-light');
  return {
    ink: resolved('--color-content', light ? [46, 46, 46] : [235, 235, 235]),
    background: resolved('--color-background-base', light ? [247, 247, 247] : [23, 23, 23]),
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
    light,
  };
}

const PAINT = ['fill', 'stroke', 'stop-color', 'color', 'background-color'] as const;

/**
 * The last word on colour: anything in a drawn diagram that still has a hue (Mermaid's fixed
 * palettes for Gantt, Sankey, C4, journeys and charts, or a diagram's own style lines) becomes the
 * theme grey of the same lightness. Runs on the diagram as the page styles it.
 */
export function neutralizeColours(root: Element, colours: AppColours): void {
  for (const el of root.querySelectorAll<SVGElement | HTMLElement>('svg, svg *')) {
    const computed = getComputedStyle(el);
    for (const prop of PAINT) {
      const rgb = parseRgb(computed.getPropertyValue(prop));
      if (rgb && hasHue(rgb)) el.style.setProperty(prop, themeGrey(rgb, colours), 'important');
    }
  }
}

/** Changes whenever the theme does (classes and inline variables on <html>), so diagrams redraw in the new colours. */
function useThemeKey(): string {
  const read = () => `${document.documentElement.className}|${document.documentElement.getAttribute('style') ?? ''}`;
  const [key, setKey] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setKey(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => observer.disconnect();
  }, []);
  return key;
}

/** Render Mermaid source to SVG. strict mode: no click handlers or scripts, labels sanitized by Mermaid. */
export function renderMermaid(id: string, source: string): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      ...mermaidTheme(appColours()),
    });
    try {
      // Parse first: a failed render leaves Mermaid's own error graphic attached to the page.
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      // Mermaid draws in a temporary node (id, or "d" + id); never leave one behind.
      for (const stray of [document.getElementById(`d${id}`), document.getElementById(id)]) {
        if (stray && !stray.closest('[data-mermaid]')) stray.remove();
      }
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Waits for streaming text to settle, so a half-written diagram is not rendered on every token. */
function useSettled(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * A ```mermaid block drawn as a diagram: flowcharts, sequence, architecture, class, ER, state and
 * more. Shows the source instead while it fails to parse, which is normal while it streams in.
 */
export function MermaidDiagram({ source, className = '' }: { source: string; className?: string }) {
  const settled = useSettled(source.trim(), 250);
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const drawn = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const themeKey = useThemeKey();
  useEffect(() => {
    if (!settled) return;
    let live = true;
    renderMermaid(id, settled).then(
      result => { if (live) { setSvg(result); setError(null); } },
      err => { if (live) setError((err as Error).message || 'Could not draw this diagram.'); },
    );
    return () => { live = false; };
  }, [id, settled, themeKey]);

  const copy = () => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // Before paint, so a diagram never shows its own colours even for a frame. Then look for
  // architecture services Mermaid drew on top of each other, to say so instead of leaving it garbled.
  const [overlap, setOverlap] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!drawn.current || !svg || showSource) return;
    neutralizeColours(drawn.current, appColours());
    const boxes = [...drawn.current.querySelectorAll<SVGGElement>('.architecture-service')].map(el => {
      const r = el.getBoundingClientRect();
      const label = el.querySelector('text')?.textContent?.trim();
      return { id: label || el.id, x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const pairs = overlappingPairs(boxes);
    setOverlap(pairs.length ? pairs.map(([a, b]) => `${a} and ${b}`).join('; ') : null);
  }, [svg, showSource]);

  const stale = settled !== source.trim();
  const failed = Boolean(error) && !stale;
  const button = 'grid size-6 place-items-center rounded text-content/45 transition-colors duration-150 hover:bg-content/10 hover:text-content';

  return (
    <figure data-mermaid className={`not-prose group/diagram relative my-3 overflow-hidden rounded-lg border border-content/10 bg-content/[0.02] ${className}`}>
      <div className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md bg-background-base/80 opacity-0 backdrop-blur transition-opacity duration-150 group-hover/diagram:opacity-100 focus-within:opacity-100">
        <button type="button" className={button} onClick={() => setShowSource(s => !s)} aria-pressed={showSource} title={showSource ? 'Show diagram' : 'Show source'} aria-label={showSource ? 'Show diagram' : 'Show source'}>
          <Code className="size-3.5" strokeWidth={1.75} />
        </button>
        <button type="button" className={button} onClick={copy} title="Copy source" aria-label="Copy source">
          {copied ? <Check className="size-3.5" strokeWidth={1.75} /> : <Copy className="size-3.5" strokeWidth={1.75} />}
        </button>
        {svg && !showSource ? (
          <button type="button" className={button} onClick={() => setExpanded(e => !e)} title={expanded ? 'Fit to width' : 'Actual size'} aria-label={expanded ? 'Fit to width' : 'Actual size'}>
            {expanded ? <Minimize2 className="size-3.5" strokeWidth={1.75} /> : <Maximize2 className="size-3.5" strokeWidth={1.75} />}
          </button>
        ) : null}
      </div>
      {showSource || (!svg && error !== null) ? (
        <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[var(--code-font-size)] leading-[1.6] text-content/75">{source}</pre>
      ) : svg ? (
        <div
          ref={drawn}
          className={`mermaid-svg overflow-auto p-4 ${expanded ? '[&_svg]:!max-w-none' : '[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full'}`}
          // Mermaid's strict mode sanitizes labels and drops scripts and handlers from its SVG.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="px-3.5 py-6 text-center font-sans text-[12px] text-content/40">Drawing diagram...</div>
      )}
      {overlap && !showSource && !failed ? (
        <figcaption className="border-t border-content/10 px-3.5 py-1.5 font-sans text-[11.5px] text-content/55">
          Drawn on top of each other: {overlap}. Mermaid places architecture services by the sides their edges use; give each neighbour its own side (L, R, T, B).
        </figcaption>
      ) : null}
      {failed ? <figcaption className="border-t border-content/10 px-3.5 py-1.5 font-sans text-[11.5px] text-danger/90">Could not draw this diagram: {error!.split('\n')[0]}</figcaption> : null}
    </figure>
  );
}
