import type { Scenario } from '../scenario.ts';
import { clip, fail, inconclusive, json, pass } from './util.ts';

/** Code lines (not blank, not comments) that end a statement with a semicolon. `for (;;)` heads are fine. */
function semicolonLines(text: string): string[] {
  return text.split('\n').filter(line => {
    const t = line.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && /;\s*(\/\/.*)?$/.test(t) && !/^for\s*\(/.test(t);
  });
}

function codeLines(text: string): string[] {
  return text.split('\n').filter(line => {
    const t = line.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

/**
 * An implicit fix: the user strips the semicolons from the agent's file by hand and only says they tidied
 * it. No rule is ever stated, so the agent has to notice it, and a dream has to infer it from what the
 * agent said about the edit.
 */
export const implicitFix: Scenario = {
  id: 'implicit-fix',
  title: 'Match a style the user fixed by hand (no semicolons)',
  kind: 'hard',
  lessons: [{
    id: 'no-semicolons',
    text: 'The user writes JavaScript without semicolons: they removed them from src/slug.js by hand.',
    knows: /semicolon/i,
    evidence: 'tidied up src/slug.js',
  }],
  seed: {
    'package.json': json({ name: 'slugger', version: '0.1.0', type: 'module' }),
    'README.md': '# slugger\n',
  },
  session1: [
    'Create src/slug.js exporting slugify(s): lower-case it, trim it, and turn each run of non-alphanumeric characters into a single dash.',
    'I tidied up src/slug.js by hand before committing. Next, add unslugify(s) to the same file, which turns dashes back into spaces.',
    'Add a test for both functions in test/slug.test.js using node:test, and run it.',
  ],
  // The user's hand edit after the first turn: every statement-ending semicolon removed.
  userEdits: {
    0: files => {
      const text = files.read('src/slug.js');
      if (text !== null) files.write('src/slug.js', text.split('\n').map(line => line.replace(/;(\s*(\/\/.*)?)$/, '$1')).join('\n'));
    },
  },
  session2: 'Create src/case.js exporting camelCase(s) and kebabCase(s), which convert words separated by spaces, dashes or underscores.',
  fakeRemembers: false,

  score(view) {
    const text = view.read('src/case.js');
    if (text === null) return fail('src/case.js was not created');
    if (codeLines(text).length < 3) return inconclusive('src/case.js has too little code to judge');
    const semis = semicolonLines(text);
    return semis.length
      ? fail(`${semis.length} lines end with a semicolon, e.g. "${clip(semis[0].trim(), 60)}"`)
      : pass(`no semicolons in ${codeLines(text).length} code lines`);
  },

  fake(turn) {
    // In session 1 it sees the user's edit from the second turn on; in session 2 only memory can say.
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const end = follow ? '' : ';';
    if (turn.session === 1) {
      const lines = [
        'export function slugify(s) {',
        `  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')${end}`,
        '}',
      ];
      if (turn.step >= 1) lines.push('', 'export function unslugify(s) {', `  return s.replace(/-/g, ' ')${end}`, '}');
      if (turn.step === 0) turn.write('src/slug.js', `${lines.join('\n')}\n`);
      if (turn.step === 1) turn.write('src/slug.js', `${lines.join('\n')}\n`);
      if (turn.step === 2) turn.write('test/slug.test.js', "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { slugify } from '../src/slug.js'\n\ntest('slugify', () => {\n  assert.equal(slugify('A b'), 'a-b')\n})\n");
      return [
        'Added slugify in src/slug.js.',
        'Added unslugify, matching your edit: no semicolons.',
        'Added the tests; they pass.',
      ][turn.step];
    }
    turn.write('src/case.js', [
      'const words = s => s.split(/[\\s_-]+/).filter(Boolean)',
      '',
      'export function camelCase(s) {',
      `  return words(s).map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase()).join('')${end}`,
      '}',
      '',
      'export function kebabCase(s) {',
      `  return words(s).map(w => w.toLowerCase()).join('-')${end}`,
      '}',
      '',
    ].join('\n'));
    return 'Added camelCase and kebabCase.';
  },
};
