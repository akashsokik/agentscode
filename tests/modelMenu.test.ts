import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineModels } from '../shared/types.ts';
import { currentModelRow, effectiveEffort, effortRowLabel, effortRows, hasEffortRow, modelRowValue, modelRows } from '../web/composer/modelMenu.ts';

const codex: EngineModels = {
  defaultLabel: 'GPT-6.1-Sol',
  defaultEffort: 'medium',
  discovered: true,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  models: [
    { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: 'Frontier', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { value: 'gpt-6.1-mini', label: 'GPT-6.1-Mini', description: 'Fast', efforts: ['low', 'medium'] },
  ],
};

test('the effort row is named per engine and shows the effort in force', () => {
  assert.equal(effortRowLabel('codex'), 'Reasoning');
  assert.equal(effortRowLabel('claude'), 'Effort');
  assert.equal(effectiveEffort({ effort: '' }, codex), 'medium');
  assert.equal(effectiveEffort({ effort: 'high' }, codex), 'high');
  assert.equal(effectiveEffort({ effort: '' }, undefined), '');
});

test('the effort submenu lists Default with what it resolves to, then the model\'s own levels', () => {
  const rows = effortRows({ model: 'gpt-6.1-mini', effort: '' }, codex);
  assert.deepEqual(rows.map(r => r.value), ['', 'low', 'medium']);
  assert.equal(rows[0].hint, 'Medium');
  // Default model: every level the engine knows, with MonoCode's labels.
  assert.deepEqual(effortRows({ model: '', effort: '' }, codex).map(r => r.label), ['Default', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']);
  // A level the model no longer lists keeps a row, so the check mark has somewhere to go.
  assert.deepEqual(effortRows({ model: 'gpt-6.1-mini', effort: 'max' }, codex).map(r => r.value), ['', 'low', 'medium', 'max']);
});

test('there is no effort row until the engine reports levels, unless the agent already has one', () => {
  const loading: EngineModels = { defaultLabel: 'Default', defaultEffort: null, discovered: false, efforts: [], models: [] };
  assert.equal(hasEffortRow({ model: '', effort: '' }, loading), false);
  assert.equal(hasEffortRow({ model: '', effort: 'high' }, loading), true);
  assert.equal(hasEffortRow({ model: '', effort: '' }, codex), true);
});

test('the model flyout lists Default first, then the models, and highlights the current one', () => {
  const rows = modelRows({ model: 'gpt-6.1-mini' }, codex, '');
  assert.deepEqual(rows.map(modelRowValue), ['', 'gpt-6.1-sol', 'gpt-6.1-mini']);
  assert.equal(rows[0].kind === 'default' && rows[0].hint, 'GPT-6.1-Sol');
  assert.equal(currentModelRow(rows, { model: 'gpt-6.1-mini' }), 2);
  assert.equal(currentModelRow(rows, { model: '' }), 0);
});

test('a search filters the models and offers itself as a custom id when it names none exactly', () => {
  const mini = modelRows({ model: '' }, codex, 'mini');
  assert.deepEqual(mini.map(r => r.kind), ['model', 'custom']);
  assert.equal(modelRowValue(mini[1]), 'mini');
  // Naming a model exactly offers no custom row.
  assert.deepEqual(modelRows({ model: '' }, codex, 'GPT-6.1-Mini').map(r => r.kind), ['model']);
  const custom = modelRows({ model: '' }, codex, '  my-finetune ');
  assert.deepEqual(custom.map(r => r.kind), ['custom']);
  assert.equal(modelRowValue(custom[0]), 'my-finetune');
  assert.equal(currentModelRow(custom, { model: '' }), 0);
});

test('an agent on a custom model id sees it listed and checked', () => {
  const rows = modelRows({ model: 'my-finetune' }, codex, '');
  assert.equal(rows.length, 4);
  assert.equal(modelRowValue(rows[3]), 'my-finetune');
  assert.equal(currentModelRow(rows, { model: 'my-finetune' }), 3);
});
