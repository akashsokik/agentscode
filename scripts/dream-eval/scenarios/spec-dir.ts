import type { Scenario } from '../scenario.ts';
import { fail, json, pass, SOURCE } from './util.ts';

/** A layout rule: tests live in spec/ as <name>.spec.js. */
export const specDir: Scenario = {
  id: 'spec-dir',
  title: 'Tests go in spec/',
  kind: 'explicit',
  lessons: [{
    id: 'spec-dir',
    text: 'Tests live in the spec/ folder and are named <name>.spec.js.',
    knows: /\bspec\/|\.spec\.js\b|\bspec (folder|dir)/i,
    evidence: 'spec/ folder',
  }],
  seed: {
    'package.json': json({ name: 'slugs', version: '0.1.0', type: 'module' }),
    'src/slug.js': "export function slugify(s) {\n  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n",
  },
  session1: [
    'Write tests for slugify in src/slug.js using node:test.',
    'In this repo tests live in the spec/ folder and are named <name>.spec.js. Please move your test there.',
    'Add a test case for strings with leading and trailing spaces.',
  ],
  session2: 'Add wordCount(s) to a new file src/words.js and write tests for it using node:test.',
  fakeRemembers: true,

  score(view) {
    const tests = view.added.filter(file => SOURCE.test(file) && (/(^|\/)(spec|tests?|__tests__)\//.test(file) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(file) || /node:test/.test(view.read(file) ?? '')));
    if (!tests.length) return fail('no test file was added');
    const misplaced = tests.filter(file => !/^spec\/.+\.spec\.js$/.test(file));
    return misplaced.length
      ? fail(`tests outside spec/*.spec.js: ${misplaced.join(', ')}`)
      : pass(`tests at ${tests.join(', ')}`);
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const test = (fn: string, file: string) =>
      `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fn} } from '../src/${file}';\n\ntest('${fn}', () => {\n  assert.ok(${fn});\n});\n`;
    if (turn.session === 1) {
      if (follow) turn.remove('test/slug.test.js');
      turn.write(follow ? 'spec/slug.spec.js' : 'test/slug.test.js', test('slugify', 'slug.js'));
      return ['Added tests for slugify.', 'Moved the test to spec/slug.spec.js.', 'Added the spaces case.'][turn.step];
    }
    turn.write('src/words.js', 'export function wordCount(s) {\n  return s.split(/\\s+/).filter(Boolean).length;\n}\n');
    turn.write(follow ? 'spec/words.spec.js' : 'test/words.test.js', test('wordCount', 'words.js'));
    return 'Added wordCount with tests.';
  },
};
