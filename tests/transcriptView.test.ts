import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetViews, isAnchoring, openingAnchor, rememberedView, rememberView } from '../web/transcriptView.ts';

test('a first open of a settled transcript keeps its natural height until you send', () => {
  const opening = openingAnchor(undefined, 'u1', false);
  assert.equal(isAnchoring(opening, 'u1'), false);
  assert.equal(isAnchoring(opening, 'u2'), true);
});

test('a first open mid-turn anchors the running turn', () => {
  assert.equal(isAnchoring(openingAnchor(undefined, 'u1', true), 'u1'), true);
});

test('coming back to a tab after its turn settled keeps the prompt at the top', () => {
  // Sent u2 here, switched tabs, the turn finished meanwhile.
  const opening = openingAnchor({ promptId: 'u2', anchored: true }, 'u2', false);
  assert.equal(isAnchoring(opening, 'u2'), true);
});

test('coming back to a tab that never anchored stays natural, unless a prompt was sent while away', () => {
  const remembered = { promptId: 'u1', anchored: false };
  assert.equal(isAnchoring(openingAnchor(remembered, 'u1', false), 'u1'), false);
  assert.equal(isAnchoring(openingAnchor(remembered, 'u2', false), 'u2'), true);
});

test('remembered views merge per agent and clear on reload', () => {
  forgetViews();
  assert.equal(rememberedView('a'), undefined);
  rememberView('a', { promptId: 'u1', anchored: true });
  rememberView('a', { pinned: false, fromBottom: 240 });
  const view = rememberedView('a');
  assert.equal(view?.promptId, 'u1');
  assert.equal(view?.anchored, true);
  assert.equal(view?.pinned, false);
  assert.equal(view?.fromBottom, 240);
  assert.equal(rememberedView('b'), undefined);
  forgetViews();
  assert.equal(rememberedView('a'), undefined);
});
