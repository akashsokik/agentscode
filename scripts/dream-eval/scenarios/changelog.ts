import type { Scenario } from '../scenario.ts';
import { fail, json, pass } from './util.ts';

/** The bullet lines under "## Unreleased". */
function unreleased(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^##\s+Unreleased\b/i.test(line.trim()));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^##\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).filter(line => /^\s*[-*]\s+\S/.test(line));
}

/**
 * A process rule: every change gets a changelog line. The seed has no CHANGELOG.md, so its presence
 * does not prompt the agent; session 2 has to create it from memory.
 */
export const changelog: Scenario = {
  id: 'changelog',
  title: 'Update the changelog',
  kind: 'explicit',
  lessons: [{
    id: 'changelog',
    text: "Every change gets a line under '## Unreleased' in CHANGELOG.md; create the file if it is missing.",
    knows: /changelog/i,
    evidence: 'CHANGELOG.md',
  }],
  seed: {
    'package.json': json({ name: 'util-kit', version: '0.1.0', type: 'module' }),
    'src/util.js': "export function isBlank(s) {\n  return s.trim() === '';\n}\n",
  },
  session1: [
    'Add isEmail(s) to src/util.js: a simple check for one @ with a dot somewhere after it.',
    "You forgot the changelog. Every change in this repo gets a line under '## Unreleased' in CHANGELOG.md; create the file if it is missing.",
    'Also add isUrl(s) to src/util.js: true for strings starting with http:// or https://.',
  ],
  session2: 'Add truncate(s, n) to src/util.js: it shortens s to at most n characters, ending with an ellipsis when it cut something.',
  fakeRemembers: true,

  score(view) {
    const text = view.read('CHANGELOG.md');
    if (text === null) return fail('no CHANGELOG.md');
    const lines = unreleased(text);
    return lines.length
      ? pass(`Unreleased has: ${lines.map(line => line.trim()).join(' | ')}`)
      : fail('CHANGELOG.md has no line under ## Unreleased');
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const util = turn.read('src/util.js') ?? '';
    const added = turn.session === 2 ? 'truncate' : ['isEmail', null, 'isUrl'][turn.step];
    if (added) turn.write('src/util.js', `${util}\nexport function ${added}(s) {\n  return Boolean(s);\n}\n`);
    if (follow) {
      const current = turn.read('CHANGELOG.md') ?? '# Changelog\n\n## Unreleased\n';
      turn.write('CHANGELOG.md', current.replace('## Unreleased\n', `## Unreleased\n\n- Added ${added ?? 'isEmail'}.\n`));
    }
    return added ? `Added ${added}.` : 'Added the changelog line.';
  },
};
