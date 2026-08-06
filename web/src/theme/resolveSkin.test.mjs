import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSkin, DEFAULT_SKIN_ID } from './registry.js';
import { resolveSkin } from './resolveSkin.js';

const fakeSkin = (id, extra = {}) => ({ id, label: id.toUpperCase(), Provider: () => null, ...extra });

// registry.js is a module-level singleton — register the real default id
// (idempotent, see registry.test.mjs) plus a throwaway id per test.
registerSkin(fakeSkin(DEFAULT_SKIN_ID));

test('resolveSkin returns the exact match when the candidate id is registered', () => {
  registerSkin(fakeSkin('resolve-a'));
  assert.equal(resolveSkin('resolve-a').id, 'resolve-a');
});

test('resolveSkin falls back to DEFAULT_SKIN_ID for an unknown id', () => {
  assert.equal(resolveSkin('does-not-exist').id, DEFAULT_SKIN_ID);
});

test('resolveSkin falls back to DEFAULT_SKIN_ID for a missing/null/undefined id', () => {
  assert.equal(resolveSkin(null).id, DEFAULT_SKIN_ID);
  assert.equal(resolveSkin(undefined).id, DEFAULT_SKIN_ID);
});
