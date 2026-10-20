import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

// hooks.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { listHooks, searchHooks, readHook, writeHook, getHookRoots, setHookRoots } = await import('./hooks.mjs');
const { BACKUPS_DIR } = await import('./app-dir.mjs');

function makeRoot(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-hooks-'));
  const dir = join(cwd, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files || {})) writeFileSync(join(dir, name), content);
  return cwd;
}

function makeBackend() {
  const calls = [];
  return {
    calls,
    async hooksWrite(path, content, mtime, force) {
      calls.push({ path, content, mtime, force });
      writeFileSync(path, content);
      return { ok: true, mtime: statSync(path).mtimeMs };
    },
  };
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

test('writeHook writes a backup on second write; guard rejects non-hooks path', async () => {
  const cwd = makeRoot({ 'w.mjs': 'v1' });
  setHookRoots(['~', cwd]); // register cwd so guard's root-containment check allows it
  try {
    const p = join(cwd, '.claude', 'hooks', 'w.mjs');
    const backend = makeBackend();
    const first = await writeHook(p, 'v2', null, false, backend);
    assert.equal(first.ok, true);
    assert.equal(existsSync(first.backup), true);
    assert.equal(readFileSync(first.backup, 'utf8'), 'v1');
    const second = await writeHook(p, 'v3', null, false, backend);
    assert.equal(second.ok, true);
    assert.equal(existsSync(second.backup), true);
    assert.equal(readFileSync(second.backup, 'utf8'), 'v2');
    assert.deepEqual(backend.calls.map((call) => call.path), [p, p]);
    assert.deepEqual(Object.keys(second).sort(), ['backup', 'mtime', 'ok', 'path']);
    // Guard: a path outside .claude/hooks is rejected.
    const bad = await writeHook(join(cwd, 'evil.txt'), 'x', null, false, backend);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /bad path/);
    assert.equal(backend.calls.length, 2);
  } finally {
    setHookRoots(['~']); // restore default so later tests see a clean root list
  }
});

test('readHook reads back real hook content; missing file → exists:false', () => {
  const cwd = makeRoot({ 'r.mjs': 'hello world' });
  setHookRoots(['~', cwd]);
  try {
    const p = join(cwd, '.claude', 'hooks', 'r.mjs');
    const r = readHook(p);
    assert.equal(r.exists, true);
    assert.equal(r.content, 'hello world');
    // A path under .claude/hooks that doesn't exist → exists:false, empty content.
    const miss = readHook(join(cwd, '.claude', 'hooks', 'nope.mjs'));
    assert.equal(miss.exists, false);
    assert.equal(miss.content, '');
  } finally {
    setHookRoots(['~']);
  }
});

test('guard rejects a hooks-shaped path outside any configured hook root', async () => {
  const registered = makeRoot({ 'ok.mjs': 'v1' });
  const outside = makeRoot({ 'sneaky.mjs': 'v1' }); // valid .claude/hooks/ shape, but never registered
  setHookRoots(['~', registered]);
  try {
    const p = join(outside, '.claude', 'hooks', 'sneaky.mjs');
    const backend = makeBackend();
    const w = await writeHook(p, 'pwned', null, false, backend);
    assert.equal(w.ok, false);
    assert.match(w.error, /bad path/);
    assert.equal(readFileSync(p, 'utf8'), 'v1'); // untouched
    assert.equal(backend.calls.length, 0);
    const r = readHook(p);
    assert.equal(r.exists, false);
    assert.equal(r.error, 'bad path');
  } finally {
    setHookRoots(['~']);
  }
});

test('guard rejects traversal that climbs out of .claude/hooks (resolved, not raw)', async () => {
  const cwd = makeRoot({ 'w.mjs': 'v1' });
  const hooksDir = join(cwd, '.claude', 'hooks');
  // Raw string: contains the segment but climbs out via `..`. Built by hand (not
  // path.join, which would normalize `..` away and mask the bug).
  const evil = `${hooksDir}${sep}..${sep}..${sep}escape.txt`;
  const backend = makeBackend();
  const w = await writeHook(evil, 'x', null, false, backend);
  assert.equal(w.ok, false);
  assert.match(w.error, /bad path/);
  assert.equal(existsSync(join(cwd, 'escape.txt')), false); // nothing written outside
  assert.equal(backend.calls.length, 0);
  const r = readHook(evil);
  assert.equal(r.exists, false);
  assert.equal(r.error, 'bad path');
});

test('hook roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getHookRoots(), ['~']); // seeded default when file absent
  const r = setHookRoots(['~', '/a', '/a', '/b', 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, ['~', '/a', '/b']); // deduped, non-strings dropped
  assert.deepEqual(getHookRoots(), ['~', '/a', '/b']); // read back from disk
});

