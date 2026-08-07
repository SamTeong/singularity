import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// keys.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist above the env assignment).
const home = mkdtempSync(join(tmpdir(), 'sing-home-'));
process.env.SINGULARITY_HOME = home;
const { getKeys, setKeys } = await import('./keys.mjs');

after(() => rmSync(home, { recursive: true, force: true }));

test('fresh state returns {}', () => {
  assert.deepEqual(getKeys(), {});
});

test('round-trip: set then get; a second set merges rather than replaces', () => {
  const r1 = setKeys({ pageNext: { key: 'ArrowDown', alt: true } });
  assert.equal(r1.ok, true);
  assert.deepEqual(getKeys(), { pageNext: { key: 'ArrowDown', alt: true } });

  const r2 = setKeys({ pagePrev: { key: 'ArrowUp' } });
  assert.equal(r2.ok, true);
  assert.deepEqual(getKeys(), {
    pageNext: { key: 'ArrowDown', alt: true },
    pagePrev: { key: 'ArrowUp' },
  });
});

test('junk ids are rejected', () => {
  setKeys({ '../evil': { key: 'x' }, 'Bad Id': { key: 'y' } });
  const keys = getKeys();
  assert.equal('../evil' in keys, false);
  assert.equal('Bad Id' in keys, false);
});

test('non-boolean modifier and unknown extra field dropped; wrong-typed key drops the entry', () => {
  setKeys({ withJunk: { key: 'k', alt: 'yes', extra: 'nope' } });
  assert.deepEqual(getKeys().withJunk, { key: 'k' });

  const before = getKeys();
  setKeys({ badKey: { key: 123 } });
  assert.equal('badKey' in getKeys(), false);
  assert.deepEqual(getKeys(), before);
});

test('null value deletes an existing override', () => {
  setKeys({ toDelete: { key: 'd' } });
  assert.ok(getKeys().toDelete);
  setKeys({ toDelete: null });
  assert.equal('toDelete' in getKeys(), false);
});

test('64-entry cap holds', () => {
  const patch = {};
  for (let i = 0; i < 80; i++) patch[`k${i}`] = { key: String(i) };
  setKeys(patch);
  assert.equal(Object.keys(getKeys()).length, 64);
});
