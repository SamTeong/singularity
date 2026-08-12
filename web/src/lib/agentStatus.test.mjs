import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND, KIND_TO_DOMAIN } from './agentStatus.js';
import { DOMAIN_STATE } from './domainState.js';

test('every KIND value has a KIND_TO_DOMAIN entry', () => {
  for (const k of Object.values(KIND)) {
    assert.ok(k in KIND_TO_DOMAIN, `KIND value "${k}" has no KIND_TO_DOMAIN entry`);
  }
});

test('every KIND_TO_DOMAIN value is a valid DomainStateId', () => {
  // Cross-checked against lib/domainState.js's own DOMAIN_STATE table (the
  // module that owns the DomainStateId vocabulary) so a typo here — e.g.
  // `review: 'revie'` — fails this test loudly instead of silently degrading
  // to getDomainState's `?? DOMAIN_STATE.queued` fallback at runtime.
  for (const [kind, domainId] of Object.entries(KIND_TO_DOMAIN)) {
    assert.ok(domainId in DOMAIN_STATE, `KIND_TO_DOMAIN["${kind}"] = "${domainId}" is not a valid DomainStateId`);
  }
});
