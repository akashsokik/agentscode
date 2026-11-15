import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { STATUS_MARKS, statusTone } from '../web/ui/statusMarks.ts';

const web = new URL('../web/', import.meta.url);
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(path.join(dir, entry.name)) : /\.(tsx?|css)$/.test(entry.name) ? [path.join(dir, entry.name)] : []);
}

test('ACH-57: StatusMark is the sole working spinner; no copied glyph, frame loop, pulsing dot or CSS spinner', () => {
  const failures: string[] = [];
  for (const file of sources(web.pathname)) {
    const name = path.relative(web.pathname, file);
    const source = fs.readFileSync(file, 'utf8');
    if (['ui/StatusMark.tsx', 'ui/statusMarks.ts', 'mono/icons.tsx'].includes(name)) continue;
    const variants = /TerminalSpinner|DotSpinner|WorkingDot|tile-spinner|zen-tool-spin|zen-spin|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\banimate-(?:spin|pulse)\b|\b(?:Loader|LoaderCircle|Loading\w*Icon)\b|(?:function|const)\s+\w*Spinner\b/;
    if (variants.test(source)) failures.push(name);
  }
  assert.deepEqual(failures, [], 'working and loading marks must render through StatusMark pending');
  assert.equal(STATUS_MARKS.pending.glyph, 'LoaderCircle');
  assert.match(statusTone('pending'), /animate-spin/);
  assert.match(statusTone('pending'), /motion-reduce:animate-none/);
  assert.match(statusTone('pending', true), /motion-reduce:animate-none/);
});

test('ACH-57: a running phase keeps the pending glyph when motion is reduced', () => {
  const tile = fs.readFileSync(new URL('../web/mono/ActivityTile.tsx', import.meta.url), 'utf8');
  const transcript = fs.readFileSync(new URL('../web/panes/Transcript.tsx', import.meta.url), 'utf8');
  assert.match(tile, /spinning \? <StatusMark state="pending"/);
  assert.match(transcript, /spinning=\{active\}/);
  assert.doesNotMatch(transcript, /spinning=\{active && !reducedMotion\(\)\}/);
});
