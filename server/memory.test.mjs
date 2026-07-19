// Unit tests for the memory backend — path guard (isMemoryPath), FS-persisted
// root, and list/search/read/write against a scratch projects root.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

// memory.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { isMemoryPath, getMemoryRoot, setMemoryRoot, listFiles, searchMemory, readMemoryFile, writeMemoryFile } = await import('./memory.mjs');

// Scratch projects root: <ROOT>/proj/memory/*.md
const ROOT = mkdtempSync(join(tmpdir(), 'sing-memory-root-'));
const mem = (...parts) => join(ROOT, ...parts);
mkdirSync(mem('proj', 'memory'), { recursive: true });
writeFileSync(mem('proj', 'memory', 'a-fact.md'), 'line one\nfindme here\nline three');

test('accepts a .md file directly under a project memory/ dir', () => {
  assert.equal(isMemoryPath(mem('proj', 'memory', 'a-fact.md'), ROOT), true);
  assert.equal(isMemoryPath(mem('proj', 'memory', 'sub', 'nested.md'), ROOT), true);
});

test('rejects non-.md, non-memory dirs, escapes, and empty', () => {
  assert.equal(isMemoryPath(mem('proj', 'memory', 'a.txt'), ROOT), false); // wrong ext
  assert.equal(isMemoryPath(mem('proj', 'notes', 'a.md'), ROOT), false); // not memory/
  assert.equal(isMemoryPath(mem('proj', 'a.md'), ROOT), false); // no memory/ segment
  assert.equal(isMemoryPath(mem('memory', 'a.md'), ROOT), false); // missing project segment
  assert.equal(isMemoryPath(join(homedir(), 'evil.md'), ROOT), false); // outside root
  assert.equal(isMemoryPath(mem('proj', 'memory', '..', '..', 'escape.md'), ROOT), false);
  assert.equal(isMemoryPath('', ROOT), false);
  assert.equal(isMemoryPath(null, ROOT), false);
});

test('memory root persists to FS: default, roundtrip, bad input', () => {
  assert.equal(getMemoryRoot(), '~/.claude/projects'); // default when file absent
  assert.deepEqual(setMemoryRoot(ROOT), { ok: true, root: ROOT });
  assert.equal(getMemoryRoot(), ROOT); // read back from disk
  assert.equal(setMemoryRoot('').ok, false); // rejects empty
});

test('listFiles finds .md files under the given root', () => {
  const files = listFiles(ROOT);
  assert.equal(files.length, 1);
  assert.equal(files[0].project, 'proj');
  assert.equal(files[0].file, 'a-fact.md');
});

test('searchMemory finds a matching line under the given root', () => {
  const { results } = searchMemory('findme', ROOT);
  assert.equal(results.length, 1);
  assert.equal(results[0].text, 'findme here');
});

test('readMemoryFile reads a file within the root, rejects outside it', () => {
  const p = mem('proj', 'memory', 'a-fact.md');
  const r = readMemoryFile(p, ROOT);
  assert.equal(r.ok, true);
  assert.match(r.content, /findme here/);

  const outside = readMemoryFile(join(homedir(), 'evil.md'), ROOT);
  assert.equal(outside.ok, false);
});

test('writeMemoryFile writes within the root, rejects outside it', () => {
  const p = mem('proj', 'memory', 'a-fact.md');
  assert.deepEqual(writeMemoryFile(p, 'updated content', ROOT), { ok: true });
  assert.equal(readMemoryFile(p, ROOT).content, 'updated content');

  const outside = writeMemoryFile(join(homedir(), 'evil.md'), 'x', ROOT);
  assert.equal(outside.ok, false);
});
