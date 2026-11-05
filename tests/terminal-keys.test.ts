import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyKey, isTerminalToggle, type KeyPress } from '../web/terminal/keys.ts';

const press = (key: string, code: string, mods: Partial<Omit<KeyPress, 'key' | 'code'>> = {}): KeyPress => ({
  key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

test('on macOS, Cmd chords go to the app and menu, except copy, paste, line editing and splits', () => {
  // Cmd+W is not here: inside a terminal it closes the split, as in Ghostty.
  for (const [key, code] of [['n', 'KeyN'], ['k', 'KeyK'], ['b', 'KeyB'], ['q', 'KeyQ'], ['r', 'KeyR'], ['1', 'Digit1'], ['=', 'Equal']]) {
    assert.deepEqual(classifyKey(press(key, code, { metaKey: true }), true), { kind: 'app' }, `Cmd+${key}`);
  }
  assert.deepEqual(classifyKey(press('W', 'KeyW', { metaKey: true, shiftKey: true }), true), { kind: 'app' });
  assert.deepEqual(classifyKey(press('c', 'KeyC', { metaKey: true }), true), { kind: 'terminal' });
  assert.deepEqual(classifyKey(press('v', 'KeyV', { metaKey: true }), true), { kind: 'terminal' });
  assert.deepEqual(classifyKey(press('a', 'KeyA', { metaKey: true }), true), { kind: 'selectAll' });
  assert.deepEqual(classifyKey(press('t', 'KeyT', { metaKey: true }), true), { kind: 'newTerminal' });
  assert.deepEqual(classifyKey(press('ArrowLeft', 'ArrowLeft', { metaKey: true }), true), { kind: 'send', data: '\x01' });
  assert.deepEqual(classifyKey(press('ArrowRight', 'ArrowRight', { metaKey: true }), true), { kind: 'send', data: '\x05' });
  assert.deepEqual(classifyKey(press('Backspace', 'Backspace', { metaKey: true }), true), { kind: 'send', data: '\x15' });
});

test('on macOS, the Ghostty split keys work in the terminal; their neighbours stay with the app', () => {
  const mac = (key: string, code: string, mods: Partial<Omit<KeyPress, 'key' | 'code'>>) => classifyKey(press(key, code, { metaKey: true, ...mods }), true);
  assert.deepEqual(mac('d', 'KeyD', {}), { kind: 'split', dir: 'right' });
  assert.deepEqual(mac('D', 'KeyD', { shiftKey: true }), { kind: 'split', dir: 'down' });
  assert.deepEqual(mac('w', 'KeyW', {}), { kind: 'closeSplit' });
  assert.deepEqual(mac('[', 'BracketLeft', {}), { kind: 'focusSplit', to: 'previous' });
  assert.deepEqual(mac(']', 'BracketRight', {}), { kind: 'focusSplit', to: 'next' });
  assert.deepEqual(mac('ArrowUp', 'ArrowUp', { altKey: true }), { kind: 'focusSplit', to: 'up' });
  assert.deepEqual(mac('ArrowLeft', 'ArrowLeft', { altKey: true }), { kind: 'focusSplit', to: 'left' });
  assert.deepEqual(mac('Enter', 'Enter', { shiftKey: true }), { kind: 'zoomSplit' });
  assert.deepEqual(mac('=', 'Equal', { ctrlKey: true }), { kind: 'equalizeSplits' });
  // Shift+Cmd+W closes the window, Shift+Cmd+[ cycles tabs, Cmd+Option+I opens dev tools, Cmd+J hides the panel.
  assert.deepEqual(mac('W', 'KeyW', { shiftKey: true }), { kind: 'app' });
  assert.deepEqual(mac('{', 'BracketLeft', { shiftKey: true }), { kind: 'app' });
  assert.deepEqual(mac('ˆ', 'KeyI', { altKey: true }), { kind: 'app' });
  assert.deepEqual(mac('j', 'KeyJ', {}), { kind: 'app' });
  assert.deepEqual(mac('=', 'Equal', {}), { kind: 'app' });
});

test('on macOS, Option types the character it makes and moves by word', () => {
  // A British keyboard types # with Option+3; ghostty-web alone would send Escape, 3.
  assert.deepEqual(classifyKey(press('#', 'Digit3', { altKey: true }), true), { kind: 'send', data: '#' });
  assert.deepEqual(classifyKey(press('€', 'Digit2', { altKey: true, shiftKey: true }), true), { kind: 'send', data: '€' });
  assert.deepEqual(classifyKey(press('ArrowLeft', 'ArrowLeft', { altKey: true }), true), { kind: 'send', data: '\x1bb' });
  assert.deepEqual(classifyKey(press('ArrowRight', 'ArrowRight', { altKey: true }), true), { kind: 'send', data: '\x1bf' });
  assert.deepEqual(classifyKey(press('Backspace', 'Backspace', { altKey: true }), true), { kind: 'send', data: '\x1b\x7f' });
  // A dead key composes an accent; ghostty-web handles the composition.
  assert.deepEqual(classifyKey(press('Dead', 'KeyE', { altKey: true }), true), { kind: 'terminal' });
});

test('Ctrl chords stay with the shell, except tab cycling and the panel toggle', () => {
  for (const mac of [true, false]) {
    assert.deepEqual(classifyKey(press('c', 'KeyC', { ctrlKey: true }), mac), { kind: 'terminal' });
    assert.deepEqual(classifyKey(press('r', 'KeyR', { ctrlKey: true }), mac), { kind: 'terminal' });
    assert.deepEqual(classifyKey(press('Tab', 'Tab', { ctrlKey: true }), mac), { kind: 'app' });
    assert.deepEqual(classifyKey(press('`', 'Backquote', { ctrlKey: true }), mac), { kind: 'app' });
  }
  // Elsewhere Ctrl+W deletes a word and Alt makes Meta: both are the shell's.
  assert.deepEqual(classifyKey(press('w', 'KeyW', { ctrlKey: true }), false), { kind: 'terminal' });
  assert.deepEqual(classifyKey(press('b', 'KeyB', { altKey: true }), false), { kind: 'terminal' });
  assert.deepEqual(classifyKey(press('a', 'KeyA'), true), { kind: 'terminal' });
});

test('Ctrl+` toggles the panel wherever the backquote key sits', () => {
  assert.equal(isTerminalToggle(press('`', 'Backquote', { ctrlKey: true })), true);
  assert.equal(isTerminalToggle(press('`', 'IntlBackslash', { ctrlKey: true })), true);
  assert.equal(isTerminalToggle(press('`', 'Backquote', { ctrlKey: true, shiftKey: true })), false);
  assert.equal(isTerminalToggle(press('`', 'Backquote', { metaKey: true })), false);
});
