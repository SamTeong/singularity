import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const { searchConfig, findConfigRoots, getConfigRoots, setConfigRoots, readConfig, writeConfig } = await import('./config.mjs');
const { BACKUPS_DIR } = await import('./app-dir.mjs');

function writeBackend(onWrite = () => {}) {
  return {
    async configWrite(path, content, mtime, force) {
      onWrite({ path, content, mtime, force });
      writeFileSync(path, content, 'utf8');
      return { ok: true, mtime: statSync(path).mtimeMs };
    },
  };
}

function makeRoot(project, local) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cfg-'));
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  if (project != null) writeFileSync(join(cwd, '.claude', 'settings.json'), project);
  if (local != null) writeFileSync(join(cwd, '.claude', 'settings.local.json'), local);
  return cwd;
}

test('searchConfig matches content and reports scope + line', () => {
  const cwd = makeRoot('{\n  "theme": "dark"\n}', null);
  const hits = searchConfig([cwd], 'theme');
  const project = hits.find((h) => h.cwd === cwd && h.scope === 'project');
  assert.ok(project, 'project scope hit');
  assert.equal(project.line, 2);
  assert.match(project.text, /theme/);
});

test('searchConfig is case-insensitive and skips non-matches', () => {
  const cwd = makeRoot('{ "model": "opus" }', '{ "other": 1 }');
  assert.equal(searchConfig([cwd], 'MODEL').some((h) => h.scope === 'project'), true);
  assert.equal(searchConfig([cwd], 'model').some((h) => h.scope === 'local'), false);
});

test('searchConfig dedups shared paths across repeated roots', () => {
  const cwd = makeRoot('{ "theme": "dark" }', null);
  // Same root twice → project path seen once, not duplicated.
  const hits = searchConfig([cwd, cwd], 'theme');
  assert.equal(hits.filter((h) => h.scope === 'project' && h.cwd === cwd).length, 1);
});

test('searchConfig empty query returns nothing', () => {
  assert.deepEqual(searchConfig(['/whatever'], ''), []);
});

test('findConfigRoots finds nested dirs holding .claude settings, skips others', () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-scan-'));
  // root itself: no .claude. nested/a has settings.json, nested/b/deep has local.
  mkdirSync(join(root, 'nested', 'a', '.claude'), { recursive: true });
  writeFileSync(join(root, 'nested', 'a', '.claude', 'settings.json'), '{}');
  mkdirSync(join(root, 'nested', 'b', 'deep', '.claude'), { recursive: true });
  writeFileSync(join(root, 'nested', 'b', 'deep', '.claude', 'settings.local.json'), '{}');
  // node_modules is skipped even with a matching config inside.
  mkdirSync(join(root, 'node_modules', 'pkg', '.claude'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', '.claude', 'settings.json'), '{}');
  // .claude dir with no settings file → not a hit.
  mkdirSync(join(root, 'empty', '.claude'), { recursive: true });

  const { roots, truncated } = findConfigRoots(root);
  assert.equal(truncated, false);
  assert.deepEqual(roots, [join(root, 'nested', 'a'), join(root, 'nested', 'b', 'deep')]);
});

test('config roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getConfigRoots(), ['~']); // seeded default when file absent
  const r = setConfigRoots(['~', '/a', '/a', '/b', 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, ['~', '/a', '/b']); // deduped, non-strings dropped
  assert.deepEqual(getConfigRoots(), ['~', '/a', '/b']); // read back from disk
});

test('readConfig reports mtime per scope (0 when file missing)', () => {
  const cwd = makeRoot('{ "theme": "dark" }', null);
  setConfigRoots([cwd]);
  const cfg = readConfig(cwd);
  assert.equal(typeof cfg.project.mtime, 'number');
  assert.ok(cfg.project.mtime > 0);
  assert.equal(cfg.local.mtime, 0); // local scope file not created
});

test('writeConfig rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const cwd = makeRoot('{ "v": 1 }', null);
  setConfigRoots([cwd]);
  const p = join(cwd, '.claude', 'settings.json');
  const stale = readConfig(cwd).project.mtime;
  let writes = 0;
  const backend = writeBackend(() => writes++);
  // Externally rewrite + bump mtime past the 1ms guard window.
  writeFileSync(p, '{ "v": 99 }');
  const future = (Date.now() + 5000) / 1000;
  utimesSync(p, future, future);
  const rejected = await writeConfig(cwd, 'project', '{ "v": 2 }', stale, false, backend);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'changed on disk');
  assert.equal(writes, 0); // pre-backup check stops before backend dispatch
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).v, 99); // untouched
  // force overrides the drift.
  const forced = await writeConfig(cwd, 'project', '{ "v": 3 }', stale, true, backend);
  assert.equal(forced.ok, true);
  assert.equal(typeof forced.mtime, 'number');
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).v, 3);
});

