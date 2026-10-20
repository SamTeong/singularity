// Unit tests for the explorer backend — full-FS list/read/write/create/delete/
// Explorer filesystem behavior. No containment guard (bad(p) only), so tests
// exercise real scratch dirs rather than a fenced root.
// Run: node --test server/
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync, rmSync, lstatSync, readdirSync } from 'node:fs';

// Keep the filesystem fixture isolated from any user files.
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { BACKUPS_DIR } = await import('./app-dir.mjs');
const { listEntries, searchEntries, readEntry, writeEntry, createEntry, deleteEntry, renameEntry, rawEntry, setExplorerBackend } = await import('./explorer.mjs');
const explorerBackend = (await import('./rust-backend.mjs')).createRustBackend();
await explorerBackend.start();
setExplorerBackend(explorerBackend);
after(() => explorerBackend.stop());

const ROOT = mkdtempSync(join(tmpdir(), 'sing-explorer-'));
const p = (...parts) => join(ROOT, ...parts);
function backupArtifacts(target) {
  const key = createHash('sha256').update(target).digest('hex').slice(0, 16);
  const dir = join(BACKUPS_DIR, key);
  return new Map((existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => name.endsWith('.bak'))
    .map((name) => [name, readFileSync(join(dir, name))]));
}
function assertOneFreshBackup(before, after, expectedBytes) {
  assert.equal(after.size, before.size + 1);
  const added = [...after].filter(([name]) => !before.has(name));
  assert.equal(added.length, 1);
  assert.deepEqual(added[0][1], Buffer.from(expectedBytes));
}

