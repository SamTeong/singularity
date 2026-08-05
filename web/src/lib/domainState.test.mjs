import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN_STATE, DOMAIN_STATE_ORDER, getDomainState } from './domainState.js';

const TONES = new Set(['mint', 'green', 'amber', 'blue', 'red', 'orange', 'paper', 'dim', 'teal']);

test('every domain state has the five documented fields', () => {
  for (const [id, entry] of Object.entries(DOMAIN_STATE)) {
    assert.ok(TONES.has(entry.tone), `${id}.tone is a valid Phosphor Tone`);
    assert.equal(typeof entry.filled, 'boolean', `${id}.filled is boolean`);
    assert.equal(typeof entry.jp, 'string', `${id}.jp is a string`);
    assert.ok(entry.jp.length > 0, `${id}.jp is non-empty`);
    assert.equal(typeof entry.en, 'string', `${id}.en is a string`);
    assert.ok(entry.en.length > 0, `${id}.en is non-empty`);
    assert.equal(typeof entry.srLabel, 'string', `${id}.srLabel is a string`);
    assert.ok(entry.srLabel.length > 0, `${id}.srLabel is non-empty`);
  }
});

test('orange is never a domain-state tone (chrome-only)', () => {
  for (const entry of Object.values(DOMAIN_STATE)) assert.notEqual(entry.tone, 'orange');
});

test('DOMAIN_STATE_ORDER lists exactly the DOMAIN_STATE keys, in the design.md D4 order', () => {
  assert.deepEqual(DOMAIN_STATE_ORDER, ['queued', 'planning', 'running', 'review', 'done', 'failed']);
  assert.deepEqual([...DOMAIN_STATE_ORDER].sort(), Object.keys(DOMAIN_STATE).sort());
});

test('getDomainState looks up a known id', () => {
  assert.equal(getDomainState('running'), DOMAIN_STATE.running);
});

test('getDomainState falls back to queued for an unknown id', () => {
  assert.equal(getDomainState('not-a-real-state'), DOMAIN_STATE.queued);
  assert.equal(getDomainState(undefined), DOMAIN_STATE.queued);
});

test('done is the figure/ground-inverted (filled) merged state', () => {
  assert.equal(DOMAIN_STATE.done.filled, true);
  assert.equal(DOMAIN_STATE.done.tone, 'mint');
});

test('failed is red', () => {
  assert.equal(DOMAIN_STATE.failed.tone, 'red');
});
