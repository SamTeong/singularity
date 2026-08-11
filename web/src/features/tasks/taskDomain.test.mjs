import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, COLUMN_DOMAIN, cardDomainId } from './taskDomain.js';
// Relative, not the `@/` alias — Node's test runner doesn't resolve it (see
// theme/resolveSkin.js's doc comment for the same note).
import { DOMAIN_STATE } from '../../lib/domainState.js';

test('COLUMNS and COLUMN_DOMAIN agree on the exact same set of column ids', () => {
  // Guaranteed by construction (both derive from one COLUMN_DEFS record per
  // column) rather than by two hand-synced tables — this test locks that in.
  const columnIds = COLUMNS.map(([id]) => id);
  assert.deepEqual(columnIds, Object.keys(COLUMN_DOMAIN));
});

test('every COLUMN_DOMAIN value is a valid DomainStateId', () => {
  for (const [col, domainId] of Object.entries(COLUMN_DOMAIN)) {
    assert.ok(domainId in DOMAIN_STATE, `COLUMN_DOMAIN["${col}"] = "${domainId}" is not a valid DomainStateId`);
  }
});

test('cardDomainId prefers the live agent state over the column tone', () => {
  assert.equal(cardDomainId({ column: 'todo' }, { status: 'running' }), 'running');
  assert.equal(cardDomainId({ column: 'done' }, { status: 'exited' }), 'failed');
});

test('cardDomainId falls back to the column tone when there is no agent', () => {
  assert.equal(cardDomainId({ column: 'inreview' }, undefined), 'review');
  assert.equal(cardDomainId({ column: 'done' }, undefined), 'done');
});

test('cardDomainId falls back to "queued" for an unknown column with no agent', () => {
  assert.equal(cardDomainId({ column: 'not-a-real-column' }, undefined), 'queued');
});