test('listEntries: dirs before files, alpha within each group, dotfiles included, parent', () => {
  mkdirSync(p('list', 'zdir'), { recursive: true });
  mkdirSync(p('list', 'adir'), { recursive: true });
  writeFileSync(p('list', 'bfile.txt'), 'x');
  writeFileSync(p('list', '.dotfile'), 'x');
  const r = listEntries(p('list'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries.map((e) => e.name), ['adir', 'zdir', '.dotfile', 'bfile.txt']);
  assert.equal(r.entries[0].type, 'dir');
  assert.equal(r.entries[2].type, 'file');
  assert.equal(r.parent, p());
});
// Junctions are how ~/.agents + ~/.claude/skills are wired, and Dirent (lstat)
// calls them neither dir nor file — listEntries must stat through the link.
test('listEntries: a junction to a dir is typed dir, a broken link is skipped', () => {
  mkdirSync(p('link', 'target'), { recursive: true });
  writeFileSync(p('link', 'target', 'inside.txt'), 'x');
  symlinkSync(p('link', 'target'), p('link', 'jdir'), 'junction');
  symlinkSync(p('link', 'gone'), p('link', 'broken'), 'junction');
  const r = listEntries(p('link'));
  assert.deepEqual(r.entries.map((e) => [e.name, e.type]), [['jdir', 'dir'], ['target', 'dir']]);
  assert.equal(listEntries(p('link', 'jdir')).entries[0].name, 'inside.txt');
});

test('searchEntries: recursive name match on files + dirs, skips node_modules, empty term', async () => {
  mkdirSync(p('s', 'deep', 'nest'), { recursive: true });
  mkdirSync(p('s', 'node_modules', 'needle-pkg'), { recursive: true });
  writeFileSync(p('s', 'deep', 'nest', 'needle.txt'), 'x');
  writeFileSync(p('s', 'haystack.txt'), 'needle');           // content is never searched
  mkdirSync(p('s', 'needle-dir'), { recursive: true });
  const r = await searchEntries(p('s'), 'NEEDLE');           // case-insensitive
  assert.deepEqual(r.results.map((e) => [e.name, e.type]).sort(), [['needle-dir', 'dir'], ['needle.txt', 'file']]);
  assert.equal(r.capped, false);
  assert.deepEqual(await searchEntries(p('s'), '  '), { ok: true, results: [], capped: false });
  assert.equal((await searchEntries('relative', 'x')).error, 'bad path');
});

test('readEntry: text, image (by ext), binary (NUL byte), toolarge', () => {
  writeFileSync(p('t.txt'), 'hello world');
  const txt = readEntry(p('t.txt'));
  assert.deepEqual({ ...txt, mtime: undefined }, { ok: true, kind: 'text', size: 11, content: 'hello world', mtime: undefined });
  assert.equal(typeof txt.mtime, 'number');

  writeFileSync(p('pic.png'), Buffer.from([1, 2, 3]));
  const img = readEntry(p('pic.png'));
  assert.equal(img.ok, true);
  assert.equal(img.kind, 'image');
  assert.equal(img.content, undefined);

  writeFileSync(p('bin.dat'), Buffer.from([1, 0, 2]));
  assert.equal(readEntry(p('bin.dat')).kind, 'binary');

  writeFileSync(p('big.dat'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal(readEntry(p('big.dat')).kind, 'toolarge');

  assert.deepEqual(readEntry(p('missing.txt')), { ok: false, error: 'not found' });
});

test('writeEntry: round-trip, creates missing parent dir', async () => {
  const target = p('newdir', 'sub', 'f.txt');
  assert.equal(existsSync(target), false);
  assert.equal((await writeEntry(target, 'content here')).ok, true);
  assert.equal(readEntry(target).content, 'content here');
});

// The UI has no FS watcher, so a save carries the mtime it read — an external
// edit in between must be refused, not clobbered.
test('writeEntry: refuses a stale mtime, accepts force and a matching mtime', async () => {
  writeFileSync(p('cond.txt'), 'v1');
  const opened = readEntry(p('cond.txt'));
  const ok = await writeEntry(p('cond.txt'), 'v2', opened.mtime);
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(p('cond.txt'), 'utf8'), 'v2');

  writeFileSync(p('cond.txt'), 'notepad wrote this', { flush: true });
  utimesSync(p('cond.txt'), new Date(), new Date(opened.mtime + 5000)); // CI clock granularity can leave mtime unmoved
  const stale = await writeEntry(p('cond.txt'), 'v3', opened.mtime);
  assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
  assert.equal(readFileSync(p('cond.txt'), 'utf8'), 'notepad wrote this'); // untouched

  assert.equal((await writeEntry(p('cond.txt'), 'v3', opened.mtime, true)).ok, true);
  assert.equal(readFileSync(p('cond.txt'), 'utf8'), 'v3');
  assert.equal((await writeEntry(p('cond.txt'), 'v4')).ok, true); // no mtime supplied → unconditional
});

// Regression test for the sync->async conversion's TOCTOU: the mtime/force
// guard used to run once, then the function awaited backupFile + writeFile —
// a write landing in that gap (autosave racing a manual save) slipped past
// the guard and got silently clobbered. The synchronous mutation below lands
// in the same tick as writeEntry's own synchronous prefix (mtime check +
// mkdirSync), before backupFile's first internal await settles, so it's
// guaranteed to land "during" the awaited gap rather than racing against
// real wall-clock timing.
test("writeEntry: a write landing during backupFile's await is caught by the recheck, not clobbered", async () => {
  writeFileSync(p('race.txt'), 'v1');
  const opened = readEntry(p('race.txt'));
  const pending = writeEntry(p('race.txt'), 'stale-writer', opened.mtime); // not awaited yet
  writeFileSync(p('race.txt'), 'concurrent writer', { flush: true });
  utimesSync(p('race.txt'), new Date(), new Date(opened.mtime + 5000)); // CI clock granularity can leave mtime unmoved
  const result = await pending;
  assert.deepEqual(result, { ok: false, error: 'changed on disk' });
  assert.equal(readFileSync(p('race.txt'), 'utf8'), 'concurrent writer'); // untouched by the stale writer
});

test('writeEntry: successful overwrite creates one fresh backup with the exact prior bytes', async () => {
  const target = p('backup-success-unique.txt');
  const prior = 'prior-success-bytes';
  writeFileSync(target, prior);
  const before = backupArtifacts(target);
  const result = await writeEntry(target, 'replacement');
  const after = backupArtifacts(target);
  assert.equal(result.ok, true);
  assertOneFreshBackup(before, after, prior);
  assert.equal(readFileSync(target, 'utf8'), 'replacement');
});

test('writeEntry: matching-mtime invalid content backs up existing bytes before rejection', async () => {
  const target = p('backup-invalid-unique.txt');
  const prior = 'prior-invalid-bytes';
  writeFileSync(target, prior);
  const opened = readEntry(target);
  const before = backupArtifacts(target);
  const result = await writeEntry(target, 17, opened.mtime);
  const after = backupArtifacts(target);
  assert.deepEqual(result, { ok: false, error: 'content must be a string' });
  assertOneFreshBackup(before, after, prior);
  assert.equal(readFileSync(target, 'utf8'), prior);
});

test('writeEntry: initially stale target rejects before creating a backup', async () => {
  const target = p('backup-stale-unique.txt');
  const prior = 'prior-stale-bytes';
  writeFileSync(target, prior);
  const before = backupArtifacts(target);
  const result = await writeEntry(target, 'rejected', 0);
  const after = backupArtifacts(target);
  assert.deepEqual(result, { ok: false, error: 'changed on disk' });
  assert.deepEqual([...after.keys()], [...before.keys()]);
  assert.equal(readFileSync(target, 'utf8'), prior);
});

test('writeEntry: backup completes with prior bytes before queued stale rejection returns 409', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  const target = p('backup-race-unique.txt');
  const prior = 'prior-race-bytes';
  writeFileSync(target, prior);
  const opened = readEntry(target);
  const before = backupArtifacts(target);
  let enterQueuedWrite;
  let releaseQueuedWrite;
  const queuedWriteEntered = new Promise((resolve) => { enterQueuedWrite = resolve; });
  const queuedWriteGate = new Promise((resolve) => { releaseQueuedWrite = resolve; });
  setExplorerBackend({
    async explorerWrite(...args) {
      enterQueuedWrite();
      await queuedWriteGate;
      return explorerBackend.explorerWrite(...args);
    },
  });
  app.put('/fs/write', async (req, reply) => {
    const { path, content, mtime, force } = req.body || {};
    const result = await writeEntry(path, content, mtime, force);
    if (!result.ok) reply.code(result.error === 'changed on disk' ? 409 : 400);
    return result;
  });
  try {
    const pending = app.inject({ method: 'PUT', url: '/fs/write', payload: { path: target, content: 'rejected', mtime: opened.mtime } });
    await queuedWriteEntered;
    const afterBackup = backupArtifacts(target);
    assertOneFreshBackup(before, afterBackup, prior);
    writeFileSync(target, 'concurrent external bytes', { flush: true });
    utimesSync(target, new Date(), new Date(opened.mtime + 5000));
    releaseQueuedWrite();
    const response = await pending;
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { ok: false, error: 'changed on disk' });
    assert.equal(readFileSync(target, 'utf8'), 'concurrent external bytes');
  } finally {
    releaseQueuedWrite();
    setExplorerBackend(explorerBackend);
    await app.close();
  }
});

