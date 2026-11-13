import assert from 'node:assert/strict';
import test from 'node:test';
import { filterOptions } from '../web/mono/filter.ts';

test('shared phrase filtering preserves quick-picker label/hint matching without changing word-search selects (ACH-37)', () => {
  const options = [{ label: 'Alpha', value: 'First model' }, { label: 'Beta', value: 'Second model' }];
  assert.deepEqual(filterOptions(options, '  ALPHA FIRST  ', 'phrase'), [options[0]]);
  assert.deepEqual(filterOptions(options, 'first alpha', 'phrase'), []);
  assert.deepEqual(filterOptions(options, 'first alpha'), [options[0]], 'selects still match every word in any order');
  assert.deepEqual(filterOptions(options, 'alpha  first', 'phrase'), [], 'internal phrase spacing is significant, as before');
  assert.equal(filterOptions(options, '   ', 'phrase'), options);
});
