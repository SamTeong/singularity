import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesTags, compareHistory } from './historySort.mjs';

test('tag filter: empty set matches all, otherwise ANY active tag matches', () => {
  assert.equal(matchesTags(new Set(), { tags: [] }), true);
  assert.equal(matchesTags(new Set(['ui']), { tags: ['api', 'ui'] }), true);
  assert.equal(matchesTags(new Set(['ui']), { tags: ['api'] }), false);
  assert.equal(matchesTags(new Set(['ui']), {}), false);
});

test('history sort: strings by localeCompare, numbers by value, missing stats as 0, dir reverses', () => {
  const rows = [
    { title: 'b', repo: 'C:/r/zeta', finalStats: { costUsd: 2 }, concludedAt: '2026-01-02T00:00:00Z' },
    { title: 'a', repo: '/r/alpha/', concludedAt: '2026-01-03T00:00:00Z' },
    { title: 'c', repo: '/r/mid', finalStats: { costUsd: 1 } },
  ];
  const titles = (sort) => rows.slice().sort(compareHistory(sort)).map((r) => r.title);
  assert.deepEqual(titles({ key: 'title', dir: 'asc' }), ['a', 'b', 'c']);
  assert.deepEqual(titles({ key: 'title', dir: 'desc' }), ['c', 'b', 'a']);
  assert.deepEqual(titles({ key: 'repo', dir: 'asc' }), ['a', 'c', 'b']);
  assert.deepEqual(titles({ key: 'costUsd', dir: 'desc' }), ['b', 'c', 'a']);
  assert.deepEqual(titles({ key: 'concludedAt', dir: 'desc' }), ['a', 'b', 'c']);
});
