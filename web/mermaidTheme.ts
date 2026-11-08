// Mermaid themed from the app's own colours: the background and content ink (both follow the
// theme's hue and lightness settings), mixed into the few greys the app uses for fills, strokes
// and muted text. Pure, so it is tested directly; the component reads the colours from the page.

export type Rgb = [number, number, number];

/** "rgb(23, 23, 23)" or "rgba(...)" (what getComputedStyle gives) to numbers. */
export function parseRgb(css: string): Rgb | null {
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const hex = (rgb: Rgb) => `#${rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** `amount` of ink over the background, as a solid colour (Mermaid needs solid colours to derive others). */
export function mix(ink: Rgb, background: Rgb, amount: number): string {
  return hex(background.map((b, i) => b + (ink[i] - b) * amount) as Rgb);
}

export interface AppColours {
  ink: Rgb;
  background: Rgb;
  font: string;
  light: boolean;
}

export interface MermaidTheme {
  theme: 'base';
  themeVariables: Record<string, string | boolean | Record<string, string>>;
  themeCSS: string;
  /** Sankey flows take one grey instead of a gradient between Mermaid's node colours. */
  sankey: { linkColor: string };
}

/** Mermaid's `base` theme set up to look like the rest of AgentsCode. */
export function mermaidTheme({ ink, background, font, light }: AppColours): MermaidTheme {
  const fg = hex(ink);
  const bg = hex(background);
  const fill = mix(ink, background, light ? 0.05 : 0.07);
  const raised = mix(ink, background, light ? 0.09 : 0.12);
  const border = mix(ink, background, light ? 0.22 : 0.26);
  const line = mix(ink, background, 0.5);
  const muted = mix(ink, background, 0.7);
  const iconTile = mix(ink, background, light ? 0.14 : 0.18);
  return {
    theme: 'base',
    themeVariables: {
      darkMode: !light,
      background: bg,
      fontFamily: font,
      fontSize: '13px',
      textColor: fg,
      lineColor: line,
      primaryColor: fill,
      primaryTextColor: fg,
      primaryBorderColor: border,
      secondaryColor: raised,
      secondaryTextColor: fg,
      secondaryBorderColor: border,
      tertiaryColor: fill,
      tertiaryTextColor: fg,
      tertiaryBorderColor: border,
      mainBkg: fill,
      nodeBorder: border,
      nodeTextColor: fg,
      clusterBkg: mix(ink, background, light ? 0.025 : 0.035),
      clusterBorder: border,
      titleColor: fg,
      edgeLabelBackground: bg,
      // Sequence diagrams.
      actorBkg: fill,
      actorBorder: border,
      actorTextColor: fg,
      actorLineColor: border,
      signalColor: line,
      signalTextColor: fg,
      labelBoxBkgColor: fill,
      labelBoxBorderColor: border,
      labelTextColor: fg,
      loopTextColor: muted,
      noteBkgColor: raised,
      noteBorderColor: border,
      noteTextColor: fg,
      activationBkgColor: raised,
      activationBorderColor: border,
      sequenceNumberColor: bg,
      // Architecture diagrams.
      archEdgeColor: line,
      archEdgeArrowColor: line,
      archEdgeWidth: '2',
      archGroupBorderColor: border,
      archGroupBorderWidth: '1px',
      // Class, state and ER diagrams.
      classText: fg,
      altBackground: fill,
      attributeBackgroundColorOdd: fill,
      attributeBackgroundColorEven: raised,
      // Gantt: bars in raised greys with readable text; critical and today use stronger ink, not red.
      taskBkgColor: raised,
      taskBorderColor: border,
      taskTextColor: fg,
      taskTextLightColor: fg,
      taskTextDarkColor: fg,
      taskTextOutsideColor: fg,
      taskTextClickableColor: fg,
      activeTaskBkgColor: mix(ink, background, light ? 0.16 : 0.22),
      activeTaskBorderColor: line,
      doneTaskBkgColor: fill,
      doneTaskBorderColor: border,
      critBkgColor: mix(ink, background, light ? 0.24 : 0.32),
      critBorderColor: fg,
      todayLineColor: line,
      sectionBkgColor: fill,
      sectionBkgColor2: bg,
      altSectionBkgColor: bg,
      gridColor: border,
      excludeBkgColor: fill,
      // XY charts: transparent plot, muted axes, series from mid grey up to full ink so bars and lines stay apart.
      xyChart: {
        backgroundColor: 'transparent',
        titleColor: fg,
        dataLabelColor: fg,
        legendTextColor: fg,
        xAxisTitleColor: muted, xAxisLabelColor: muted, xAxisTickColor: border, xAxisLineColor: border,
        yAxisTitleColor: muted, yAxisLabelColor: muted, yAxisTickColor: border, yAxisLineColor: border,
        plotColorPalette: [0.32, 0.92, 0.55, 0.2, 0.75, 0.42].map(amount => mix(ink, background, amount)).join(','),
      },
      // Pie and other charts stay in greys too.
      pie1: mix(ink, background, 0.85), pie2: mix(ink, background, 0.6), pie3: mix(ink, background, 0.4),
      pie4: mix(ink, background, 0.25), pie5: mix(ink, background, 0.15),
      pieStrokeColor: bg, pieOuterStrokeColor: border, pieTitleTextColor: fg, pieSectionTextColor: bg, pieLegendTextColor: fg,
    },
    // Architecture icons are drawn on a hard-coded blue tile with white glyphs; repaint them in the app's greys.
    themeCSS: [
      `.architecture-service rect[style*="087ebf"], .architecture-groups rect[style*="087ebf"] { fill: ${iconTile} !important; }`,
      `.architecture-service [style*="fill: #fff"], .architecture-groups [style*="fill: #fff"], .architecture-service [fill="#fff"], .architecture-groups [fill="#fff"] { fill: ${fg} !important; }`,
      `.architecture-service [style*="stroke: #fff"], .architecture-groups [style*="stroke: #fff"], .architecture-service [stroke="#fff"], .architecture-groups [stroke="#fff"] { stroke: ${fg} !important; }`,
      `.architecture-service text, .architecture-groups text { fill: ${fg} !important; }`,
      // Labels sit under their icon, so an edge leaving a service downward runs through its label.
      // A halo in the background colour keeps the words readable over the line.
      `.architecture-service text, .architecture-groups text { paint-order: stroke fill; stroke: ${bg} !important; stroke-width: 5px; stroke-linejoin: round; }`,
      `.edgeLabel, .edgeLabel p { color: ${muted}; }`,
      // Sankey flows blend with "multiply", which turns them darker than a dark background.
      `.links > .link { mix-blend-mode: normal !important; }`,
    ].join('\n'),
    sankey: { linkColor: mix(ink, background, light ? 0.18 : 0.22) },
  };
}

/** Whether a colour has a hue at all; anything that does is not one of the app's greys. */
export function hasHue([r, g, b]: Rgb): boolean {
  return Math.max(r, g, b) - Math.min(r, g, b) > 12;
}

/**
 * The theme grey standing in for a colour Mermaid (or a diagram's own `style` line) brought in:
 * as light or dark as the original, mixed from the app's ink and background, so contrast between
 * shapes survives but no hue does.
 */
export function themeGrey(colour: Rgb, { ink, background, light }: Pick<AppColours, 'ink' | 'background' | 'light'>): string {
  const [r, g, b] = colour.map(v => v / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const amount = light ? 1 - luminance : luminance;
  return mix(ink, background, Math.max(0.06, Math.min(0.92, amount)));
}

export interface Box { id: string; x: number; y: number; width: number; height: number }

/**
 * Pairs of boxes drawn on top of each other: more than a quarter of the smaller one covered.
 * Mermaid's architecture layout places each service by the sides its edges use, so two services
 * wired to the same side of a third can land on the same spot.
 */
export function overlappingPairs(boxes: readonly Box[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w > 0 && h > 0 && w * h > 0.25 * Math.min(a.width * a.height, b.width * b.height)) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
