import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// hooks.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { listHooks, searchHooks, writeHook, getHookRoots, setHookRoots } = await import('./hooks.mjs');

function makeRoot(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-hooks-'));
  const dir = join(cwd, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) writeFileSync(join(dir, name), content);
  return cwd;
}

test('listHooks finds files and ignores a missing hooks dir', () => {
  const cwd = makeRoot({ 'a.mjs': 'console.log(1)', 'b.ps1': 'Write-Host x' });
  const files = listHooks(cwd).map((f) => f.name);
  assert.deepEqual(files, ['a.mjs', 'b.ps1']);
  // A dir with no .claude/hooks → [].
  const empty = mkdtempSync(join(tmpdir(), 'sing-hooks-empty-'));
  assert.deepEqual(listHooks(empty), []);
});

test('searchHooks returns matching line + snippet', () => {
  const cwd = makeRoot({ 'h.mjs': 'const a = 1\nconst needle = 2\n' });
  const hits = searchHooks([cwd], 'needle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].text, /needle/);
  assert.deepEqual(searchHooks([cwd], ''), []); // empty query → nothing
});

test('writeHook writes a .bak on second write; guard rejects non-hooks path', () => {
  const cwd = makeRoot({ 'w.mjs': 'v1' });
  const p = join(cwd, '.claude', 'hooks', 'w.mjs');
  const first = writeHook(p, 'v2');
  assert.equal(first.ok, true);
  assert.equal(existsSync(`${p}.bak`), true);
  const second = writeHook(p, 'v3');
  assert.equal(second.ok, true);
  assert.equal(second.backup, true);
  // Guard: a path outside .claude/hooks is rejected.
  const bad = writeHook(join(cwd, 'evil.txt'), 'x');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /bad path/);
});

test('hook roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getHookRoots(), ['~']); // seeded default when file absent
  const r = setHookRoots(['~', '/a', '/a', '/b', 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, ['~', '/a', '/b']); // deduped, non-strings dropped
  assert.deepEqual(getHookRoots(), ['~', '/a', '/b']); // read back from disk
});
