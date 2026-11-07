import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineModels } from '../shared/types.ts';
import { currentModelRow, effectiveEffort, effortRowLabel, effortRows, hasEffortRow, initialGroup, menuEntries, modelGroups, modelRowValue, modelRows, tierName, tierRows } from '../web/composer/modelMenu.ts';

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

test('the effort row is called Reasoning for every engine and shows the effort in force', () => {
  assert.equal(effortRowLabel('codex'), 'Reasoning');
  assert.equal(effortRowLabel('claude'), 'Reasoning');
  assert.equal(effortRowLabel('orcacode'), 'Reasoning');
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

const tiered: EngineModels = {
  ...codex,
  models: [
    { ...codex.models[0], serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }] },
    codex.models[1],
  ],
};

test('the menu reads Reasoning, Service Tier, Model, with Service Tier only for models that have tiers', () => {
  assert.deepEqual(menuEntries({ model: 'gpt-6.1-sol', effort: '' }, tiered), ['effort', 'tier', 'model']);
  assert.deepEqual(menuEntries({ model: 'gpt-6.1-mini', effort: '' }, tiered), ['effort', 'model']);
  // Default resolves to the listed model the CLI names, so its tiers count.
  assert.deepEqual(menuEntries({ model: '', effort: '' }, tiered), ['effort', 'tier', 'model']);
  assert.deepEqual(menuEntries({ model: 'gpt-6.1-mini', effort: '', serviceTier: 'priority' }, tiered), ['effort', 'tier', 'model']);
  assert.deepEqual(menuEntries({ model: 'x', effort: '' }, { ...tiered, models: [], efforts: [] }), ['model']);
});

test('the Service Tier submenu lists Standard, then the model\'s tiers by name', () => {
  assert.deepEqual(tierRows({ model: 'gpt-6.1-sol' }, tiered), [{ value: '', label: 'Standard' }, { value: 'priority', label: 'Fast', hint: '1.5x speed' }]);
  assert.equal(tierName({ model: 'gpt-6.1-sol', serviceTier: 'priority' }, tiered), 'Fast');
  assert.equal(tierName({ model: 'gpt-6.1-sol' }, tiered), 'Standard');
});

const orca: EngineModels = {
  defaultLabel: 'OpenAI Codex · gpt-6.1-sol',
  defaultEffort: null,
  discovered: true,
  efforts: ['low', 'medium', 'high'],
  models: [
    { value: 'openrouter::anthropic/claude-opus-5.5', label: 'Claude Opus 5.5', description: '', efforts: [], group: 'OpenRouter' },
    { value: 'openrouter::google/gemini-omni', label: 'Gemini Omni', description: '', efforts: [], group: 'OpenRouter' },
    { value: 'openai-codex::gpt-6.1-sol', label: 'gpt-6.1-sol', description: '', efforts: [], group: 'OpenAI Codex' },
  ],
};

test('OrcaCode models fall into one rail tab per provider, opening on the agent\'s own', () => {
  const groups = modelGroups(orca);
  assert.deepEqual(groups, [{ id: 'openrouter', label: 'OpenRouter' }, { id: 'openai-codex', label: 'OpenAI Codex' }]);
  assert.equal(initialGroup({ model: 'openai-codex::gpt-6.1-sol' }, groups), 'openai-codex');
  assert.equal(initialGroup({ model: '' }, groups), 'openrouter');
  assert.deepEqual(modelGroups(codex), [], 'one-provider engines have no rail');
});

test('a rail tab shows its provider\'s models; a search covers every provider', () => {
  const tab = modelRows({ model: '' }, orca, '', 'openai-codex').map(modelRowValue);
  assert.deepEqual(tab, ['', 'openai-codex::gpt-6.1-sol']);
  const found = modelRows({ model: '' }, orca, 'opus router', 'openai-codex').map(modelRowValue);
  assert.deepEqual(found, ['openrouter::anthropic/claude-opus-5.5']);
});
