// Unit tests for the Node-owned wiki root preference and page authorization boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { isWikiPath, getWikiRoot, setWikiRoot } = await import('./wiki.mjs');

const ROOT = join(homedir(), 'wiki');
const wikiPath = (...parts) => join(ROOT, ...parts);

test('accepts Markdown paths under the persisted root, including nested paths', () => {
  setWikiRoot(ROOT);
  assert.equal(isWikiPath(wikiPath('a.md'), ROOT), true);
  assert.equal(isWikiPath(wikiPath('notes', 'sub.md'), ROOT), true);
  assert.equal(isWikiPath(wikiPath('A.MD'), ROOT), true);
});

test('rejects wrong extensions, outside paths, lexical escapes, and missing arguments', () => {
  setWikiRoot(ROOT);
  assert.equal(isWikiPath(wikiPath('a.txt'), ROOT), false);
  assert.equal(isWikiPath(join(homedir(), 'evil.md'), ROOT), false);
  assert.equal(isWikiPath(wikiPath('..', '..', 'escape.md'), ROOT), false);
  assert.equal(isWikiPath('', ROOT), false);
  assert.equal(isWikiPath(null, ROOT), false);
  assert.equal(isWikiPath(wikiPath('a.md'), null), false);
});

test('rejects a caller root that differs from the persisted root', () => {
  setWikiRoot(ROOT);
  const driveRoot = ROOT.slice(0, ROOT.indexOf(sep) + 1) || sep;
  assert.equal(isWikiPath(join(homedir(), 'secret.md'), driveRoot), false);
});

test('wiki root preference persists, defaults, and rejects an empty value', () => {
  assert.equal(setWikiRoot('~/notes').ok, true);
  assert.equal(getWikiRoot(), '~/notes');
  assert.equal(setWikiRoot('').ok, false);
});
