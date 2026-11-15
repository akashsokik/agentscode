import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// ACH-54 / ACH-D70: a turn header is the agent's avatar, its name and the clock ("working for 19s",
// "worked for 21s"), and when the turn landed; never the engine or harness ("OpenAI Codex (ChatGPT
// subscription)") or the model ("gpt-6-astra", "Opus 5.5"). Those stay where they are set: the
// composer's model picker and agent settings. The headers are .tsx, so they are read as source.
const read = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** A function's source, from its declaration to the next top-level declaration. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.slice(start + 1).search(/\n(?:export )?(?:function|const|\/\*\*) /);
  return source.slice(start, end < 0 ? undefined : start + 1 + end);
}
const ENGINE_OR_MODEL = /\bmodel\b|modelLabel|ENGINE_NAMES|ENGINE_LABELS|\.engine\b|models\[/;

test('the transcript turn header (agents, the SuperAgent, channel transcripts) names no engine or model', () => {
  const transcript = read('web/panes/Transcript.tsx');
  assert.doesNotMatch(fn(transcript, 'WorkFoldLine'), ENGINE_OR_MODEL);
  assert.doesNotMatch(transcript, /<WorkFoldLine[^>]*\bmodel=/, 'no caller passes a model');
  assert.doesNotMatch(transcript, /useModelName|modelLabel/, 'the helper that named the model is gone');
  assert.match(fn(transcript, 'formatWorkingDuration'), /worked|working/, 'the clock stays');
});

test('channel posts and teammate messages sign with avatar and name only', () => {
  assert.doesNotMatch(fn(read('web/panes/ChannelPosts.tsx'), 'SignaturePill'), ENGINE_OR_MODEL);
  assert.doesNotMatch(fn(read('web/panes/PeerMessages.tsx'), 'Who'), ENGINE_OR_MODEL);
});

test('the model is still shown where it is set: the composer\'s model picker', () => {
  assert.match(read('web/composer/ModelPicker.tsx'), /modelLabel\(agent, models\)/);
});
