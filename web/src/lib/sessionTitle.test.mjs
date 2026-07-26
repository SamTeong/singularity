import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSessionTitle, nextCycledSession } from './sessionTitle.js';

test('nextSessionTitle returns blank for an unnamed source (title == id prefix)', () => {
  const a = { title: 'abcd1234', id: 'abcd1234ef' };
  assert.equal(nextSessionTitle([a], a), '');
});

test('nextSessionTitle suffixes _2 for a first copy', () => {
  const a = { title: 'worker', id: 'ffffffffff' };
  assert.equal(nextSessionTitle([a], a), 'worker_2');
});

test('nextSessionTitle picks the lowest free _N', () => {
  const src = { title: 'worker', id: 'ffffffffff' };
  const agents = [src, { title: 'worker_2', id: 'x' }, { title: 'worker_4', id: 'y' }];
  assert.equal(nextSessionTitle(agents, src), 'worker_3');
});

test('nextSessionTitle strips an existing _N before re-numbering', () => {
  // base = 'worker'; taken = {worker_2 (src), worker} → lowest free is worker_3
  const src = { title: 'worker_2', id: 'ffffffffff' };
  const agents = [src, { title: 'worker', id: 'a' }];
  assert.equal(nextSessionTitle(agents, src), 'worker_3');
});

test('nextCycledSession returns null with fewer than two cyclable sessions', () => {
  assert.equal(nextCycledSession([{ id: 'a', status: 'running' }], 'a', 1), null);
  const withDetached = [{ id: 'a', status: 'running' }, { id: 'b', status: 'detached' }];
  assert.equal(nextCycledSession(withDetached, 'a', 1), null);
});

test('nextCycledSession wraps forward and backward, excluding detached', () => {
  const agents = [
    { id: 'a', status: 'running' },
    { id: 'b', status: 'idle' },
    { id: 'c', status: 'detached' },
    { id: 'd', status: 'running' },
  ];
  assert.equal(nextCycledSession(agents, 'a', 1), 'b');
  assert.equal(nextCycledSession(agents, 'd', 1), 'a'); // wrap
  assert.equal(nextCycledSession(agents, 'a', -1), 'd'); // wrap back
});
