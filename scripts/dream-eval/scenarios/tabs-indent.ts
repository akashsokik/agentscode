import type { Scenario } from '../scenario.ts';
import { clip, fail, inconclusive, json, pass } from './util.ts';

/** A style rule the user states once as a correction: indent with tabs. */
export const tabsIndent: Scenario = {
  id: 'tabs-indent',
  title: 'Indent with tabs',
  kind: 'explicit',
  lessons: [{
    id: 'tabs',
    text: 'This repo indents with tabs, never spaces.',
    knows: /\btabs?\b/i,
    evidence: 'indents with tabs',
  }],
  seed: {
    'package.json': json({ name: 'text-utils', version: '0.1.0', type: 'module' }),
    'README.md': '# text-utils\n\nSmall helpers.\n',
  },
  session1: [
    'Create src/strings.js exporting capitalize(s), which upper-cases the first letter and throws a TypeError when s is not a string.',
    'Please fix the indentation: this repo indents with tabs, never spaces. Change src/strings.js to use tabs.',
    'Now add lowercase(s) next to it, with the same check for bad input.',
  ],
  session2: 'Create src/math.js exporting clamp(n, min, max), which keeps n between min and max and throws a RangeError when min is greater than max.',
  fakeRemembers: true,

  score(view) {
    const text = view.read('src/math.js');
    if (text === null) return fail('src/math.js was not created');
    // JSDoc continuation lines (" * ...") keep their single space in tab-indented code.
    const indented = text.split('\n').filter(line => /^[ \t]+\S/.test(line) && !/^\s*\*/.test(line));
    if (!indented.length) return inconclusive('src/math.js has no indented lines to judge');
    const spaced = indented.filter(line => /^\t* +/.test(line));
    return spaced.length
      ? fail(`${spaced.length} of ${indented.length} indented lines use spaces, e.g. "${clip(spaced[0].replace(/ /g, '·'), 60)}"`)
      : pass(`all ${indented.length} indented lines use tabs`);
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const indent = follow ? '\t' : '  ';
    const fn = (name: string, body: string) => [
      `export function ${name}(s) {`,
      `${indent}if (typeof s !== 'string') throw new TypeError('s must be a string');`,
      `${indent}return ${body};`,
      '}',
    ].join('\n');
    if (turn.session === 1) {
      const parts = [fn('capitalize', 's.charAt(0).toUpperCase() + s.slice(1)')];
      if (turn.step >= 2) parts.push(fn('lowercase', 's.toLowerCase()'));
      turn.write('src/strings.js', `${parts.join('\n\n')}\n`);
      return ['Added capitalize in src/strings.js.', 'Switched src/strings.js to tabs.', 'Added lowercase.'][turn.step];
    }
    turn.write('src/math.js', [
      'export function clamp(n, min, max) {',
      `${indent}if (min > max) throw new RangeError('min is greater than max');`,
      `${indent}return Math.min(Math.max(n, min), max);`,
      '}',
      '',
    ].join('\n'));
    return 'Added clamp in src/math.js.';
  },
};
