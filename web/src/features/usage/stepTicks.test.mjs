import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepTicks, firstTickOfEachLocalDate } from './stepTicks.mjs';

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

test('5h ticks align to local half-hours in quarter-hour time zones', () => {
  process.env.TZ = 'Asia/Kathmandu';
  const min = Date.parse('2026-01-01T00:00:00Z');
  const ticks = stepTicks(min, min + 5 * H, H / 2);
  assert.ok(ticks.length > 0);
  assert.ok(ticks.every((d) => d.getMinutes() === 0 || d.getMinutes() === 30));
  assert.equal(ticks.filter((d) => d.getMinutes() === 0).length, 5);
});

test('tick generation respects its 100,000 tick cap', () => {
  assert.deepEqual(stepTicks(0, 100_001 * H, H), []);
});

test('first local date tick remains labelable when DST skips midnight', () => {
  process.env.TZ = 'America/Sao_Paulo';
  const min = new Date(2018, 10, 3).getTime();
  const max = new Date(2018, 10, 6).getTime();
  const ticks = stepTicks(min, max, 6 * H);
  const labels = firstTickOfEachLocalDate(ticks);
  const transitionDate = ticks.find((d) => d.getFullYear() === 2018 && d.getMonth() === 10 && d.getDate() === 4);
  assert.ok(transitionDate);
  assert.equal(transitionDate.getHours(), 6);
  assert.ok(labels.has(transitionDate.getTime()));
});

test('6h ticks remain monotonic and unique through fall DST', () => {
  process.env.TZ = 'America/New_York';
  const min = new Date(2026, 9, 31).getTime();
  const ticks = stepTicks(min, min + 3 * 24 * H, 6 * H).map(Number);
  assert.ok(ticks.every((t, i) => !i || t > ticks[i - 1]));
  assert.equal(new Set(ticks).size, ticks.length);
});
