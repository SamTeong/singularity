// Unit tests for the explorer backend — full-FS list/read/write/create/delete/
// rename + FS-persisted UI state. No containment guard (bad(p) only), so
// tests exercise real scratch dirs rather than a fenced root.
// Run: node --test server/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, utimesSync } from 'node:fs';

// explorer.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist above this assignment).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { listEntries, searchEntries, readEntry, writeEntry, createEntry, deleteEntry, renameEntry, getState, setState, rawEntry } = await import('./explorer.mjs');

const ROOT = mkdtempSync(join(tmpdir(), 'sing-explorer-'));
const p = (...parts) => join(ROOT, ...parts);

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

test('writeEntry: round-trip, creates missing parent dir', () => {
  const target = p('newdir', 'sub', 'f.txt');
  assert.equal(existsSync(target), false);
  assert.equal(writeEntry(target, 'content here').ok, true);
  assert.equal(readEntry(target).content, 'content here');
});

// The UI has no FS watcher, so a save carries the mtime it read — an external
// edit in between must be refused, not clobbered.
test('writeEntry: refuses a stale mtime, accepts force and a matching mtime', () => {
  writeFileSync(p('cond.txt'), 'v1');
  const opened = readEntry(p('cond.txt'));
  const ok = writeEntry(p('cond.txt'), 'v2', opened.mtime);
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(p('cond.txt'), 'utf8'), 'v2');

  writeFileSync(p('cond.txt'), 'notepad wrote this', { flush: true });
  utimesSync(p('cond.txt'), new Date(), new Date(opened.mtime + 5000)); // CI clock granularity can leave mtime unmoved
  const stale = writeEntry(p('cond.txt'), 'v3', opened.mtime);
  assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
  assert.equal(readFileSync(p('cond.txt'), 'utf8'), 'notepad wrote this'); // untouched

  assert.equal(writeEntry(p('cond.txt'), 'v3', opened.mtime, true).ok, true);
  assert.equal(readFileSync(p('cond.txt'), 'utf8'), 'v3');
  assert.equal(writeEntry(p('cond.txt'), 'v4').ok, true); // no mtime supplied → unconditional
});

test('createEntry: refuses existing path, creates dir and file', () => {
  writeFileSync(p('exists.txt'), 'x');
  assert.deepEqual(createEntry(p('exists.txt'), 'file'), { ok: false, error: 'already exists' });

  assert.deepEqual(createEntry(p('created-dir'), 'dir'), { ok: true });
  assert.equal(existsSync(p('created-dir')), true);

  assert.deepEqual(createEntry(p('created-file.txt'), 'file'), { ok: true });
  assert.equal(readEntry(p('created-file.txt')).content, '');
});

test('renameEntry: refuses existing target / missing source, works otherwise', () => {
  writeFileSync(p('from.txt'), 'x');
  writeFileSync(p('taken.txt'), 'y');
  assert.deepEqual(renameEntry(p('from.txt'), p('taken.txt')), { ok: false, error: 'already exists' });
  assert.deepEqual(renameEntry(p('nope.txt'), p('dest.txt')), { ok: false, error: 'not found' });
  assert.deepEqual(renameEntry(p('from.txt'), p('renamed.txt')), { ok: true });
  assert.equal(existsSync(p('renamed.txt')), true);
});

test('deleteEntry: removes a non-empty dir recursively, errors on missing', () => {
  mkdirSync(p('todelete', 'nested'), { recursive: true });
  writeFileSync(p('todelete', 'nested', 'f.txt'), 'x');
  assert.deepEqual(deleteEntry(p('todelete')), { ok: true });
  assert.equal(existsSync(p('todelete')), false);
  assert.deepEqual(deleteEntry(p('todelete')), { ok: false, error: 'not found' });
});

test('every mutating fn rejects bad paths: empty, null, relative', () => {
  for (const bad of ['', null, 'relative/path.txt']) {
    assert.equal(listEntries(bad).error, 'bad path');
    assert.equal(readEntry(bad).error, 'bad path');
    assert.equal(writeEntry(bad, 'x').error, 'bad path');
    assert.equal(createEntry(bad, 'file').error, 'bad path');
    assert.equal(deleteEntry(bad).error, 'bad path');
    assert.equal(renameEntry(bad, p('ok.txt')).error, 'bad path');
    assert.equal(renameEntry(p('ok.txt'), bad).error, 'bad path');
    assert.equal(rawEntry(bad).error, 'bad path');
  }
});

test('getState: default shape; setState: partial-merge round-trip', () => {
  assert.deepEqual(getState(), { root: '~', expanded: [], tabs: [], active: null, autosave: false });

  const r1 = setState({ root: '/tmp/foo', tabs: ['/a.txt'] });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.state, { root: '/tmp/foo', expanded: [], tabs: ['/a.txt'], active: null, autosave: false });
  assert.deepEqual(getState(), r1.state);

  const r2 = setState({ active: '/a.txt', autosave: true });
  assert.deepEqual(r2.state, { root: '/tmp/foo', expanded: [], tabs: ['/a.txt'], active: '/a.txt', autosave: true });
});
