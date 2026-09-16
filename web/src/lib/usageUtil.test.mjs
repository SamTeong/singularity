import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowAnchorAvailable, windowAnchored } from './usageUtil.js';

const iso = (ms) => new Date(Date.now() + ms).toISOString();

test('a live window is anchored even at 0% with a stale last anchor', () => {
  const session = { pctUsed: 0, resetsAt: iso(3.8 * 3.6e6) };
  assert.equal(windowAnchored(session, Date.now() - 7.5 * 3.6e6), true);
});

test('an expired idle window is not anchored', () => {
  const session = { pctUsed: 0, resetsAt: iso(-6e4) };
  assert.equal(windowAnchored(session, Date.now() - 7.5 * 3.6e6), false);
});

test('a fresh poke anchors a provider with no session block at all', () => {
  assert.equal(windowAnchored(null, Date.now() - 6e4), true);
  assert.equal(windowAnchored(null, null), false);
});

test('an explicitly unstarted window remains triggerable after an ineffective poke', () => {
  const session = { pctUsed: 0, resetsAt: null, started: false };
  assert.equal(windowAnchored(session, Date.now() - 6e4), false);
});

test('Claude anchor controls require a plan session window', () => {
  assert.equal(windowAnchorAvailable('claude', null), false);
  assert.equal(windowAnchorAvailable('claude', { pctUsed: 0 }), true);
  assert.equal(windowAnchorAvailable('codex', null), true);
});
