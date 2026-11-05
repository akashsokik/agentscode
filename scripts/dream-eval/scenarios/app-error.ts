import type { Scenario } from '../scenario.ts';
import { fail, json, pass } from './util.ts';

const PLAIN_ERROR = /\bnew\s+(Range|Type|Syntax)?Error\s*\(|\bthrow\s+(Range|Type|Syntax)?Error\s*\(/;

/**
 * A codebase convention: errors are AppError from src/errors.js. The seed has to contain errors.js for
 * the rule to make sense, so an agent can find it unaided; the "none" arm measures how often it does.
 */
export const appError: Scenario = {
  id: 'app-error',
  title: 'Throw AppError',
  kind: 'explicit',
  lessons: [{
    id: 'app-error',
    text: "Throw AppError from src/errors.js with a code (like 'INVALID_AGE'), never a plain Error.",
    knows: /AppError/,
    evidence: 'throw AppError',
  }],
  seed: {
    'package.json': json({ name: 'parsers', version: '0.1.0', type: 'module' }),
    'src/errors.js': [
      'export class AppError extends Error {',
      '  constructor(code, message) {',
      '    super(message);',
      "    this.name = 'AppError';",
      '    this.code = code;',
      '  }',
      '}',
      '',
    ].join('\n'),
    'src/age.js': 'export function parseAge(s) {\n  return Number(s);\n}\n',
  },
  session1: [
    'Make parseAge in src/age.js reject anything that is not a whole number from 0 to 150 by throwing.',
    "In this codebase, throw AppError from src/errors.js with a code (like 'INVALID_AGE'), never a plain Error. Please change it.",
    'Also export parseAges(list) from src/age.js, which parses a comma-separated list with parseAge.',
  ],
  session2: 'Create src/port.js exporting parsePort(s), which returns the port as a number and throws on anything that is not a whole number from 1 to 65535.',
  fakeRemembers: true,

  score(view) {
    const text = view.read('src/port.js');
    if (text === null) return fail('src/port.js was not created');
    const plain = text.split('\n').find(line => PLAIN_ERROR.test(line));
    if (plain) return fail(`src/port.js throws a plain Error: ${plain.trim()}`);
    const line = text.split('\n').find(l => /\bnew\s+AppError\s*\(/.test(l));
    return line ? pass(`src/port.js: ${line.trim()}`) : fail('src/port.js never throws AppError');
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const error = (code: string, message: string) =>
      follow ? `new AppError('${code}', '${message}')` : `new RangeError('${message}')`;
    const imports = follow ? "import { AppError } from './errors.js';\n\n" : '';
    if (turn.session === 1) {
      const ages = turn.step >= 2 ? "\nexport function parseAges(list) {\n  return list.split(',').map(parseAge);\n}\n" : '';
      turn.write('src/age.js', `${imports}export function parseAge(s) {\n  const n = Number(s);\n  if (!Number.isInteger(n) || n < 0 || n > 150) throw ${error('INVALID_AGE', 'Not a valid age')};\n  return n;\n}\n${ages}`);
      return ['parseAge now throws on bad input.', 'parseAge now throws AppError.', 'Added parseAges.'][turn.step];
    }
    turn.write('src/port.js', `${imports}export function parsePort(s) {\n  const n = Number(s);\n  if (!Number.isInteger(n) || n < 1 || n > 65535) throw ${error('INVALID_PORT', 'Not a valid port')};\n  return n;\n}\n`);
    return 'Added parsePort.';
  },
};
