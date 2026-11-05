import type { Scenario } from '../scenario.ts';
import { fail, json, pass } from './util.ts';

const LOGGER = 'src/util/logger.js';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:c|m)?js$/;

/** Exported functions (declarations and arrow constants) without a JSDoc block right above them that has @param and @returns. */
function undocumented(text: string): string[] {
  const lines = text.split('\n');
  const missing: string[] = [];
  lines.forEach((line, i) => {
    const name = line.match(/^export\s+(?:async\s+)?function\s+(\w+)|^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|\w+\s*=>)/);
    if (!name) return;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim()) j--;
    let doc = '';
    if (j >= 0 && lines[j].trim().endsWith('*/')) {
      let k = j;
      while (k >= 0 && !lines[k].includes('/**')) k--;
      doc = k >= 0 ? lines.slice(k, j + 1).join('\n') : '';
    }
    if (!/@param\b/.test(doc) || !/@returns?\b/.test(doc)) missing.push(name[1] ?? name[2]);
  });
  return missing;
}

/**
 * Several lessons in one long session, each said once among other requests: kebab-case file names,
 * logging through the project's log() helper, and a JSDoc block on every export. Session 2 passes only
 * when all three hold; the detail says which did.
 */
export const multiLesson: Scenario = {
  id: 'multi-lesson',
  title: 'Three conventions from one long session',
  kind: 'hard',
  lessons: [
    {
      id: 'kebab-files',
      text: 'Name every file in kebab-case (format-time.js, not formatTime.js).',
      knows: /kebab/i,
      evidence: 'kebab-case',
    },
    {
      id: 'logger',
      text: `Warn and log through log() from ${LOGGER}; never call console.log or console.warn directly.`,
      knows: /util\/logger\.js|never call console/i,
      evidence: LOGGER,
    },
    {
      id: 'jsdoc',
      text: 'Every exported function gets a JSDoc block with @param and @returns.',
      knows: /JSDoc/i,
      evidence: 'JSDoc',
    },
  ],
  seed: {
    'package.json': json({ name: 'timekit', version: '0.1.0', type: 'module' }),
    [LOGGER]: 'export function log(level, message) {\n  process.stderr.write(`[${level}] ${message}\\n`);\n}\n',
  },
  session1: [
    "Add a helper in src/ that formats a number of seconds as 'mm:ss'.",
    `Rename the file to kebab-case, we name every file like that here (format-time.js, not formatTime.js). Also, when the input is negative, warn through our log() helper in ${LOGGER}; we never call console.log or console.warn directly.`,
    'Every exported function here gets a JSDoc block with @param and @returns. Please add one.',
    'Add a test for it in test/ using node:test, and run it.',
  ],
  session2: "Add a helper in src/ that formats a byte count as a human-readable string like '1.5 KB', and warn when the input is negative.",
  fakeRemembers: false,

  score(view) {
    const files = view.added.filter(file => /^src\/[^/]+\.(?:c|m)?js$/.test(file));
    if (!files.length) return fail('no new file in src/');
    const checks: string[] = [];
    let ok = 0;
    const badNames = files.filter(file => !KEBAB.test(file.slice(4)));
    if (badNames.length) checks.push(`name not kebab-case: ${badNames.join(', ')}`); else { ok++; checks.push(`kebab-case: ${files.join(', ')}`); }
    const text = files.map(file => view.read(file) ?? '').join('\n');
    const consoleLine = text.split('\n').find(line => /\bconsole\.(log|warn|error|info)\s*\(/.test(line));
    if (consoleLine) checks.push(`calls console: ${consoleLine.trim()}`);
    else if (!/util\/logger(\.js)?['"]/.test(text) || !/\blog\s*\(/.test(text)) checks.push('does not warn through log()');
    else { ok++; checks.push('warns through log()'); }
    const missing = files.flatMap(file => undocumented(view.read(file) ?? ''));
    if (missing.length) checks.push(`no JSDoc on: ${missing.join(', ')}`); else { ok++; checks.push('JSDoc on every export'); }
    const detail = `${ok}/3 lessons: ${checks.join('; ')}`;
    return ok === 3 ? pass(detail) : fail(detail);
  },

  fake(turn) {
    const knows = (id: string) => turn.session === 1 ? false : turn.knows(id);
    if (turn.session === 1) {
      const kebab = turn.step >= 1;
      const logger = turn.step >= 1;
      const jsdoc = turn.step >= 2;
      const file = kebab ? 'src/format-time.js' : 'src/formatTime.js';
      if (kebab) turn.remove('src/formatTime.js');
      turn.write(file, [
        logger ? "import { log } from './util/logger.js'\n" : '',
        jsdoc ? '/**\n * Formats seconds as mm:ss.\n * @param {number} s\n * @returns {string}\n */' : '',
        'export function formatTime(s) {',
        `  if (s < 0) ${logger ? "log('warn', 'negative input')" : "console.warn('negative input')"}`,
        "  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`",
        '}',
        '',
      ].filter(Boolean).join('\n'));
      if (turn.step === 3) turn.write('test/format-time.test.js', "import test from 'node:test'\n\ntest('formatTime', () => {})\n");
      return ['Added formatTime.', 'Renamed to src/format-time.js and switched to log().', 'Added a JSDoc block.', 'Added a test; it passes.'][turn.step];
    }
    const file = knows('kebab-files') ? 'src/format-bytes.js' : 'src/formatBytes.js';
    turn.write(file, [
      knows('logger') ? "import { log } from './util/logger.js'\n" : '',
      knows('jsdoc') ? '/**\n * Formats a byte count.\n * @param {number} n\n * @returns {string}\n */' : '',
      'export function formatBytes(n) {',
      `  if (n < 0) ${knows('logger') ? "log('warn', 'negative input')" : "console.warn('negative input')"}`,
      "  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`",
      '}',
      '',
    ].filter(Boolean).join('\n'));
    return `Added formatBytes in ${file}.`;
  },
};
