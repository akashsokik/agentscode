import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { menuRowTone } from '../web/ui/menuRowTone.ts';

// ACH-D49: keyboard focus and the value in force never look alike in a menu.

test('the keyboard row has the strong fill; the current value a quiet one; plain rows the hover tone', () => {
  assert.equal(menuRowTone({ keyboard: true }), 'bg-selection text-content');
  assert.equal(menuRowTone({ keyboard: true, quiet: true }), 'bg-selection text-content', 'on the current row, the keyboard fill wins');
  const current = menuRowTone({ quiet: true });
  assert.match(current, /^bg-content\/4 /);
  assert.doesNotMatch(current, /(^| )bg-selection( |$)/, 'the current value never takes the keyboard fill');
  assert.match(current, /focus-visible:bg-selection/, 'but it does when keyboard focus lands on it');
  const plain = menuRowTone({});
  assert.doesNotMatch(plain, /(^| )bg-/);
  assert.match(plain, /hover:bg-content\/5/);
  assert.match(plain, /focus-visible:bg-selection/, 'real DOM focus (ContextMenu arrow keys) shows as the strong fill');
  assert.match(menuRowTone({ danger: true, keyboard: true }), /text-danger/);
});

test('MenuRow takes current and active, and routes every state through menuRowTone', () => {
  const src = fs.readFileSync(new URL('../web/ui/common.tsx', import.meta.url), 'utf8');
  const row = src.slice(src.indexOf('export function MenuRow('), src.indexOf('/** A quiet empty state'));
  assert.match(row, /current\?: boolean;/);
  assert.match(row, /active\?: boolean;/);
  assert.match(row, /menuRowTone\(\{ danger, keyboard: highlighted \|\| active, quiet: current \|\| selected \}\)/);
  assert.match(row, /aria-selected=\{role === 'option' \? selected \?\? checked \?\? current : undefined\}/);
  assert.match(row, /aria-current=\{role === 'menuitem' && current \? 'true' : undefined\}/);
  assert.doesNotMatch(row, /highlighted \|\| selected \? 'bg-selection/, 'the old shared fill is gone');
});
