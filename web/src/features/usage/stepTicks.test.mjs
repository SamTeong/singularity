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

test('sub-day ticks stay elapsed-time aligned and strictly increasing through spring and fall DST', () => {
  process.env.TZ = 'America/New_York';
  for (const [min, max] of [
    [new Date(2026, 2, 8, 0).getTime(), new Date(2026, 2, 8, 5).getTime()],
    [new Date(2026, 10, 1, 0).getTime(), new Date(2026, 10, 1, 5).getTime()],
  ]) {
    const ticks = stepTicks(min, max, 30 * 60_000).map(Number);
    assert.ok(ticks.length > 0);
    assert.ok(ticks.every((t, i) => t >= min && t <= max && (!i || t > ticks[i - 1])));
    assert.ok(ticks.every((t, i) => !i || t - ticks[i - 1] === 30 * 60_000));
  }
});

test('invalid tick bounds and steps return no ticks', () => {
  for (const args of [[NaN, 10, 1], [0, Infinity, 1], [0, 10, NaN], [0, 10, 0], [10, 0, 1]]) {
    assert.deepEqual(stepTicks(...args), []);
  }
});

test('6h ticks remain monotonic and unique through fall DST', () => {
  process.env.TZ = 'America/New_York';
  const min = new Date(2026, 9, 31).getTime();
  const ticks = stepTicks(min, min + 3 * 24 * H, 6 * H).map(Number);
  assert.ok(ticks.every((t, i) => !i || t > ticks[i - 1]));
  assert.equal(new Set(ticks).size, ticks.length);
});
