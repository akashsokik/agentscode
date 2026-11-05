import assert from 'node:assert/strict';
import test from 'node:test';
import { matchScore, rankCommands, type Matchable } from '../web/paletteMatch.ts';

const titles = (items: Matchable[]) => items.map(item => item.title);

test('exact, prefix, word start, substring and fuzzy matches rank in that order', () => {
  const exact = matchScore('ada', 'ada')!;
  const prefix = matchScore('ada', 'adam')!;
  const word = matchScore('ada', 'stop ada')!;
  const inside = matchScore('ada', 'canada')!;
  const fuzzy = matchScore('nwag', 'new agent')!;
  assert.ok(exact > prefix && prefix > word && word > inside && inside > fuzzy && fuzzy > 0);
  assert.equal(matchScore('xyz', 'new agent'), null);
  assert.equal(matchScore('  ', 'anything'), 0);
});

test('matching ignores case and finds words in any order', () => {
  assert.ok(matchScore('NEW', 'New agent')! > 0);
  assert.ok(matchScore('set ada', 'Ada settings')! > 0);
  assert.ok(matchScore('gen', '#general')! >= 600);
});

test('"new" puts creating commands above New session, however recent the agent', () => {
  const items: Matchable[] = [
    { title: 'New session for Ada', priority: 0, recency: Date.now() },
    { title: 'New agent', priority: 3 },
    { title: 'New channel', priority: 3 },
  ];
  assert.deepEqual(titles(rankCommands(items, 'new')), ['New agent', 'New channel', 'New session for Ada']);
});

test('an agent named in the query outranks the commands that act on it', () => {
  const items: Matchable[] = [
    { title: 'Stop Ada', priority: 0 },
    { title: 'Ada settings', priority: 1 },
    { title: 'Ada', priority: 2 },
  ];
  assert.equal(rankCommands(items, 'ada')[0].title, 'Ada');
  assert.equal(rankCommands(items, 'stop')[0].title, 'Stop Ada');
});

test('"#gen" finds the channel before its settings', () => {
  const items: Matchable[] = [
    { title: '#general settings', priority: 1 },
    { title: '#general', keywords: 'Team chat', priority: 2 },
  ];
  assert.equal(rankCommands(items, '#gen')[0].title, '#general');
  assert.equal(rankCommands(items, 'gen')[0].title, '#general');
});

test('keywords match below titles and never fuzzily', () => {
  const items: Matchable[] = [
    { title: 'Bo', keywords: 'agent-comms-harness Developer' },
    { title: 'Developer docs' },
  ];
  assert.deepEqual(titles(rankCommands(items, 'developer')), ['Developer docs', 'Bo']);
  assert.deepEqual(titles(rankCommands([{ title: 'Bo', keywords: 'agent-comms-harness' }], 'ahs')), []);
});

test('ties fall back to recency, then to list order; an empty query keeps every item in order', () => {
  const items: Matchable[] = [
    { title: 'Cy', recency: 1 },
    { title: 'Cyd', recency: 5 },
    { title: 'Cyra', recency: 5 },
  ];
  assert.deepEqual(titles(rankCommands(items, 'cy')), ['Cy', 'Cyd', 'Cyra']);
  assert.deepEqual(titles(rankCommands(items, 'c')), ['Cyd', 'Cyra', 'Cy']);
  assert.deepEqual(titles(rankCommands(items, '')), ['Cy', 'Cyd', 'Cyra']);
});
