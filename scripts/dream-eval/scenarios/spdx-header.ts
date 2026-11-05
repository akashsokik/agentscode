import type { Scenario } from '../scenario.ts';
import { addedSources, fail, json, pass } from './util.ts';

const HEADER = '// SPDX-License-Identifier: Apache-2.0';
const HEADER_LINE = /^\/\/\s*SPDX-License-Identifier:\s*Apache-2\.0\s*$/;

/** A convention for new files only; nothing in the seed (no license field either) gives it away. */
export const spdxHeader: Scenario = {
  id: 'spdx-header',
  title: 'License header on new files',
  kind: 'explicit',
  lessons: [{
    id: 'spdx',
    text: `Every new source file starts with the line \`${HEADER}\`.`,
    knows: /SPDX-License-Identifier/,
    evidence: 'SPDX-License-Identifier',
  }],
  seed: {
    'package.json': json({ name: 'greeter', version: '0.1.0', type: 'module' }),
    'src/index.js': "export const VERSION = '0.1.0';\n",
  },
  session1: [
    "Create src/greet.js exporting greet(name), which returns 'Hello, <name>!'.",
    `We are adding license headers as files are created: every new source file in this repo must start with the line \`${HEADER}\`. Add it to src/greet.js, and do this for every new file from now on.`,
    "Add src/shout.js exporting shout(s), which upper-cases s and adds '!'.",
  ],
  session2: "Create src/farewell.js exporting farewell(name), which returns 'Goodbye, <name>.'.",
  fakeRemembers: true,

  score(view) {
    const files = addedSources(view);
    if (!files.length) return fail('no new source file was created');
    const missing = files.filter(file => {
      const first = (view.read(file) ?? '').split('\n').find(line => line.trim());
      return !first || !HEADER_LINE.test(first.trim());
    });
    return missing.length
      ? fail(`missing the header: ${missing.join(', ')}`)
      : pass(`header on ${files.join(', ')}`);
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const header = follow ? `${HEADER}\n` : '';
    if (turn.session === 1) {
      if (turn.step <= 1) turn.write('src/greet.js', `${header}export function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n`);
      if (turn.step === 2) turn.write('src/shout.js', `${header}export function shout(s) {\n  return s.toUpperCase() + '!';\n}\n`);
      return ['Added greet.', 'Added the license header to src/greet.js.', 'Added shout.'][turn.step];
    }
    turn.write('src/farewell.js', `${header}export function farewell(name) {\n  return \`Goodbye, \${name}.\`;\n}\n`);
    return 'Added farewell.';
  },
};
