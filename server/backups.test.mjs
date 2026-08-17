import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// backups.mjs imports app-dir.mjs (BACKUPS_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { backupFile, backupFileSync } = await import('./backups.mjs');

function makeFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sing-bak-src-'));
  const p = join(dir, 'target.txt');
  writeFileSync(p, content);
  return p;
}

test('backs up an existing file; content matches the original', async () => {
  const p = makeFile('hello world');
  const backup = await backupFile(p);
  assert.ok(backup);
  assert.equal(existsSync(backup), true);
  assert.equal(readFileSync(backup, 'utf8'), 'hello world');
});

test('returns null for a missing source, does not create a dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sing-bak-src-'));
  const missing = join(dir, 'nope.txt');
  const backup = await backupFile(missing);
  assert.equal(backup, null);
});

test('retention: 6 successive backups leave exactly 5 .bak files, oldest gone', async () => {
  const p = makeFile('v0');
  let first;
  for (let i = 1; i <= 6; i++) {
    writeFileSync(p, `v${i}`);
    const backup = await backupFile(p);
    if (i === 1) first = backup;
  }
  const dir = join(first, '..');
  const baks = readdirSync(dir).filter((f) => f.endsWith('.bak'));
  assert.equal(baks.length, 5);
  assert.equal(existsSync(first), false); // the oldest (1st) backup was pruned
});

test('source.txt contains the original absolute path', async () => {
  const p = makeFile('content');
  const backup = await backupFile(p);
  const sourceFile = join(backup, '..', 'source.txt');
  assert.equal(readFileSync(sourceFile, 'utf8'), p);
});

// Regression test for the sync->async conversion: planBackup's collision
// probe used to be a plain existsSync check, which two concurrent backupFile
// calls for the same path (autosave racing a manual save) could both pass
// before either had written its file, landing on the same destination name
// and one silently clobbering the other's backup.
test('concurrent backups of the same path never collide on the destination name', async () => {
  const p = makeFile('v0');
  const [b1, b2] = await Promise.all([backupFile(p), backupFile(p)]);
  assert.ok(b1);
  assert.ok(b2);
  assert.notEqual(b1, b2);
  assert.equal(existsSync(b1), true);
  assert.equal(existsSync(b2), true);
});

// Regression test for the sync->async conversion: the retention prune used to
// let a lost unlink race (a second concurrent backup already having removed
// the same stale file — ENOENT on POSIX, observed as EPERM on Windows) bubble
// up to backupFile's outer catch, so a benign race made the whole call
// spuriously return null despite its own copy having already succeeded.
test('a burst of concurrent backups over the retention cap never returns null (lost-unlink-race-safe prune)', async () => {
  const p = makeFile('v0');
  for (let i = 1; i <= 5; i++) { writeFileSync(p, `v${i}`); await backupFile(p); }
  writeFileSync(p, 'v6');
  const results = await Promise.all(Array.from({ length: 5 }, () => backupFile(p)));
  assert.ok(results.every(Boolean), 'every concurrent backup succeeded despite a shared prune race');
});

// backupFileSync: same contract, used only by migrate-state.mjs's boot path.
test('sync twin: backs up an existing file; content matches the original', () => {
  const p = makeFile('hello sync');
  const backup = backupFileSync(p);
  assert.ok(backup);
  assert.equal(existsSync(backup), true);
  assert.equal(readFileSync(backup, 'utf8'), 'hello sync');
});

test('sync twin retention: 6 successive backups leave exactly 5 .bak files, oldest gone', () => {
  const p = makeFile('v0');
  let first;
  for (let i = 1; i <= 6; i++) {
    writeFileSync(p, `v${i}`);
    const backup = backupFileSync(p);
    if (i === 1) first = backup;
  }
  const dir = join(first, '..');
  const baks = readdirSync(dir).filter((f) => f.endsWith('.bak'));
  assert.equal(baks.length, 5);
  assert.equal(existsSync(first), false);
});
