import type { Scenario } from '../scenario.ts';
import { fail, inconclusive, json, pass } from './util.ts';

/** String literals passed straight to an Error constructor. */
function errorMessages(text: string): string[] {
  return [...text.matchAll(/new\s+\w*Error\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(match => match[2]);
}

/**
 * A preference said once, in passing, inside a request for something else; it is never repeated or
 * corrected. Session 2 passes when every error message in the new module starts with its name in brackets.
 */
export const passingPreference: Scenario = {
  id: 'passing-preference',
  title: 'A preference mentioned once in passing',
  kind: 'hard',
  lessons: [{
    id: 'error-prefix',
    text: "Error messages start with the module name in brackets, like '[parser] missing ='.",
    knows: /module name in brackets/i,
    evidence: 'module name in brackets',
  }],
  seed: {
    'package.json': json({ name: 'kvparse', version: '0.1.0', type: 'module' }),
  },
  session1: [
    "Create src/parser.js exporting parseKeyValue(line), which parses 'key=value' into { key, value } and throws when there is no '='.",
    "Next, add parseLines(text), which runs parseKeyValue on every non-empty line. By the way, I like error messages to start with the module name in brackets, like '[parser] missing ='.",
    'Add tests for both in test/parser.test.js using node:test, and run them.',
  ],
  session2: "Create src/duration.js exporting parseDuration(s) for strings like '5m', '2h' or '30s', returning seconds and throwing on anything else.",
  fakeRemembers: false,

  score(view) {
    const text = view.read('src/duration.js');
    if (text === null) return fail('src/duration.js was not created');
    const messages = errorMessages(text);
    if (!messages.length) return inconclusive('no literal error message in src/duration.js to judge');
    const bad = messages.filter(m => !/^\[(?:src\/)?duration(?:\.js)?\]/.test(m));
    return bad.length
      ? fail(`${bad.length} of ${messages.length} error messages lack "[duration]": "${bad[0]}"`)
      : pass(`all ${messages.length} error messages start with [duration]: "${messages[0]}"`);
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const prefix = (module: string) => follow ? `[${module}] ` : '';
    if (turn.session === 1) {
      const lines = [
        'export function parseKeyValue(line) {',
        "  const at = line.indexOf('=')",
        `  if (at < 0) throw new Error('${prefix('parser')}missing =')`,
        '  return { key: line.slice(0, at), value: line.slice(at + 1) }',
        '}',
      ];
      if (turn.step >= 1) lines.push('', 'export function parseLines(text) {', '  return text.split(\'\\n\').filter(Boolean).map(parseKeyValue)', '}');
      if (turn.step <= 1) turn.write('src/parser.js', `${lines.join('\n')}\n`);
      if (turn.step === 2) turn.write('test/parser.test.js', "import test from 'node:test'\n\ntest('parser', () => {})\n");
      return ['Added parseKeyValue.', 'Added parseLines, and prefixed the error messages with [parser].', 'Added the tests; they pass.'][turn.step];
    }
    turn.write('src/duration.js', [
      'const UNITS = { s: 1, m: 60, h: 3600 }',
      '',
      'export function parseDuration(s) {',
      '  const match = /^(\\d+)([smh])$/.exec(s)',
      `  if (!match) throw new Error('${prefix('duration')}invalid duration: ' + s)`,
      '  return Number(match[1]) * UNITS[match[2]]',
      '}',
      '',
    ].join('\n'));
    return 'Added parseDuration.';
  },
};