// Regression test for the exact breakage this ticket's async conversion risked:
// index.mjs's PUT /api/fs/write does `const r = await writeEntry(...)` then
// `if (!r.ok) reply.code(r.error === 'changed on disk' ? 409 : 400)`. Before the
// `await` was added, writeEntry (now async) handed back a pending Promise —
// `r.ok` read undefined, so reply.code(400) fired unconditionally regardless of
// outcome, which breaks ExplorerPanel.jsx's "file changed underneath us" dialog
// (it keys off a real HTTP 409). This mounts the same handler shape as index.mjs
// (post-fix) and asserts the status code a real client would see.
test('HTTP route shape: an awaited writeEntry reports 409 on conflict, 200 on success', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  app.put('/fs/write', async (req, reply) => {
    const { path, content, mtime, force } = req.body || {};
    const r = await writeEntry(path, content, mtime, force);
    if (!r.ok) reply.code(r.error === 'changed on disk' ? 409 : 400);
    return r;
  });

  const target = p('http-cond.txt');
  writeFileSync(target, 'v1');
  const opened = readEntry(target);
  writeFileSync(target, 'notepad wrote this', { flush: true });
  utimesSync(target, new Date(), new Date(opened.mtime + 5000));

  const conflict = await app.inject({ method: 'PUT', url: '/fs/write', payload: { path: target, content: 'v2', mtime: opened.mtime } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).error, 'changed on disk');

  const ok = await app.inject({ method: 'PUT', url: '/fs/write', payload: { path: target, content: 'v2', mtime: opened.mtime, force: true } });
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  await app.close();
});

