import assert from 'node:assert/strict';
import test from 'node:test';
import { createParser } from '@openuidev/lang-core';
import { OPENUI_COMPONENTS } from '../shared/openui.ts';
import { openuiGuide, openuiLibrary } from '../server/openuiGuide.ts';
import { chartSource, clickOutcome, sortRows } from '../web/openui/charts.ts';

test('the guide lists every AgentsCode component and the AgentsCode rules', () => {
  const guide = openuiGuide();
  for (const name of Object.keys(OPENUI_COMPONENTS)) assert.match(guide, new RegExp(`\\b${name}\\(`), name);
  assert.match(guide, /```openui-lang/);
  assert.match(guide, /never set colours/);
  assert.match(guide, /stands alone/);
  assert.equal(openuiGuide(), guide);
});

test('the example in the guide parses against the library with no errors', () => {
  const program = /```openui-lang\n([\s\S]*?)```/.exec(openuiGuide())![1];
  const result = createParser(openuiLibrary().toJSONSchema(), 'Stack').parse(program);
  assert.equal(result.root?.typeName, 'Stack');
  assert.deepEqual(result.meta.errors, []);
  assert.deepEqual(result.meta.unresolved, []);
  assert.deepEqual(result.meta.orphaned, []);
});

test('a program with an unknown component or a missing prop reports it', () => {
  const parser = createParser(openuiLibrary().toJSONSchema(), 'Stack');
  const bad = parser.parse('root = Stack([m, x])\nm = Metric()\nx = Gauge(3)');
  assert.ok(bad.meta.errors.length > 0);
});

test('charts become Mermaid xycharts, one line per series, padded to the labels', () => {
  assert.equal(chartSource({ kind: 'bar', title: 'Turns "today"', labels: ['Mon', 'Tue lunch'], series: [{ name: 'a', values: [3, 5] }, { name: 'b', values: [1] }], yLabel: 'Turns' }),
    'xychart-beta\n  title "Turns \'today\'"\n  x-axis ["Mon", "Tue lunch"]\n  y-axis "Turns" 0 --> 5\n  bar [3, 5]\n  bar [1, 0]');
  assert.match(chartSource({ kind: 'line', labels: ['a'], series: [{ name: 's', values: [NaN] }] }), /y-axis 0 --> 1\n  line \[0\]/);
  assert.match(chartSource({ kind: 'bar', labels: ['a', 'b'], series: [{ name: 's', values: [-2, 4] }] }), /y-axis -2 --> 4/);
});

test('tables sort numbers as numbers, text naturally, empty cells last', () => {
  const rows = [['b', 10], ['a', 9], [null, 1], ['c2', 100], ['c10', 2]];
  assert.deepEqual(sortRows(rows, 1, false).map(r => r[1]), [1, 2, 9, 10, 100]);
  assert.deepEqual(sortRows(rows, 0, false).map(r => r[0]), ['a', 'b', 'c2', 'c10', null]);
  assert.deepEqual(sortRows(rows, 0, true).map(r => r[0]), ['c10', 'c2', 'b', 'a', null]);
});

test('a click sends its message to the agent, opens only web links, and ignores the rest', () => {
  assert.deepEqual(clickOutcome({ type: 'continue_conversation', params: {}, humanFriendlyMessage: 'Run the tests' }), { kind: 'send', text: 'Run the tests' });
  assert.deepEqual(clickOutcome({ type: 'continue_conversation', params: { context: { id: 42 } }, humanFriendlyMessage: 'Show details' }), { kind: 'send', text: 'Show details\n\nContext: {"id":42}' });
  assert.deepEqual(clickOutcome({ type: 'open_url', params: { url: 'https://example.com' } }), { kind: 'open', url: 'https://example.com' });
  assert.equal(clickOutcome({ type: 'open_url', params: { url: 'javascript:alert(1)' } }), null);
  assert.equal(clickOutcome({ type: 'open_url', params: { url: 'file:///etc/passwd' } }), null);
  assert.equal(clickOutcome({ type: 'continue_conversation', params: {}, humanFriendlyMessage: '  ' }), null);
  assert.equal(clickOutcome({ type: 'custom', params: {} }), null);
});
