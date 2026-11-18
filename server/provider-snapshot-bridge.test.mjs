import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRustBackend } from './rust-backend.mjs';

// One backend for the file: every request carries explicit per-test paths.
const backend = createRustBackend();
await backend.start();
after(() => backend.stop());

test('snapshot bridge preserves raw lone surrogates and correlates concurrent requests', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'snapshot-bridge-'));
  try {
    const live = join(scratch, 'usage-snapshots.jsonl');
    const raw = { five_hour: { utilization: 42 }, seven_day: { utilization: 17 }, label: '\ud800' };
    const appends = await Promise.all(Array.from({ length: 8 }, (_, i) => backend.providerUsageSnapshot({
      operation: 'append_claude', live_path: live, archive_dir: scratch,
      raw: { ...raw, sequence: i }, cost_state: false, now_ms: 1_798_000_000_000 + i,
    })));
    assert.equal(appends.filter((result) => result?.appended).length, 8);
    const lines = readFileSync(live, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 8);
    assert(lines.some((line) => line.includes('\\ud800')));
    const row = await backend.providerUsageSnapshot({
      operation: 'read_claude', live_path: live, now_ms: 1_798_000_001_000,
      max_age_ms: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(row.raw.label, '\ud800');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('snapshot bridge forwards cost-state source mtime across a local month boundary', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'snapshot-cost-mtime-'));
  try {
    const live = join(scratch, 'usage-snapshots.jsonl');
    const source = join(scratch, 'cost-state.json');
    writeFileSync(source, '{}');
    const sourceDate = new Date(2026, 0, 31, 23, 58, 0);
    const nowDate = new Date(2026, 1, 1, 0, 2, 0);
    utimesSync(source, sourceDate, sourceDate);
    const fetchedAtMs = statSync(source).mtimeMs;
    const expectedFetchedAt = `${sourceDate.getFullYear()}-${String(sourceDate.getMonth() + 1).padStart(2, '0')}-${String(sourceDate.getDate()).padStart(2, '0')} ${String(sourceDate.getHours()).padStart(2, '0')}:${String(sourceDate.getMinutes()).padStart(2, '0')}:${String(sourceDate.getSeconds()).padStart(2, '0')}`;

    const appended = await backend.providerUsageSnapshot({
      operation: 'append_claude', live_path: live, archive_dir: scratch,
      raw: { five_hour: { utilization: 42 }, seven_day: { utilization: 17 }, label: '\ud800' },
      cost_state: true, now_ms: nowDate.getTime(), fetched_at_ms: fetchedAtMs,
      cost_reading: {
        session: { pctUsed: 42, resetsAt: '2026-02-02T00:00:00Z' },
        weekly: { pctUsed: 17, resetsAt: '2026-02-07T00:00:00Z' },
      },
    });

    assert.equal(appended.appended, true);
    const [line] = readFileSync(live, 'utf8').trim().split(/\r?\n/);
    assert.equal(JSON.parse(line).fetched_at, expectedFetchedAt);

    const raw = { five_hour: { utilization: 43 }, seven_day: { utilization: 17 }, label: '\ud800' };
    const rawAppend = await backend.providerUsageSnapshot({
      operation: 'append_claude', live_path: live, archive_dir: scratch,
      raw, cost_state: false, now_ms: nowDate.getTime(),
    });
    assert.equal(rawAppend.appended, true);
    const lines = readFileSync(live, 'utf8').trim().split(/\r?\n/);
    assert(lines[1].includes('\\ud800'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('snapshot bridge rotates by the first local month and reads the selected archive', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'snapshot-rotation-'));
  try {
    const live = join(scratch, 'usage-snapshots.jsonl');
    const archive = join(scratch, 'usage-snapshots-2098-11.jsonl');
    const raw = { five_hour: { utilization: 42 }, seven_day: { utilization: 17 } };
    writeFileSync(live, `${JSON.stringify({ fetched_at: '2098-11-30 23:59:00', raw })}\n${JSON.stringify({ fetched_at: '2098-12-01 00:00:05', raw })}\n`);

    const appended = await backend.providerUsageSnapshot({
      operation: 'append_claude', live_path: live, archive_dir: scratch, raw,
      cost_state: false, now_ms: Date.parse('2098-12-02T12:00:00'),
    });
    assert.equal(appended.appended, true);
    assert.equal(existsSync(live), true);
    assert.match(readFileSync(archive, 'utf8'), /2098-12-01 00:00:05/);
    const archived = await backend.providerUsageSnapshot({
      operation: 'read_claude', live_path: live, selected_archive_path: archive,
      max_age_ms: Number.MAX_SAFE_INTEGER, now_ms: Date.parse('2098-12-02T12:00:00'),
    });
    assert.equal(archived.raw.five_hour.utilization, 42);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('snapshot bridge preserves a distinct archive on collision and leaves the live file readable', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'snapshot-collision-'));
  try {
    const live = join(scratch, 'usage-snapshots.jsonl');
    const archive = join(scratch, 'usage-snapshots-2098-11.jsonl');
    const raw = { five_hour: { utilization: 42 }, seven_day: { utilization: 17 } };
    const liveText = `${JSON.stringify({ fetched_at: '2098-11-30 23:59:00', raw })}\n`;
    writeFileSync(live, liveText);
    writeFileSync(archive, 'existing distinct archive\n');

    const appended = await backend.providerUsageSnapshot({
      operation: 'append_claude', live_path: live, archive_dir: scratch, raw,
      cost_state: false, now_ms: Date.parse('2098-12-02T12:00:00'),
    });
    assert.equal(appended.appended, true);
    assert.equal(readFileSync(archive, 'utf8'), 'existing distinct archive\n');
    assert.match(readFileSync(live, 'utf8'), /2098-11-30 23:59:00/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
