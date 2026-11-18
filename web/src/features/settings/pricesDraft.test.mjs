import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultKeyAfterDelete, defaultKeyAfterRename } from './pricesDraft.mjs';

const rows = (...keys) => keys.map((key) => ({ key, values: [] }));

test('deleting the selected fallback picks the next row, else the preceding, else none', () => {
  // a,b,c with b selected: delete b -> rows a,c; c slid into slot 1.
  assert.equal(defaultKeyAfterDelete('b', 'b', rows('a', 'c'), 1), 'c');
  // Last row selected: nothing slides in, so the preceding row wins.
  assert.equal(defaultKeyAfterDelete('c', 'c', rows('a', 'b'), 2), 'b');
  // Only row: cleared.
  assert.equal(defaultKeyAfterDelete('a', ' a ', rows(), 0), '');
});

test('deleting a non-selected row keeps the fallback', () => {
  assert.equal(defaultKeyAfterDelete('b', 'a', rows('b', 'c'), 0), 'b');
  assert.equal(defaultKeyAfterDelete('b', undefined, rows('b'), 5), 'b');
});

test('renaming the selected fallback follows the new key; other renames do not', () => {
  assert.equal(defaultKeyAfterRename('opus', 'opus', 'opus-renamed '), 'opus-renamed');
  assert.equal(defaultKeyAfterRename('opus', 'sonnet', 'haiku'), 'opus');
});
