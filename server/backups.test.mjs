import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// backups.mjs imports app-dir.mjs (BACKUPS_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { backupFile } = await import('./backups.mjs');

function makeFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sing-bak-src-'));
  const p = join(dir, 'target.txt');
  writeFileSync(p, content);
  return p;
}

function backupDirFor(p) {
  const backup = backupFile(p);
  return backup;
}

test('backs up an existing file; content matches the original', () => {
  const p = makeFile('hello world');
  const backup = backupFile(p);
  assert.ok(backup);
  assert.equal(existsSync(backup), true);
  assert.equal(readFileSync(backup, 'utf8'), 'hello world');
});

test('returns null for a missing source, does not create a dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sing-bak-src-'));
  const missing = join(dir, 'nope.txt');
  const backup = backupFile(missing);
  assert.equal(backup, null);
});

test('retention: 6 successive backups leave exactly 5 .bak files, oldest gone', () => {
  const p = makeFile('v0');
  let first;
  for (let i = 1; i <= 6; i++) {
    writeFileSync(p, `v${i}`);
    const backup = backupDirFor(p);
    if (i === 1) first = backup;
  }
  const dir = join(first, '..');
  const baks = readdirSync(dir).filter((f) => f.endsWith('.bak'));
  assert.equal(baks.length, 5);
  assert.equal(existsSync(first), false); // the oldest (1st) backup was pruned
});

test('source.txt contains the original absolute path', () => {
  const p = makeFile('content');
  const backup = backupFile(p);
  const sourceFile = join(backup, '..', 'source.txt');
  assert.equal(readFileSync(sourceFile, 'utf8'), p);
});
