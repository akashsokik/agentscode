import type { Scenario } from '../scenario.ts';
import { fail, invocations, json, list, pass, program } from './util.ts';

const BUILD = /^node\s+(?:\.\/)?scripts\/build\.js\b/;

/** The build runs, in order, each with whether BUILD_TARGET was set (inline, or exported earlier). */
function buildRuns(commands: string[]): { line: string; withTarget: boolean }[] {
  const runs: { line: string; withTarget: boolean }[] = [];
  let exported = false;
  for (const inv of invocations(commands)) {
    if (/^export\s+BUILD_TARGET=\S/.test(inv)) exported = true;
    if (BUILD.test(program(inv))) {
      const inline = /(^|\s)BUILD_TARGET=\S+\s/.test(inv);
      runs.push({ line: inline || !exported ? inv : `${inv} (BUILD_TARGET exported before)`, withTarget: exported || inline });
    }
  }
  return runs;
}

/**
 * A failure the agent recovers from on its own: the build fails with a vague message until
 * BUILD_TARGET=node is set, which the agent finds by reading the script. The user never mentions it;
 * they only say "Great, that works." So the lesson's only trusted trace is the agent's summary, which
 * that reply confirms. Session 2 passes when the first build already sets the variable.
 */
export const silentFailure: Scenario = {
  id: 'silent-failure',
  title: 'Remember a fix for a failure nobody pointed out',
  kind: 'hard',
  lessons: [{
    id: 'build-target',
    text: 'scripts/build.js fails with "no target configured" unless BUILD_TARGET=node is set: run BUILD_TARGET=node node scripts/build.js.',
    knows: /BUILD_TARGET/,
    evidence: 'BUILD_TARGET',
  }],
  seed: {
    'package.json': json({ name: 'infokit', version: '0.1.0', type: 'module' }),
    'scripts/build.js': [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      '',
      '// Checks that every module in src/ loads, then writes dist/manifest.json.',
      'const target = process.env.BUILD_TARGET;',
      "if (target !== 'node') {",
      "  console.error('build failed: no target configured');",
      '  process.exit(1);',
      '}',
      "const files = fs.existsSync('src') ? fs.readdirSync('src').filter(f => f.endsWith('.js')) : [];",
      'for (const file of files) await import(pathToFileURL(path.resolve(\'src\', file)).href);',
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/manifest.json', JSON.stringify({ target, files }, null, 2) + '\\n');",
      'console.log(`built ${files.length} module(s) for ${target}`);',
      '',
    ].join('\n'),
  },
  session1: [
    "Create src/info.js exporting NAME = 'infokit' and VERSION = '0.1.0', then run the build with node scripts/build.js to make sure it passes.",
    'Great, that works.',
    'Now add an AUTHOR export to src/info.js and build again.',
  ],
  session2: 'Create src/clock.js exporting now(), which returns the current time as an ISO string, then run the build (node scripts/build.js) to check it passes.',
  fakeRemembers: false,

  score(view) {
    const runs = buildRuns(view.commands);
    if (!runs.length) return fail(`never ran the build (commands: ${list(view.commands)})`);
    return runs[0].withTarget
      ? pass(`first build already set the target: ${runs[0].line}`)
      : fail(`first build ran without BUILD_TARGET: ${runs[0].line}${runs.length > 1 ? ` (then: ${runs[1].line})` : ''}`);
  },

  fake(turn) {
    // Within session 1 it keeps what it found; in session 2 only memory can tell it.
    const follow = turn.session === 1 ? turn.step >= 1 : turn.knows();
    const build = () => {
      if (!follow) {
        turn.run('node scripts/build.js', { ok: false, output: 'build failed: no target configured' });
        turn.run('cat scripts/build.js', { output: 'const target = process.env.BUILD_TARGET; ...' });
      }
      turn.run('BUILD_TARGET=node node scripts/build.js', { output: 'built 1 module(s) for node' });
    };
    if (turn.session === 1) {
      if (turn.step === 1) return 'Glad it works.';
      const info = ["export const NAME = 'infokit'", "export const VERSION = '0.1.0'"];
      if (turn.step === 2) info.push("export const AUTHOR = 'unknown'");
      turn.write('src/info.js', `${info.join('\n')}\n`);
      build();
      // The last paragraph becomes the turn summary the user's "Great, that works." confirms.
      return turn.step === 0
        ? 'Added src/info.js.\n\nThe build passes, but scripts/build.js needs BUILD_TARGET=node set or it fails with "no target configured".'
        : 'Added AUTHOR and rebuilt with BUILD_TARGET=node.';
    }
    turn.write('src/clock.js', 'export function now() {\n  return new Date().toISOString()\n}\n');
    build();
    return 'Added now() in src/clock.js; the build passes.';
  },
};
