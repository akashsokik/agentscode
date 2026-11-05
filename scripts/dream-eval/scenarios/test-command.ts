import type { Scenario } from '../scenario.ts';
import { fail, firstInvocation, invocations, json, list, pass, program } from './util.ts';

/** `node --test` as the program run, with any arguments. */
const NODE_TEST = /^node\b[^\n]*\s--test\b/;
/** Running the stale runner: npm/pnpm/yarn test, or jest itself (not a mention of jest, like `grep jest`). */
const WRONG_RUNNER = /^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|t)\b|(?:npx\s+)?jest\b)/;

/** A lesson from a failure: the package.json test script is stale, so `npm test` fails. */
export const testCommand: Scenario = {
  id: 'test-command',
  title: 'Run tests with node --test',
  kind: 'explicit',
  lessons: [{
    id: 'node-test',
    text: 'npm test is broken here (stale jest script, jest not installed); always run the tests with `node --test` directly.',
    knows: /node\s+--test/,
    evidence: 'Always run the tests with',
  }],
  seed: {
    'package.json': json({ name: 'stats', version: '0.1.0', type: 'module', scripts: { test: 'jest' } }),
    'src/sum.js': 'export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 1);\n}\n',
    'test/sum.test.js': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { sum } from '../src/sum.js';",
      '',
      "test('sum adds numbers', () => {",
      '  assert.equal(sum([1, 2, 3]), 6);',
      '  assert.equal(sum([]), 0);',
      '});',
      '',
    ].join('\n'),
  },
  session1: [
    'The tests in test/ fail. Fix the bug in src/sum.js and run the tests to confirm.',
    "Don't use npm test in this repo: the jest script in package.json is stale and jest is not installed. Always run the tests with `node --test` directly.",
    'Add a test for sum with negative numbers and run the tests again.',
  ],
  session2: 'Add mean(xs) to a new file src/stats.js (it returns 0 for an empty list), add a test for it in test/, and run the tests.',
  fakeRemembers: true,

  score(view) {
    const wrong = invocations(view.commands).filter(inv => WRONG_RUNNER.test(program(inv)));
    if (wrong.length) return fail(`ran the stale runner: ${list(wrong)}`);
    const ran = firstInvocation(view.commands, NODE_TEST);
    return ran ? pass(`ran: ${ran}`) : fail(`never ran node --test (commands: ${list(view.commands)})`);
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    if (!follow) turn.run('npm test', { ok: false, output: 'sh: jest: command not found' });
    if (turn.session === 1) {
      if (turn.step === 0) turn.write('src/sum.js', 'export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n');
      turn.run('node --test', { output: '# pass 1' });
      return ['Fixed the initial value in sum; the tests pass.', 'Understood; ran node --test, and the tests pass.', 'Added a negative-number test; node --test passes.'][turn.step];
    }
    turn.write('src/stats.js', 'export function mean(xs) {\n  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;\n}\n');
    turn.write('test/stats.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean } from '../src/stats.js';\n\ntest('mean', () => {\n  assert.equal(mean([2, 4]), 3);\n  assert.equal(mean([]), 0);\n});\n");
    // Checking the scripts is not running jest: the scorer must not fail this.
    turn.run('grep -n jest package.json', { output: '"test": "jest"' });
    turn.run("cat > test/stats.test.js <<'EOF'\n...\nEOF\nnode --test test/", { output: '# pass 2' });
    return 'Added mean with a test; the tests pass.';
  },
};
