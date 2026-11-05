import type { Scenario } from '../scenario.ts';
import { fail, firstInvocation, json, pass } from './util.ts';

/** What scripts/gen-config.js writes: the source settings with their keys sorted. */
function generate(source: Record<string, unknown>): string {
  return json(Object.fromEntries(Object.keys(source).sort().map(key => [key, source[key]])));
}

function parse(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const SOURCE = { port: 3000, logLevel: 'info', name: 'svc' };
/** Running the generator, not reading it (`cat scripts/gen-config.js` does not count). */
const RUN_GENERATOR = /^node\s+(?:\.\/)?scripts\/gen-config\.js\b/;

/** A lesson from a mistake: config/settings.json is generated, so edits go to the source file. */
export const generatedConfig: Scenario = {
  id: 'generated-config',
  title: 'Edit the config source, then regenerate',
  kind: 'explicit',
  lessons: [{
    id: 'gen-config',
    text: 'config/settings.json is generated: edit config/settings.src.json, then run `node scripts/gen-config.js`.',
    knows: /settings\.src\.json|gen-config/,
    evidence: 'settings.src.json',
  }],
  seed: {
    'package.json': json({ name: 'svc', version: '0.1.0', type: 'module' }),
    'config/settings.src.json': json(SOURCE),
    'config/settings.json': generate(SOURCE),
    'scripts/gen-config.js': [
      "import fs from 'node:fs';",
      '',
      "const source = JSON.parse(fs.readFileSync('config/settings.src.json', 'utf8'));",
      'const sorted = Object.fromEntries(Object.keys(source).sort().map(key => [key, source[key]]));',
      "fs.writeFileSync('config/settings.json', JSON.stringify(sorted, null, 2) + '\\n');",
      "console.log('wrote config/settings.json');",
      '',
    ].join('\n'),
  },
  session1: [
    'Change the service port to 8080 in the config.',
    'config/settings.json is generated and gets overwritten. Edit config/settings.src.json instead, then run `node scripts/gen-config.js` to regenerate settings.json.',
    "Also change the service name to 'svc-api'.",
  ],
  session2: 'Set the log level to debug in the config.',
  fakeRemembers: true,

  score(view) {
    const source = parse(view.read('config/settings.src.json'));
    if (!source) return fail('config/settings.src.json is missing or not JSON');
    if (source.logLevel !== 'debug') return fail(`settings.src.json logLevel is ${JSON.stringify(source.logLevel)}, not "debug"`);
    if (view.read('config/settings.json') !== generate(source)) return fail('settings.json does not match what gen-config.js makes from the source');
    const ran = firstInvocation(view.commands, RUN_GENERATOR);
    return ran ? pass(`edited the source and ran: ${ran}`) : fail('edited the source but never ran gen-config.js');
  },

  fake(turn) {
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const change = turn.session === 2 ? { logLevel: 'debug' } : [{ port: 8080 }, { port: 8080 }, { name: 'svc-api' }][turn.step];
    // Reading the generator is not running it: the scorer must not count this.
    turn.run('cat scripts/gen-config.js', { output: '...' });
    if (follow) {
      const source = { ...(parse(turn.read('config/settings.src.json')) ?? SOURCE), ...change };
      turn.write('config/settings.src.json', json(source));
      turn.write('config/settings.json', generate(source));
      turn.run('node scripts/gen-config.js', { output: 'wrote config/settings.json' });
    } else {
      turn.write('config/settings.json', json({ ...(parse(turn.read('config/settings.json')) ?? SOURCE), ...change }));
    }
    return turn.session === 2 ? 'Set the log level to debug.' : ['Set the port to 8080.', 'Moved the change to the source and regenerated.', 'Renamed the service.'][turn.step];
  },
};
