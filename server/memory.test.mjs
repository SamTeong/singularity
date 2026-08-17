// Unit tests for the memory backend — path guard (isMemoryPath), FS-persisted
// root, and list/search/read/write against a scratch projects root.
// Run: npm test  (node --test server/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { contains } from './path-containment.mjs';

// memory.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { isMemoryPath, getMemoryRoot, setMemoryRoot, listFiles, searchMemory, readMemoryFile, writeMemoryFile } = await import('./memory.mjs');

// Scratch projects root: <ROOT>/proj/memory/*.md
const ROOT = mkdtempSync(join(tmpdir(), 'sing-memory-root-'));
const mem = (...parts) => join(ROOT, ...parts);
mkdirSync(mem('proj', 'memory'), { recursive: true });
writeFileSync(mem('proj', 'memory', 'a-fact.md'), 'line one\nfindme here\nline three');

test('memory root persists to FS: default, roundtrip, bad input', () => {
  assert.equal(getMemoryRoot(), '~/.claude/projects'); // default when file absent
  assert.deepEqual(setMemoryRoot(ROOT), { ok: true, root: ROOT });
  assert.equal(getMemoryRoot(), ROOT); // read back from disk
  assert.equal(setMemoryRoot('').ok, false); // rejects empty
});

// isMemoryPath only accepts a root matching server-persisted state (set
// above) — a caller-invented root (e.g. the drive root) must not pass just
// because it trivially "contains" the target path.
test('rejects a caller-supplied root that is not the persisted one, even the drive root', () => {
  const driveRoot = ROOT.slice(0, ROOT.indexOf(sep) + 1) || sep; // e.g. "C:\" or "/"
  const evil = join(homedir(), 'proj', 'memory', 'secret.md'); // shape-valid, outside ROOT
  assert.equal(isMemoryPath(evil, driveRoot), false);
  assert.equal(readMemoryFile(evil, driveRoot).ok, false);
});

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

// Direct coverage of the containment helper shared with wiki.mjs (extracted to
// path-containment.mjs) — a regression here must fail both callers, not just
// one, since traversal rejection is exactly the check that must never diverge.
test('contains: traversal rejected, in-root paths accepted', () => {
  assert.equal(contains(ROOT, mem('proj', 'memory', 'a-fact.md')), true); // in-root
  assert.equal(contains(ROOT, ROOT), true); // root itself
  assert.equal(contains(ROOT, join(ROOT, '..', 'escape.md')), false); // .. escape above root
  assert.equal(contains(ROOT, ROOT + '-evil'), false); // sibling with root as string prefix
  assert.equal(contains(ROOT, join(homedir(), 'evil.md')), false); // unrelated path
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

test('writeMemoryFile writes within the root, rejects outside it', async () => {
  const p = mem('proj', 'memory', 'a-fact.md');
  const w = await writeMemoryFile(p, 'updated content', ROOT);
  assert.equal(w.ok, true);
  assert.equal(typeof w.mtime, 'number');
  assert.equal(readMemoryFile(p, ROOT).content, 'updated content');

  const outside = await writeMemoryFile(join(homedir(), 'evil.md'), 'x', ROOT);
  assert.equal(outside.ok, false);
});

test('readMemoryFile reports mtime on success', () => {
  const p = mem('proj', 'memory', 'a-fact.md');
  const r = readMemoryFile(p, ROOT);
  assert.equal(r.ok, true);
  assert.equal(typeof r.mtime, 'number');
  assert.ok(r.mtime > 0);
});

test('writeMemoryFile rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const p = mem('proj', 'memory', 'g-fact.md');
  writeFileSync(p, 'v1');
  const stale = readMemoryFile(p, ROOT).mtime;
  // Externally rewrite + bump mtime past the 1ms guard window.
  writeFileSync(p, 'v-external');
  const future = (Date.now() + 5000) / 1000;
  utimesSync(p, future, future);
  const rejected = await writeMemoryFile(p, 'v2', ROOT, stale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'changed on disk');
  assert.equal(readFileSync(p, 'utf8'), 'v-external');
  // force overrides the drift.
  const forced = await writeMemoryFile(p, 'v-forced', ROOT, stale, true);
  assert.equal(forced.ok, true);
  assert.equal(typeof forced.mtime, 'number');
  assert.equal(readFileSync(p, 'utf8'), 'v-forced');
});
