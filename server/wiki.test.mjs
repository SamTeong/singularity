// Unit tests for the wiki path guard (isWikiPath) — the read-confinement
// boundary. Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isWikiPath } from './wiki.mjs';

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