// mtime + 409 guard: readHook reports mtime; writeHook rejects stale mtime,
// force overrides. Mirror explorer.mjs writeEntry contract.
test('readHook returns mtime as a number', () => {
  const cwd = makeRoot({ 'm.mjs': 'v1' });
  setHookRoots(['~', cwd]);
  try {
    const p = join(cwd, '.claude', 'hooks', 'm.mjs');
    const r = readHook(p);
    assert.equal(r.exists, true);
    assert.equal(typeof r.mtime, 'number');
    assert.ok(r.mtime > 0);
    // Missing file → mtime 0.
    const miss = readHook(join(cwd, '.claude', 'hooks', 'nope.mjs'));
    assert.equal(miss.exists, false);
    assert.equal(miss.mtime, 0);
  } finally {
    setHookRoots(['~']);
  }
});

test('writeHook rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const cwd = makeRoot({ 'g.mjs': 'v1' });
  setHookRoots(['~', cwd]);
  try {
    const p = join(cwd, '.claude', 'hooks', 'g.mjs');
    // First write establishes a baseline mtime.
    const backend = makeBackend();
    await writeHook(p, 'v2', null, false, backend);
    const r = readHook(p);
    const stale = r.mtime;
    // Externally rewrite the file + bump mtime well past the 1ms guard window.
    writeFileSync(p, 'v-external');
    const future = (Date.now() + 5000) / 1000;
    utimesSync(p, future, future);
    // Stale mtime → refused, file untouched, no backup made.
    const rejected = await writeHook(p, 'v3', stale, false, backend);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'changed on disk');
    assert.equal(readFileSync(p, 'utf8'), 'v-external');
    assert.equal(backend.calls.length, 1); // only the initial save reached native
    // force:true overwrites despite the drift.
    const forced = await writeHook(p, 'v-forced', stale, true, backend);
    assert.equal(forced.ok, true);
    assert.equal(typeof forced.mtime, 'number');
    assert.equal(readFileSync(p, 'utf8'), 'v-forced');
  } finally {
    setHookRoots(['~']);
  }
});

test('writeHook permits empty and missing-target saves while surfacing native conflicts generically', async () => {
  const cwd = makeRoot({ 'prior.mjs': 'prior bytes' });
  setHookRoots(['~', cwd]);
  try {
    const path = join(cwd, '.claude', 'hooks', 'new.mjs');
    const backend = makeBackend();
    const empty = await writeHook(path, '', null, false, backend);
    assert.equal(empty.ok, true);
    assert.equal(empty.backup, null);
    assert.equal(readFileSync(path, 'utf8'), '');

    const existing = join(cwd, '.claude', 'hooks', 'prior.mjs');
    const result = await writeHook(existing, 'attempt', null, false, {
      hooksWrite: async () => ({ ok: false, error: 'changed on disk' }),
    });
    assert.deepEqual(result, { ok: false, error: 'changed on disk' });
    assert.equal(readFileSync(existing, 'utf8'), 'prior bytes');

    const errors = [];
    const failed = await writeHook(existing, 'attempt', null, false, {
      hooksWrite: async () => { throw new Error('private transport details'); },
    }, { error: (details) => errors.push(details.err) });
    assert.deepEqual(failed, { ok: false, error: 'hook write failed' });
    assert.deepEqual(errors, ['private transport details']);
    assert.equal(readFileSync(existing, 'utf8'), 'prior bytes');

    const beforeInvalidWrite = backend.calls.length;
    const invalid = await writeHook(existing, 42, null, false, backend);
    assert.deepEqual(invalid, { ok: false, error: 'content must be a string' });
    assert.equal(readFileSync(existing, 'utf8'), 'prior bytes');
    assert.equal(backend.calls.length, beforeInvalidWrite);
    assert.ok(invalid.backup === undefined);

    const invalidTarget = join(cwd, '.claude', 'hooks', 'isolated-invalid.mjs');
    const invalidPriorBytes = 'isolated prior Ω bytes';
    writeFileSync(invalidTarget, invalidPriorBytes);
    const invalidBackend = makeBackend();
    const backupDir = join(BACKUPS_DIR, createHash('sha256').update(invalidTarget).digest('hex').slice(0, 16));
    assert.equal(existsSync(backupDir), false);

    const stale = statSync(invalidTarget).mtimeMs - 5000;
    const staleInvalid = await writeHook(invalidTarget, 7, stale, false, invalidBackend);
    assert.deepEqual(staleInvalid, { ok: false, error: 'changed on disk' });
    assert.equal(readFileSync(invalidTarget, 'utf8'), invalidPriorBytes);
    assert.equal(invalidBackend.calls.length, 0);
    assert.equal(existsSync(backupDir), false);

    const matchingInvalid = await writeHook(invalidTarget, 7, statSync(invalidTarget).mtimeMs, false, invalidBackend);
    assert.deepEqual(matchingInvalid, { ok: false, error: 'content must be a string' });
    assert.equal(readFileSync(invalidTarget, 'utf8'), invalidPriorBytes);
    assert.equal(invalidBackend.calls.length, 0);
    const backups = readdirSync(backupDir).filter((file) => file.endsWith('.bak')).sort();
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(backupDir, backups[0]), 'utf8'), invalidPriorBytes);
  } finally {
    setHookRoots(['~']);
  }
});
