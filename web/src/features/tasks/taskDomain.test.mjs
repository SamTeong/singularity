import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, COLUMN_DOMAIN, cardDomainId, firstEnteredAt, isLimitState, taskStateLabel } from './taskDomain.js';
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

test('firstEnteredAt returns the first transition record targeting the column', () => {
  const transitions = [
    { from: 'todo', to: 'inprogress', at: 1000 },
    { from: 'inprogress', to: 'inreview', at: 2000 },
    { from: 'inreview', to: 'done', at: 3000 },
  ];
  assert.equal(firstEnteredAt(transitions, 'inprogress'), 1000);
  assert.equal(firstEnteredAt(transitions, 'done'), 3000);
});

test('firstEnteredAt uses creation time for To-Do, including legacy tasks and later re-entry', () => {
  const createdAt = 500;
  const transitions = [
    { from: 'todo', to: 'inprogress', at: 1000 },
    { from: 'inprogress', to: 'todo', at: 2000 },
  ];

  assert.equal(firstEnteredAt([], 'todo', createdAt), createdAt);
  assert.equal(firstEnteredAt(transitions, 'todo', createdAt), createdAt);
  assert.equal(firstEnteredAt(undefined, 'todo', createdAt), createdAt);
});

test('firstEnteredAt returns null for a never-entered column or missing history', () => {
  const transitions = [{ from: 'todo', to: 'done', at: 1000 }];
  assert.equal(firstEnteredAt(transitions, 'inreview'), null);
  assert.equal(firstEnteredAt(undefined, 'done'), null);
  assert.equal(firstEnteredAt([], 'done'), null);
  assert.equal(firstEnteredAt([], 'todo'), null);
  assert.equal(firstEnteredAt([{ from: 'inprogress', to: 'todo', at: 2000 }], 'todo'), 2000);
});

test('taskStateLabel appends the local reset time to a usage limit only', () => {
  const resetAt = new Date(2026, 0, 10, 15, 5).getTime(); // local 15:05
  assert.equal(taskStateLabel({ state: 'usage-limited', limitResetAt: resetAt }), 'usage-limited · resets 15:05');
  assert.equal(taskStateLabel({ state: 'usage-limited' }), 'usage-limited');
  assert.equal(taskStateLabel({ state: 'rate-limited', limitResetAt: resetAt }), 'rate-limited');
  assert.equal(taskStateLabel({ state: 'implementing' }), 'implementing');
});

test('taskStateLabel adds an unambiguous local date when the reset falls on a later day', () => {
  const now = new Date(2026, 0, 10, 23, 30).getTime();
  const sameDay = new Date(2026, 0, 10, 23, 55).getTime();
  const nextDay = new Date(2026, 0, 11, 4, 5).getTime();
  assert.equal(taskStateLabel({ state: 'usage-limited', limitResetAt: sameDay }, now), 'usage-limited · resets 23:55');
  assert.equal(taskStateLabel({ state: 'usage-limited', limitResetAt: nextDay }, now), 'usage-limited · resets 2026-01-11 04:05');
});

test('isLimitState covers both overlay limit states only', () => {
  assert.equal(isLimitState({ state: 'usage-limited' }), true);
  assert.equal(isLimitState({ state: 'rate-limited' }), true);
  assert.equal(isLimitState({ state: 'implementing' }), false);
  assert.equal(isLimitState({}), false);
});
