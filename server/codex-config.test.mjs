import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// codex-config.mjs imports app-dir.mjs (STATE_DIR), which throws without
// SINGULARITY_HOME. Point it at a scratch temp dir before a dynamic import
// (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
process.env.CODEX_HOME = join(process.env.SINGULARITY_HOME, 'codex-home');
const { readConfig, searchConfig, findConfigRoots, getConfigRoots, setConfigRoots, writeConfig, createConfigRootsGetHandler, createConfigRootsSetHandler, setConfigRootsBackend, setCodexConfigReadBackend } = await import('./codex-config.mjs');
let storedRoots = ['~'];
const rootsBackend = {
  pickerRootsGet() { return storedRoots.length ? structuredClone(storedRoots) : ['~']; },
  pickerRootsSet(path, roots) {
    const clean = [...new Set((roots || []).filter((r) => typeof r === 'string' && r))].slice(0, 50);
    storedRoots = clean;
    return { ok: true, roots: clean };
  },
};
setConfigRootsBackend(rootsBackend);

const testBackend = {
  async codexConfigRead(path) {
    const exists = existsSync(path);
    return { exists, content: exists ? readFileSync(path, 'utf8') : '', mtime: exists ? statSync(path).mtimeMs : 0 };
  },
  async codexConfigSearch(roots, q) {
    const hits = [];
    const seen = new Set();
    for (const { cwd, project, user } of roots) for (const [scope, path] of [['project', project], ['user', user]]) {
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      const lines = readFileSync(path, 'utf8').split('\n');
      const i = lines.findIndex((line) => line.toLowerCase().includes(q.toLowerCase()));
      if (i >= 0) hits.push({ cwd, scope, path, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
    return hits.sort((a, b) => a.path.localeCompare(b.path));
  },
  async codexConfigWrite(path, content) {
    if (typeof content !== 'string') return { ok: false, error: 'content must be a string' };
    writeFileSync(path, content);
    return { ok: true, mtime: statSync(path).mtimeMs };
  },
};
setCodexConfigReadBackend(testBackend);

async function makeRoot(toml) {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cdx-'));
  mkdirSync(join(cwd, '.codex'), { recursive: true });
  if (toml != null) writeFileSync(join(cwd, '.codex', 'config.toml'), toml);
  await setConfigRoots([cwd]); // reads/writes are gated by isKnownConfigRoot
  return cwd;
}

test('codex config roots forward the fixed state file and the raw roots to the Rust adapter', async () => {
  const calls = [];
  const backend = {
    async pickerRootsGet(path) { calls.push(['get', path]); return ['~']; },
    async pickerRootsSet(path, roots) { calls.push(['set', path, roots]); return { ok: true, roots }; },
  };
  assert.deepEqual(await getConfigRoots(backend), ['~']);
  assert.deepEqual(await setConfigRoots(['/a', 123], backend), { ok: true, roots: ['/a', 123] });
  const file = join(process.env.SINGULARITY_HOME, 'state', 'codex-config-roots.json');
  assert.deepEqual(calls, [['get', file], ['set', file, ['/a', 123]]]);
});

test('codex root handlers preserve route responses and reject bridge failure', async () => {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  app.get('/codex-config/roots', createConfigRootsGetHandler(rootsBackend));
  app.put('/codex-config/roots', createConfigRootsSetHandler(rootsBackend));
  assert.deepEqual((await app.inject('/codex-config/roots')).json(), { roots: ['~'] });
  const saved = await app.inject({ method: 'PUT', url: '/codex-config/roots', payload: { roots: null } });
  assert.deepEqual(saved.json(), { ok: true, roots: [] });
  await app.close();
  const failed = Fastify();
  failed.get('/codex-config/roots', createConfigRootsGetHandler({ async pickerRootsGet() { throw new Error('bridge down'); } }));
  assert.equal((await failed.inject('/codex-config/roots')).statusCode, 500);
  await failed.close();
});

test('searchConfig empty query returns nothing', async () => {
  assert.deepEqual(await searchConfig(['/whatever'], ''), []);
});

// Matching, case folding, dedup and the scan walk live in Rust (rust-backend.test.mjs
// "Codex config read, search, and scan use the Rust stdio bridge"); Node gates
// roots, resolves scope paths and forwards.
test('searchConfig forwards pinned scope paths and the lowercased query; findConfigRoots forwards root and cap', async () => {
  const cwd = await makeRoot('theme = "dark"\n');
  const calls = [];
  setCodexConfigReadBackend({
    async codexConfigSearch(roots, q) { calls.push(['search', roots, q]); return []; },
    async codexConfigScan(root, cap) { calls.push(['scan', root, cap]); return { roots: [], truncated: false }; },
  });
  try {
    await searchConfig([cwd], 'THEME');
    await findConfigRoots(cwd, 7);
  } finally { setCodexConfigReadBackend(testBackend); }
  assert.deepEqual(calls, [
    ['search', [{ cwd, project: join(cwd, '.codex', 'config.toml'), user: join(process.env.CODEX_HOME, 'config.toml') }], 'theme'],
    ['scan', cwd, 7],
  ]);
});

test('writeConfig valid TOML writes + exact prior-content backup', async () => {
  const prior = 'model = "x"\n';
  const cwd = await makeRoot(prior);
  await setConfigRoots([cwd]); // writeConfig requires isKnownConfigRoot(cwd)
  const r = await writeConfig(cwd, 'project', 'model = "y"\n', null, false, testBackend);
  assert.equal(r.ok, true);
  assert.equal(r.path, join(cwd, '.codex', 'config.toml'));
  assert.equal(readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8'), 'model = "y"\n');
  assert.equal(existsSync(r.backup), true);
  assert.equal(readFileSync(r.backup, 'utf8'), prior);
});

test('writeConfig first write creates only its parent and returns stable result keys', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sing-cdx-first-write-'));
  await setConfigRoots([cwd]);
  const target = join(cwd, '.codex', 'config.toml');
  const r = await writeConfig(cwd, 'project', '', null, false, testBackend);
  assert.deepEqual(Object.keys(r).sort(), ['backup', 'mtime', 'ok', 'path']);
  assert.equal(r.ok, true);
  assert.equal(r.backup, null);
  assert.equal(r.path, target);
  assert.equal(readFileSync(target, 'utf8'), '');
});

test('writeConfig invalid TOML returns ok:false and does not write', async () => {
  const cwd = await makeRoot('model = "x"\n');
  await setConfigRoots([cwd]);
  const orig = readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8');
  const r = await writeConfig(cwd, 'project', 'model = "unterminated\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /TOML/);
  assert.equal(readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8'), orig);
});

test('writeConfig rejects cwd outside config roots', async () => {
  const cwd = await makeRoot('model = "x"\n');
  await setConfigRoots([mkdtempSync(join(tmpdir(), 'sing-other-'))]); // a different root
  const r = await writeConfig(cwd, 'project', 'model = "y"\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /outside config roots/);
});

test('writeConfig enforces cwd<->scope invariant', async () => {
  const cwd = await makeRoot('model = "x"\n');
  await setConfigRoots([cwd]);
  // user scope requires cwd ~ (home); a project cwd is not home.
  assert.equal((await writeConfig(cwd, 'user', 'model = "y"\n')).ok, false);
  // project scope requires a non-home cwd; home (untildified ~) is home.
  await setConfigRoots(['~']);
  const rp = await writeConfig(homedir(), 'project', 'model = "y"\n');
  assert.equal(rp.ok, false);
  assert.match(rp.error, /non-home/);
});

test('readConfig rejects cwd outside config roots', async () => {
  const cwd = await makeRoot('model = "x"\n');
  await setConfigRoots([mkdtempSync(join(tmpdir(), 'sing-other-'))]); // a different root
  const result = await readConfig(cwd);
  assert.equal(result.project.exists, false);
  assert.equal(result.project.content, '');
  assert.equal(result.user.exists, false);
  assert.equal(result.user.content, '');
  // Path should still be present but file is marked non-existent
  assert.ok(result.project.path);
  assert.ok(result.user.path);
  // mtime: 0 for non-existent/outside scopes
  assert.equal(result.project.mtime, 0);
  assert.equal(result.user.mtime, 0);
});

test('Codex read and search authorize roots before calling the content backend', async () => {
  const cwd = await makeRoot('model = "private"\n');
  await setConfigRoots([mkdtempSync(join(tmpdir(), 'sing-other-'))]);
  let reads = 0;
  let searches = 0;
  setCodexConfigReadBackend({
    async codexConfigRead(path) { reads++; return testBackend.codexConfigRead(path); },
    async codexConfigSearch(roots, q) { searches++; return testBackend.codexConfigSearch(roots, q); },
    async codexConfigScan(root, cap) { return testBackend.codexConfigScan(root, cap); },
  });
  try {
    const denied = await readConfig(cwd);
    assert.equal(denied.project.content, '');
    assert.equal(denied.user.content, '');
    assert.deepEqual(await searchConfig([cwd], 'private'), []);
    assert.equal(reads, 0);
    assert.equal(searches, 1);
  } finally { setCodexConfigReadBackend(testBackend); }
});

test('readConfig reports mtime on existing scopes', async () => {
  const cwd = await makeRoot('model = "x"\n');
  await setConfigRoots([cwd]);
  const cfg = await readConfig(cwd);
  assert.equal(typeof cfg.project.mtime, 'number');
  assert.ok(cfg.project.mtime > 0);
});

test('Codex read and write fail closed when picker roots bridge rejects', async () => {
  const cwd = await makeRoot('model = "x"\n');
  setConfigRootsBackend({ async pickerRootsGet() { throw new Error('picker bridge unavailable'); } });
  try {
    await assert.rejects(readConfig(cwd), /picker bridge unavailable/);
    let writes = 0;
    await assert.rejects(writeConfig(cwd, 'project', 'model = "y"\n', null, false, {
      async codexConfigWrite() { writes++; return { ok: true }; },
    }), /picker bridge unavailable/);
    assert.equal(writes, 0);
  } finally { setConfigRootsBackend(rootsBackend); }
});

test('writeConfig rejects a stale mtime with "changed on disk"; force overrides', async () => {
  const cwd = await makeRoot('model = "x"\n');
  await setConfigRoots([cwd]);
  const p = join(cwd, '.codex', 'config.toml');
  const stale = (await readConfig(cwd)).project.mtime;
  // Externally rewrite + bump mtime past the 1ms guard window.
  writeFileSync(p, 'model = "ext"\n');
  const future = (Date.now() + 5000) / 1000;
  utimesSync(p, future, future);
  const rejected = await writeConfig(cwd, 'project', 'model = "y"\n', stale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'changed on disk');
  assert.equal(readFileSync(p, 'utf8'), 'model = "ext"\n'); // untouched
  // force overrides the drift.
  const forced = await writeConfig(cwd, 'project', 'model = "forced"\n', stale, true, testBackend);
  assert.equal(forced.ok, true);
  assert.equal(typeof forced.mtime, 'number');
  assert.equal(readFileSync(p, 'utf8'), 'model = "forced"\n');
});

test('writeConfig derives user path from CODEX_HOME while requiring home cwd', async () => {
  await setConfigRoots(['~']);
  const result = await writeConfig(homedir(), 'user', '', null, false, testBackend);
  assert.equal(result.ok, true);
  assert.equal(result.path, join(process.env.CODEX_HOME, 'config.toml'));
  assert.equal(readFileSync(result.path, 'utf8'), '');
});

test('writeConfig parses TOML before backup and backend, preserving error precedence', async () => {
  const cwd = await makeRoot('model = "prior"\n');
  const target = join(cwd, '.codex', 'config.toml');
  const before = readFileSync(target, 'utf8');
  let backendCalls = 0;
  const backend = { async codexConfigWrite() { backendCalls++; return { ok: true, mtime: 0 }; } };
  const result = await writeConfig(cwd, 'project', 'model = "unterminated\n', null, false, backend);
  assert.equal(result.ok, false);
  assert.match(result.error, /TOML/);
  assert.equal(backendCalls, 0);
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('writeConfig passes native conflicts through and logs generic backend failures', async () => {
  const cwd = await makeRoot(null);
  const errors = [];
  const logger = { error: (...args) => errors.push(args) };
  const conflict = await writeConfig(cwd, 'project', '', null, false, {
    async codexConfigWrite() { return { ok: false, error: 'changed on disk' }; },
  }, logger);
  assert.deepEqual(conflict, { ok: false, error: 'changed on disk' });
  assert.equal(errors.length, 0);

  const failed = await writeConfig(cwd, 'project', '', null, false, {
    async codexConfigWrite() { return { ok: false, error: 'native failure detail' }; },
  }, logger);
  assert.deepEqual(failed, { ok: false, error: 'codex config write failed' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0].err, 'native failure detail');
});