test('writeConfig rejects forbidden scopes, roots, and invalid JSON before backend dispatch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cfg-policy-'));
  setConfigRoots([cwd]);
  let writes = 0;
  const backend = writeBackend(() => writes++);

  assert.equal((await writeConfig(cwd, 'user', '{}', null, false, backend)).error, 'bad scope');
  assert.equal((await writeConfig(join(cwd, '..', 'outside'), 'project', '{}', null, false, backend)).error,
    'cwd outside config roots');
  assert.match((await writeConfig(cwd, 'project', '', null, false, backend)).error, /^invalid JSON:/);
  assert.equal(writes, 0);
});

test('writeConfig creates the first project parent and returns the Config success shape', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cfg-first-write-'));
  setConfigRoots([cwd]);
  const p = join(cwd, '.claude', 'settings.json');
  const saved = await writeConfig(cwd, 'project', '{"theme":"更新 ✓"}', null, false, writeBackend(({ path }) => {
    assert.equal(path, p);
    assert.equal(existsSync(join(cwd, '.claude')), true);
  }));

  assert.deepEqual(Object.keys(saved).sort(), ['backup', 'mtime', 'ok', 'path']);
  assert.equal(saved.ok, true);
  assert.equal(saved.backup, null);
  assert.equal(saved.path, p);
  assert.equal(typeof saved.mtime, 'number');
  assert.equal(readFileSync(p, 'utf8'), '{"theme":"更新 ✓"}');
});

test('writeConfig copies exact prior bytes into a hashed backup before backend replacement', async () => {
  const prior = '{"before":"exact bytes ✓"}\n';
  const cwd = makeRoot(prior, null);
  setConfigRoots([cwd]);
  const p = join(cwd, '.claude', 'settings.json');
  const backupDir = join(BACKUPS_DIR, createHash('sha256').update(p).digest('hex').slice(0, 16));
  const before = existsSync(backupDir) ? new Set(readdirSync(backupDir)) : new Set();
  const saved = await writeConfig(cwd, 'project', '{"after":true}', null, false, writeBackend(() => {
    const fresh = readdirSync(backupDir).filter((name) => !before.has(name) && name.endsWith('.bak'));
    assert.equal(fresh.length, 1);
    assert.equal(readFileSync(join(backupDir, fresh[0]), 'utf8'), prior);
  }));

  assert.equal(saved.ok, true);
  assert.ok(saved.backup);
  assert.equal(readFileSync(saved.backup, 'utf8'), prior);
  assert.equal(readFileSync(p, 'utf8'), '{"after":true}');
});

test('writeConfig masks backend transport failures and logs diagnostic details', async () => {
  const cwd = makeRoot(null, null);
  setConfigRoots([cwd]);
  const errors = [];
  const result = await writeConfig(cwd, 'local', '{}', null, false, {
    async configWrite() { throw new Error('pipe closed with detail'); },
  }, { error: (...args) => errors.push(args) });

  assert.deepEqual(result, { ok: false, error: 'config write backend unavailable' });
  assert.equal(errors[0][0].err, 'pipe closed with detail');
});
