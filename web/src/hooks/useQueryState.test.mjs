import test from 'node:test';
import assert from 'node:assert/strict';
import { queryPatch, patchBase } from './useQueryState.js';

const patch = (init, p) => queryPatch(new URLSearchParams(init), p).toString();

test('a value equal to nothing (null/empty) drops the param', () => {
  assert.equal(patch('preset=30&compact=1', { preset: null, compact: '' }), '');
});

test('arrays write repeated params, sorted, so the same set is the same URL', () => {
  assert.equal(patch('', { tag: ['b', 'a'] }), 'tag=a&tag=b');
  assert.equal(patch('', { tag: ['a', 'b'] }), patch('', { tag: ['b', 'a'] }));
});

test('an array replaces the previous values rather than appending to them', () => {
  assert.equal(patch('tag=a&tag=b', { tag: ['c'] }), 'tag=c');
  assert.equal(patch('tag=a&tag=b', { tag: [] }), '');
});

test('untouched keys survive and one call writes many keys', () => {
  assert.equal(
    patch('q=hi&preset=7', { preset: '30', from: '2026-01-01' }),
    'q=hi&preset=30&from=2026-01-01',
  );
});

test('a patch bases on the last written params only while still on that route', () => {
  const stored = { path: '/tasks', params: new URLSearchParams('tag=a') };
  assert.equal(patchBase(stored, '/tasks', '?stale=1').toString(), 'tag=a');
  // Another route: the previous route's params must not leak into this URL.
  assert.equal(patchBase(stored, '/history', '?preset=30').toString(), 'preset=30');
  // Nothing written yet: the live URL, never an empty set.
  assert.equal(patchBase(null, '/history', '?preset=30').toString(), 'preset=30');
});

test('commas in a value stay in one param (no CSV encoding)', () => {
  const p = queryPatch(new URLSearchParams(), { tag: ['a,b'] });
  assert.deepEqual(p.getAll('tag'), ['a,b']);
});
