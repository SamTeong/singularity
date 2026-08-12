import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollAreaResync } from './scrollAreaResync.js';

test('scroll-area resync runs during a continuous output stream', () => {
  const timers = [];
  let runs = 0;
  const resync = createScrollAreaResync(
    () => { runs += 1; },
    (callback) => { timers.push(callback); return timers.length; },
    () => {},
  );

  resync.schedule();
  resync.schedule();
  resync.schedule();
  assert.equal(timers.length, 1);

  timers[0]();
  assert.equal(runs, 1);

  resync.schedule();
  assert.equal(timers.length, 2);
});
