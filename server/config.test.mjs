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
const { createConfigRootsGetHandler, createConfigRootsSetHandler, setConfigRootsBackend, setConfigReadBackend } = await import('./config.mjs');
let storedRoots = ['~'];
const rootsBackend = {
  async pickerRootsGet() { return storedRoots.length ? structuredClone(storedRoots) : ['~']; },
  async pickerRootsSet(path, roots) {
    const clean = [...new Set((roots || []).filter((r) => typeof r === 'string' && r))].slice(0, 50);
    storedRoots = clean;
    return { ok: true, roots: clean };
  },
};
setConfigRootsBackend(rootsBackend);
setConfigReadBackend({
  async configRead(path) {
    const exists = existsSync(path);
    return { exists, content: exists ? readFileSync(path, 'utf8') : '', mtime: exists ? statSync(path).mtimeMs : 0 };
  },
  async configSearch(scans, q) {
    const hits = [];
    const seen = new Set();
    for (const { cwd, project, local } of scans) {
      try {
        for (const [scope, path] of [['project', project], ['local', local]]) {
          const file = await this.configRead(path);
          if (!file.content || seen.has(path)) continue;
          seen.add(path);
          const lines = file.content.split('\n');
          const i = lines.findIndex((line) => line.toLowerCase().includes(q));
          if (i >= 0) hits.push({ cwd, scope, path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      } catch {}
    }
    return hits.sort((a, b) => a.path.localeCompare(b.path));
  },
  async configScan(root, cap) {
    const hits = [];
    const stack = [root];
    const skips = new Set(['node_modules', 'dist', 'build', 'worktrees', '.cache', 'AppData', 'Temp']);
    let seen = 0;
    while (stack.length && seen < cap) {
      const dir = stack.pop(); seen++;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (entries.some((entry) => entry.name === '.claude') &&
          (existsSync(join(dir, '.claude', 'settings.json')) || existsSync(join(dir, '.claude', 'settings.local.json')))) hits.push(dir);
      for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && !skips.has(entry.name)) stack.push(join(dir, entry.name));
    }
    return { roots: hits.sort((a, b) => a.localeCompare(b)), truncated: seen >= cap };
  },
});

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

test('searchConfig matches content and reports scope + line', async () => {
  const cwd = makeRoot('{\n  "theme": "dark"\n}', null);
  const hits = await searchConfig([cwd], 'theme');
  const project = hits.find((h) => h.cwd === cwd && h.scope === 'project');
  assert.ok(project, 'project scope hit');
  assert.equal(project.line, 2);
  assert.match(project.text, /theme/);
});

test('searchConfig is case-insensitive and skips non-matches', async () => {
  const cwd = makeRoot('{ "model": "opus" }', '{ "other": 1 }');
  assert.equal((await searchConfig([cwd], 'MODEL')).some((h) => h.scope === 'project'), true);
  assert.equal((await searchConfig([cwd], 'model')).some((h) => h.scope === 'local'), false);
});

test('searchConfig dedups shared paths across repeated roots', async () => {
  const cwd = makeRoot('{ "theme": "dark" }', null);
  // Same root twice → project path seen once, not duplicated.
  const hits = await searchConfig([cwd, cwd], 'theme');
  assert.equal(hits.filter((h) => h.scope === 'project' && h.cwd === cwd).length, 1);
});

test('searchConfig empty query returns nothing', async () => {
  assert.deepEqual(await searchConfig(['/whatever'], ''), []);
});

test('findConfigRoots finds nested dirs holding .claude settings, skips others', async () => {
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

  const { roots, truncated } = await findConfigRoots(root);
  assert.equal(truncated, false);
  assert.deepEqual(roots, [join(root, 'nested', 'a'), join(root, 'nested', 'b', 'deep')]);
});

test('config roots use the async Rust adapter and preserve default, dedup, roundtrip', async () => {
  storedRoots = [];
  assert.deepEqual(await getConfigRoots(), ['~']); // seeded default when absent
  const r = await setConfigRoots(['~', '/a', '/a', '/b', 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, ['~', '/a', '/b']); // deduped, non-strings dropped
  assert.deepEqual(await getConfigRoots(), ['~', '/a', '/b']); // read back from bridge
});

test('config root handlers reuse Fastify routes and reject malformed or unavailable bridge responses', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  app.get('/config/roots', createConfigRootsGetHandler(rootsBackend));
  app.put('/config/roots', createConfigRootsSetHandler(rootsBackend));
  assert.deepEqual((await app.inject('/config/roots')).json(), { roots: ['~', '/a', '/b'] });
  assert.deepEqual((await app.inject({ method: 'PUT', url: '/config/roots', payload: { roots: false } })).json(), { ok: true, roots: [] });
  const malformed = await app.inject({ method: 'PUT', url: '/config/roots', payload: { roots: 'bad' } });
  assert.equal(malformed.statusCode, 500);
  assert.equal(malformed.json().message, '(roots || []).filter is not a function');
  await app.close();

  const unavailable = Fastify();
  unavailable.get('/config/roots', createConfigRootsGetHandler({ async pickerRootsGet() { throw new Error('bridge down'); } }));
  assert.equal((await unavailable.inject('/config/roots')).statusCode, 500);
  await unavailable.close();

  const storageFailure = Fastify();
  storageFailure.put('/config/roots', createConfigRootsSetHandler({ async pickerRootsSet() { return { ok: false, error: 'native IO failure' }; } }));
  const failed = await storageFailure.inject({ method: 'PUT', url: '/config/roots', payload: { roots: ['x'] } });
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(failed.json(), { ok: false, error: 'native IO failure' });
  await storageFailure.close();
});

test('readConfig reports mtime per scope (0 when file missing)', async () => {
  const cwd = makeRoot('{ "theme": "dark" }', null);
  await setConfigRoots([cwd]);
  const cfg = await readConfig(cwd);
  assert.equal(typeof cfg.project.mtime, 'number');
  assert.ok(cfg.project.mtime > 0);
  assert.equal(cfg.local.mtime, 0); // local scope file not created
});

test('writeConfig rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const cwd = makeRoot('{ "v": 1 }', null);
  await setConfigRoots([cwd]);
  const p = join(cwd, '.claude', 'settings.json');
  const stale = (await readConfig(cwd)).project.mtime;
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
  await setConfigRoots([cwd]);
  let writes = 0;
  const backend = writeBackend(() => writes++);

  assert.equal((await writeConfig(cwd, 'user', '{}', null, false, backend)).error, 'bad scope');
  assert.equal((await writeConfig(join(cwd, '..', 'outside'), 'project', '{}', null, false, backend)).error,
    'cwd outside config roots');
  assert.match((await writeConfig(cwd, 'project', '', null, false, backend)).error, /^invalid JSON:/);
  assert.equal(writes, 0);
});

test('writeConfig rejects picker bridge failure before config write dispatch', async () => {
  setConfigRootsBackend({ async pickerRootsGet() { throw new Error('picker bridge unavailable'); } });
  let writes = 0;
  try {
    await assert.rejects(writeConfig(mkdtempSync(join(tmpdir(), 'sing-cfg-bridge-')), 'project', '{}', null, false, {
      async configWrite() { writes++; return { ok: true }; },
    }), /picker bridge unavailable/);
    assert.equal(writes, 0);
  } finally { setConfigRootsBackend(rootsBackend); }
});

test('writeConfig creates the first project parent and returns the Config success shape', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cfg-first-write-'));
  await setConfigRoots([cwd]);
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
  await setConfigRoots([cwd]);
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
  await setConfigRoots([cwd]);
  const errors = [];
  const result = await writeConfig(cwd, 'local', '{}', null, false, {
    async configWrite() { throw new Error('pipe closed with detail'); },
  }, { error: (...args) => errors.push(args) });

  assert.deepEqual(result, { ok: false, error: 'config write backend unavailable' });
  assert.equal(errors[0][0].err, 'pipe closed with detail');
});
