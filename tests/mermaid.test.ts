import assert from 'node:assert/strict';
import test from 'node:test';
import type { Element, Root } from 'hast';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { mermaidSource } from '../web/mermaid.ts';

/** The pre elements the app's markdown pipeline produces (highlighting aside: see the hand-built case below). */
async function pres(markdown: string): Promise<Element[]> {
  const processor = unified().use(remarkParse).use(remarkRehype);
  const tree = await processor.run(processor.parse(markdown)) as Root;
  return tree.children.filter((n): n is Element => n.type === 'element' && n.tagName === 'pre');
}

test('a mermaid fence yields its source; other fences do not', async () => {
  const [diagram, ts, plain] = await pres('```mermaid\nsequenceDiagram\n  A->>B: hi\n```\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```\n');
  assert.equal(mermaidSource(diagram), 'sequenceDiagram\n  A->>B: hi');
  assert.equal(mermaidSource(ts), null);
  assert.equal(mermaidSource(plain), null);
  assert.equal(mermaidSource(undefined), null);
});

test('the source survives highlighting spans inside the code element', () => {
  const pre: Element = {
    type: 'element', tagName: 'pre', properties: {}, children: [{
      type: 'element', tagName: 'code', properties: { className: ['hljs', 'language-mermaid'] },
      children: [{ type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: 'flowchart' }] }, { type: 'text', value: ' LR\n' }],
    }],
  };
  assert.equal(mermaidSource(pre), 'flowchart LR');
});

test('diagrams take their colours from the app theme', async () => {
  const { mermaidTheme, mix, parseRgb } = await import('../web/mermaidTheme.ts');
  assert.deepEqual(parseRgb('rgb(23, 23, 23)'), [23, 23, 23]);
  assert.deepEqual(parseRgb('rgba(235, 235, 235, 0.5)'), [235, 235, 235]);
  assert.equal(parseRgb('color(srgb 1 1 1)'), null);
  assert.equal(mix([255, 255, 255], [0, 0, 0], 0.5), '#808080');
  const dark = mermaidTheme({ ink: [235, 235, 235], background: [23, 23, 23], font: 'system-ui', light: false });
  assert.equal(dark.theme, 'base');
  assert.equal(dark.themeVariables.textColor, '#ebebeb');
  assert.equal(dark.themeVariables.background, '#171717');
  assert.equal(dark.themeVariables.darkMode, true);
  assert.equal(dark.themeVariables.fontFamily, 'system-ui');
  // Every colour is a grey of the app's ink over its background: no hue sneaks in.
  const greys = (values: Record<string, unknown>, path = '') => {
    for (const [key, value] of Object.entries(values)) {
      if (value && typeof value === 'object') greys(value as Record<string, unknown>, `${path}${key}.`);
      else if (typeof value === 'string') for (const colour of value.match(/#[0-9a-f]{6}/gi) ?? []) assert.match(colour, /^#(..)\1\1$/, `${path}${key}`);
    }
  };
  greys(dark.themeVariables);
  greys(dark.sankey);
  assert.equal(String((dark.themeVariables.xyChart as Record<string, string>).plotColorPalette).split(',').length, 6);
  assert.match(dark.themeCSS, /087ebf/);
  const light = mermaidTheme({ ink: [46, 46, 46], background: [247, 247, 247], font: 'system-ui', light: true });
  assert.equal(light.themeVariables.darkMode, false);
  assert.equal(light.themeVariables.textColor, '#2e2e2e');
});

test('a colour a diagram brings in becomes the theme grey of the same lightness', async () => {
  const { hasHue, themeGrey } = await import('../web/mermaidTheme.ts');
  const dark = { ink: [235, 235, 235] as [number, number, number], background: [23, 23, 23] as [number, number, number], light: false };
  const light = { ink: [46, 46, 46] as [number, number, number], background: [247, 247, 247] as [number, number, number], light: true };
  assert.equal(hasHue([8, 126, 191]), true);
  assert.equal(hasHue([120, 121, 125]), false);
  for (const colour of [[255, 0, 0], [8, 126, 191], [124, 252, 0]] as [number, number, number][]) {
    assert.match(themeGrey(colour, dark), /^#(..)\1\1$/);
    assert.match(themeGrey(colour, light), /^#(..)\1\1$/);
  }
  // Brighter colours stay brighter: on dark they move toward the ink, on light toward the background.
  const value = (hex: string) => parseInt(hex.slice(1, 3), 16);
  assert.ok(value(themeGrey([255, 255, 0], dark)) > value(themeGrey([0, 0, 128], dark)));
  assert.ok(value(themeGrey([255, 255, 0], light)) > value(themeGrey([0, 0, 128], light)));
});

test('services drawn on top of each other are found; neighbours that only touch are not', async () => {
  const { overlappingPairs, mermaidTheme } = await import('../web/mermaidTheme.ts');
  const box = (id: string, x: number, y: number) => ({ id, x, y, width: 80, height: 100 });
  assert.deepEqual(overlappingPairs([box('App page', 100, 100), box('Server', 100, 100), box('Main', 300, 100)]), [['App page', 'Server']]);
  assert.deepEqual(overlappingPairs([box('a', 0, 0), box('b', 80, 0), box('c', 70, 90)]), [], 'edges touching or a corner clipped are fine');
  // Labels get a halo in the background colour, so an edge under them stays readable.
  const theme = mermaidTheme({ ink: [235, 235, 235], background: [23, 23, 23], font: 'x', light: false });
  assert.match(theme.themeCSS, /\.architecture-service text[^{]*\{ paint-order: stroke fill; stroke: #171717/);
});
