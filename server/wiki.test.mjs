// Unit tests for the wiki path guard (isWikiPath) — the read-confinement
// boundary. Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

// wiki.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { isWikiPath, getWikiRoot, setWikiRoot } = await import('./wiki.mjs');

const ROOT = join(homedir(), 'wiki');
const w = (...parts) => join(ROOT, ...parts);

test('accepts a .md file under root, including nested', () => {
  assert.equal(isWikiPath(w('a.md'), ROOT), true);
  assert.equal(isWikiPath(w('notes', 'sub.md'), ROOT), true);
  assert.equal(isWikiPath(w('deep', 'path', 'page.md'), ROOT), true);
});

test('rejects non-.md, outside root, escapes, and empty', () => {
  assert.equal(isWikiPath(w('a.txt'), ROOT), false); // wrong ext
  assert.equal(isWikiPath(join(homedir(), 'evil.md'), ROOT), false); // outside root
  assert.equal(isWikiPath(w('..', '..', 'escape.md'), ROOT), false); // .. escape
  assert.equal(isWikiPath(w('A.MD'), ROOT), true); // case-insensitive ext
  assert.equal(isWikiPath('', ROOT), false);
  assert.equal(isWikiPath(null, ROOT), false);
  assert.equal(isWikiPath(w('a.md'), null), false); // no root
});

test('wiki root persists to FS: default, roundtrip, bad input', () => {
  assert.equal(getWikiRoot(), '~/wiki'); // default when file absent
  assert.deepEqual(setWikiRoot('~/notes'), { ok: true, root: '~/notes' });
  assert.equal(getWikiRoot(), '~/notes'); // read back from disk
  assert.equal(setWikiRoot('').ok, false); // rejects empty
});