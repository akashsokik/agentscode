import type { Scenario } from '../scenario.ts';
import { fail, json, pass } from './util.ts';

/** "Files changed:" as a heading or label, with the list after it or on the same line. */
const LABEL = /^[\s#>*_-]*\**files changed\**\s*(?::\**\s*(.*))?$/i;

/** A preference about replies, scored on the final message rather than on files. */
export const filesChanged: Scenario = {
  id: 'files-changed',
  title: 'End replies with "Files changed:"',
  kind: 'explicit',
  lessons: [{
    id: 'files-changed',
    text: "End every reply with a 'Files changed:' line, then each file touched, one per line as '- path'.",
    knows: /files changed:?/i,
    evidence: 'Files changed:',
  }],
  seed: {
    'package.json': json({ name: 'colors', version: '0.1.0', type: 'module' }),
    'src/color.js': [
      'export function hexToRgb(hex) {',
      "  const n = parseInt(hex.replace('#', ''), 16);",
      '  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };',
      '}',
      '',
    ].join('\n'),
  },
  session1: [
    'Add rgbToHex(r, g, b) to src/color.js.',
    "Thanks. One preference for every reply from now on: end it with a line 'Files changed:' followed by each file you touched, one per line as '- path'.",
    'Make hexToRgb accept 3-digit hex like #abc too.',
  ],
  session2: 'Add lighten(hex, amount) to src/color.js: it lightens a hex color by an amount from 0 to 1.',
  fakeRemembers: true,

  score(view) {
    const reply = view.finalReply;
    if (!reply.trim()) return fail('no final reply');
    const lines = reply.split('\n');
    const at = lines.findIndex(line => LABEL.test(line));
    if (at < 0) return fail('the final reply has no "Files changed:" line');
    // The list may follow on the same line ("Files changed: src/color.js") or below it.
    const after = [LABEL.exec(lines[at])![1] ?? '', ...lines.slice(at + 1)];
    const named = after.find(line => /color\.js/.test(line));
    return named !== undefined
      ? pass(`final reply has "${lines[at].trim()}" listing "${named.trim() || lines[at].trim()}"`)
      : fail(`"${lines[at].trim()}" does not list src/color.js`);
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    // Inline on purpose: the scorer must accept the list on the label's own line.
    const footer = follow ? '\n\nFiles changed: src/color.js' : '';
    const source = turn.read('src/color.js') ?? '';
    if (turn.session === 1) {
      if (turn.step === 0) turn.write('src/color.js', `${source}\nexport function rgbToHex(r, g, b) {\n  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');\n}\n`);
      return `${['Added rgbToHex.', 'Noted.', 'hexToRgb now takes 3-digit hex.'][turn.step]}${footer}`;
    }
    turn.write('src/color.js', `${source}\nexport function lighten(hex, amount) {\n  return hex;\n}\n`);
    return `Added lighten.${footer}`;
  },
};
