import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepTicks } from './stepTicks.mjs';

const H = 3.6e6;

test('7d ticks keep local-midnight alignment across a DST change', () => {
  process.env.TZ = 'America/New_York'; // US spring-forward 2026-03-08
  const min = new Date(2026, 2, 5).getTime();
  const max = new Date(2026, 2, 12).getTime();
  assert.notEqual(new Date(min).getTimezoneOffset(), new Date(max).getTimezoneOffset(), 'TZ override not applied');
  const midnights = stepTicks(min, max, 6 * H).filter((d) => d.getHours() === 0);
  assert.equal(midnights.length, 8); // Mar 5..12 inclusive
});
