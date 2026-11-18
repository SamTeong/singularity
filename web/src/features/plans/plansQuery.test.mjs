import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSavedTimeframe, urlTimeframe, validStatuses, validLayout } from './plansQuery.mjs';

const DEFAULT = { preset: '3', from: '', to: '' };

test('saved timeframe: valid preset wins, anything else is the 3d default', () => {
  assert.deepEqual(parseSavedTimeframe(JSON.stringify({ preset: 'all', from: '', to: '' })), { preset: 'all', from: '', to: '' });
  assert.deepEqual(parseSavedTimeframe(JSON.stringify({ preset: 'custom', from: '2026-09-01', to: 'nope' })),
    { preset: 'custom', from: '2026-09-01', to: '' });
  assert.deepEqual(parseSavedTimeframe(null), DEFAULT);
  assert.deepEqual(parseSavedTimeframe('{bad json'), DEFAULT);
  assert.deepEqual(parseSavedTimeframe(JSON.stringify({ preset: 'bogus' })), DEFAULT);
});

test('URL timeframe: an invalid ?preset degrades to 3d; ISO days pass through', () => {
  assert.deepEqual(urlTimeframe(new URLSearchParams('preset=bogus')), DEFAULT);
  assert.deepEqual(urlTimeframe(new URLSearchParams('')), DEFAULT);
  assert.deepEqual(urlTimeframe(new URLSearchParams('preset=all&from=2026-09-01&to=2026-09-30')),
    { preset: 'all', from: '2026-09-01', to: '2026-09-30' });
});

test('invalid ?status buckets are dropped and an invalid ?layout falls back to carousel', () => {
  assert.deepEqual(validStatuses(['bogus', 'active', 'done']), ['active', 'done']);
  assert.equal(validLayout('invalid'), 'carousel');
  assert.equal(validLayout('board'), 'board');
});
