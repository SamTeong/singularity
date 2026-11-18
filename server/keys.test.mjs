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
const [{ getKeys, setKeys, setKeysBackend }, { createRustBackend }] = await Promise.all([
  import('./keys.mjs'), import('./rust-backend.mjs'),
]);
const backend = createRustBackend();
await backend.start();
setKeysBackend(backend);

after(async () => { await backend.stop(); rmSync(home, { recursive: true, force: true }); });

async function clearKeys() {
  const current = await getKeys();
  await setKeys(Object.fromEntries(Object.keys(current).map((id) => [id, null])));
}

test('fresh state returns {}', async () => {
  assert.deepEqual(await getKeys(), {});
});

test('round-trip: set then get; a second set merges rather than replaces', async () => {
  const r1 = await setKeys({ pageNext: { key: 'ArrowDown', alt: true } });
  assert.equal(r1.ok, true);
  assert.deepEqual(await getKeys(), { pageNext: { key: 'ArrowDown', alt: true } });

  const r2 = await setKeys({ pagePrev: { key: 'ArrowUp' } });
  assert.equal(r2.ok, true);
  assert.deepEqual(await getKeys(), {
    pageNext: { key: 'ArrowDown', alt: true },
    pagePrev: { key: 'ArrowUp' },
  });
});

test('junk ids are rejected', async () => {
  await setKeys({ '../evil': { key: 'x' }, 'Bad Id': { key: 'y' } });
  const keys = await getKeys();
  assert.equal('../evil' in keys, false);
  assert.equal('Bad Id' in keys, false);
});

test('non-boolean modifier and unknown extra field dropped; wrong-typed key drops the entry', async () => {
  await setKeys({ withJunk: { key: 'k', alt: 'yes', extra: 'nope' } });
  assert.deepEqual((await getKeys()).withJunk, { key: 'k' });

  const before = await getKeys();
  await setKeys({ badKey: { key: 123 } });
  assert.equal('badKey' in await getKeys(), false);
  assert.deepEqual(await getKeys(), before);
});

test('null value deletes an existing override', async () => {
  await setKeys({ toDelete: { key: 'd' } });
  assert.ok((await getKeys()).toDelete);
  await setKeys({ toDelete: null });
  assert.equal('toDelete' in await getKeys(), false);
});

test('64-entry cap holds', async () => {
  const patch = {};
  for (let i = 0; i < 80; i++) patch[`k${i}`] = { key: String(i) };
  await setKeys(patch);
  assert.equal(Object.keys(await getKeys()).length, 64);
});

test('concurrent patches are serialized and retain both updates', async () => {
  await clearKeys();
  const [first, second] = await Promise.all([
    setKeys({ firstUpdate: { key: 'a' } }),
    setKeys({ secondUpdate: { key: 'b' } }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const keys = await getKeys();
  assert.deepEqual(keys.firstUpdate, { key: 'a' });
  assert.deepEqual(keys.secondUpdate, { key: 'b' });
});

test('UTF-16 string length matches JavaScript boundaries', async () => {
  await clearKeys();
  const accepted = await setKeys({ utf16Accepted: { key: '😀'.repeat(16) } });
  const rejected = await setKeys({ utf16Rejected: { key: '😀'.repeat(17) } });
  assert.equal(accepted.ok, true);
  assert.equal(rejected.ok, true);
  const keys = await getKeys();
  assert.equal(keys.utf16Accepted.key.length, 32);
  assert.equal('utf16Rejected' in keys, false);
});