test('createEntry: refuses existing path, creates dir and file', async () => {
  writeFileSync(p('exists.txt'), 'x');
  assert.deepEqual(await createEntry(p('exists.txt'), 'file'), { ok: false, error: 'already exists' });

  assert.deepEqual(await createEntry(p('created-dir'), 'dir'), { ok: true });
  assert.equal(existsSync(p('created-dir')), true);

  assert.deepEqual(await createEntry(p('created-file.txt'), 'file'), { ok: true });
  assert.equal(readEntry(p('created-file.txt')).content, '');
});

test('renameEntry: refuses existing target / missing source, works otherwise', async () => {
  writeFileSync(p('from.txt'), 'x');
  writeFileSync(p('taken.txt'), 'y');
  assert.deepEqual(await renameEntry(p('from.txt'), p('taken.txt')), { ok: false, error: 'already exists' });
  assert.deepEqual(await renameEntry(p('nope.txt'), p('dest.txt')), { ok: false, error: 'not found' });
  assert.deepEqual(await renameEntry(p('from.txt'), p('renamed.txt')), { ok: true });
  assert.equal(existsSync(p('renamed.txt')), true);
});

test('deleteEntry: removes a non-empty dir recursively, errors on missing', async () => {
  mkdirSync(p('todelete', 'nested'), { recursive: true });
  writeFileSync(p('todelete', 'nested', 'f.txt'), 'x');
  assert.deepEqual(await deleteEntry(p('todelete')), { ok: true });
  assert.equal(existsSync(p('todelete')), false);
  assert.deepEqual(await deleteEntry(p('todelete')), { ok: false, error: 'not found' });
});

test('deleteEntry: matches Node directory-link removal and leaves dangling links untouched', async (t) => {
  mkdirSync(p('link-target', 'nested'), { recursive: true });
  writeFileSync(p('link-target', 'nested', 'safe.txt'), 'keep');
  try {
    symlinkSync(p('link-target'), p('node-link'), 'junction');
    symlinkSync(p('link-target'), p('rust-link'), 'junction');
    symlinkSync(p('missing-link-target'), p('dangling-link'), 'junction');
  } catch (error) {
    t.skip(`directory links unavailable: ${error.code || error.message}`);
    return;
  }

  rmSync(p('node-link'), { recursive: true });
  assert.equal(readFileSync(p('link-target', 'nested', 'safe.txt'), 'utf8'), 'keep');
  assert.deepEqual(await deleteEntry(p('rust-link')), { ok: true });
  assert.equal(readFileSync(p('link-target', 'nested', 'safe.txt'), 'utf8'), 'keep');
  assert.deepEqual(await deleteEntry(p('dangling-link')), { ok: false, error: 'not found' });
  assert.equal(lstatSync(p('dangling-link')).isSymbolicLink(), true);
});

test('writeEntry: creates parents before native content failure and stale check wins', async () => {
  const invalid = await writeEntry(p('invalid-parent', 'bad.txt'), 17);
  assert.equal(invalid.ok, false);
  assert.equal(existsSync(p('invalid-parent')), true);

  writeFileSync(p('stale-type.txt'), 'prior');
  const opened = readEntry(p('stale-type.txt'));
  writeFileSync(p('stale-type.txt'), 'changed externally', { flush: true });
  utimesSync(p('stale-type.txt'), new Date(), new Date(opened.mtime + 5000));
  assert.deepEqual(await writeEntry(p('stale-type.txt'), 17, opened.mtime), { ok: false, error: 'changed on disk' });
  assert.equal(readFileSync(p('stale-type.txt'), 'utf8'), 'changed externally');
});

test('every mutating fn rejects bad paths: empty, null, relative', async () => {
  for (const bad of ['', null, 'relative/path.txt']) {
    assert.equal(listEntries(bad).error, 'bad path');
    assert.equal(readEntry(bad).error, 'bad path');
    assert.equal((await writeEntry(bad, 'x')).error, 'bad path');
    assert.equal((await createEntry(bad, 'file')).error, 'bad path');
    assert.equal((await deleteEntry(bad)).error, 'bad path');
    assert.equal((await renameEntry(bad, p('ok.txt'))).error, 'bad path');
    assert.equal((await renameEntry(p('ok.txt'), bad)).error, 'bad path');
    assert.equal(rawEntry(bad).error, 'bad path');
  }
});
