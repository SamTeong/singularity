import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtUsd, fmtTokens, relTime } from './format.js';

test('fmtUsd renders sub-cent amounts as <$0.01', () => {
  assert.equal(fmtUsd(0.004), '<$0.01');
});

test('fmtUsd(null) returns the empty sentinel', () => {
  assert.equal(fmtUsd(null), null);
});

test('fmtUsd(0) is consistent with positive amounts (not the sub-cent case)', () => {
  assert.equal(fmtUsd(0), '$0.00');
});

test('fmtTokens drops the .0 at the M/k rounding boundary', () => {
  assert.equal(fmtTokens(9.5e6), '9.5M');
  assert.equal(fmtTokens(1.2e7), '12M');
  assert.equal(fmtTokens(9.5e3), '9.5k');
  assert.equal(fmtTokens(1.2e4), '12k');
});

test('relTime reports "just now" under the 60s threshold', () => {
  const now = Date.now();
  assert.equal(relTime(now - 1000), 'just now');
  assert.equal(relTime(now - 59000), 'just now');
  assert.equal(relTime(now - 61000), '1m ago');
});

test('relTime handles a non-finite ms (no mtime)', () => {
  assert.equal(relTime(NaN), '');
});
