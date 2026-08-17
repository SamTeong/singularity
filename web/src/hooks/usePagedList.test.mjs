import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from './usePagedList.js';

test('slices the requested page', () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  assert.deepEqual(paginate(items, 10, 2), { page: 2, pageCount: 3, pageItems: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] });
});

test('clamps page down when the item count shrinks it out of range', () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  assert.deepEqual(paginate(items, 10, 3), { page: 1, pageCount: 1, pageItems: [0, 1, 2, 3, 4] });
});

test('empty list is always one empty page, never page 0', () => {
  assert.deepEqual(paginate([], 10, 1), { page: 1, pageCount: 1, pageItems: [] });
});
