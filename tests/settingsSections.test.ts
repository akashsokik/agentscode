import assert from 'node:assert/strict';
import test from 'node:test';
import { isSection, openingSection, rememberedSection, rememberSection, SECTIONS, sectionForKey } from '../web/settingsSections.ts';

test('the dialog opens on the section asked for, else the last one for this agent, else General', () => {
  assert.equal(openingSection('soul', 'memory'), 'soul', 'a deep link wins');
  assert.equal(openingSection(undefined, 'memory'), 'memory');
  assert.equal(openingSection(undefined, 'nonsense'), 'general');
  assert.equal(openingSection(undefined, undefined), 'general');
  assert.deepEqual(SECTIONS.map(s => s.id), ['general', 'soul', 'memory', 'dreaming']);
  assert.equal(isSection('dreaming'), true);
  assert.equal(isSection(3), false);
});

test('the last section is remembered per agent, and bad storage is ignored', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  rememberSection('a', 'memory', storage);
  rememberSection('b', 'soul', storage);
  assert.equal(rememberedSection('a', storage), 'memory');
  assert.equal(rememberedSection('b', storage), 'soul');
  assert.equal(rememberedSection('c', storage), undefined);
  store.set('podcode:agent-settings-section', '{not json');
  assert.equal(rememberedSection('a', storage), undefined);
  rememberSection('a', 'general', undefined);
});

test('keys: Up and Down step and wrap in the nav, Home and End jump, Cmd or Ctrl with 1 to 4 picks anywhere', () => {
  const k = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) => ({ key, ...mods });
  assert.equal(sectionForKey('general', k('ArrowDown'), true), 'soul');
  assert.equal(sectionForKey('dreaming', k('ArrowDown'), true), 'general');
  assert.equal(sectionForKey('general', k('ArrowUp'), true), 'dreaming');
  assert.equal(sectionForKey('soul', k('ArrowRight'), true), 'memory', 'the narrow row steps sideways');
  assert.equal(sectionForKey('soul', k('ArrowLeft'), true), 'general');
  assert.equal(sectionForKey('memory', k('Home'), true), 'general');
  assert.equal(sectionForKey('soul', k('End'), true), 'dreaming');
  assert.equal(sectionForKey('soul', k('ArrowDown'), false), null, 'arrows outside the nav are the field\'s');
  assert.equal(sectionForKey('soul', k('3', { metaKey: true }), false), 'memory');
  assert.equal(sectionForKey('soul', k('1', { ctrlKey: true }), true), 'general');
  assert.equal(sectionForKey('soul', k('9', { metaKey: true }), false), null, 'no ninth section');
  assert.equal(sectionForKey('soul', k('2', { metaKey: true, shiftKey: true }), false), null);
  assert.equal(sectionForKey('soul', k('a'), true), null);
});
