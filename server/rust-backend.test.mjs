import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createModelPricesHandler, createModelsHandlers, createRustBackend, createWikiGraphHandler } from './rust-backend.mjs';

async function wiki(root, name, files) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, name, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
}

test('Rust bridge rejects startup when a spawned child exits before ready', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => {
      child.emit('spawn');
      child.emit('exit', 7, null);
    });
    return child;
  } });

  await assert.rejects(backend.start(), /exited before ready \(7\)/);
  await backend.stop();
});

test('Rust pricing read normalizes the explicit path without writing and maps transport failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-prices-'));
  process.env.SINGULARITY_HOME = root;
  process.env.USAGE_REPORT_STATE = join(root, 'selected');
  const { getModelPricesForUsageHistory, getModelPricesPath } = await import('./model-prices.mjs');
  const missing = join(root, 'selected', 'pricing.json');
  assert.equal(getModelPricesPath(), missing);
  const backend = createRustBackend();
  const app = Fastify();
  app.get('/api/models/prices', createModelPricesHandler(backend, missing, app.log));
  try {
    await backend.start();
    const absent = await app.inject({ url: '/api/models/prices' });
    assert.equal(absent.statusCode, 200);
    assert.deepEqual(absent.json(), { base: {}, above_200k: {}, long_context_threshold: 200000, default_key: '' });
    await assert.rejects(access(missing));

    await mkdir(join(root, 'selected'), { recursive: true });
    const raw = '{"base":{"z":[1,2,3,4],"a":[5,6,7,8]},"above_200k":null,"long_context_threshold":12.0,"default_key":7}';
    await writeFile(missing, raw);
    const layered = await app.inject({ url: '/api/models/prices' });
    assert.equal(layered.statusCode, 200);
    assert.deepEqual(layered.json(), {
      base: { z: [1, 2, 3, 4], a: [5, 6, 7, 8] }, above_200k: {}, long_context_threshold: 12, default_key: '',
    });
    assert.deepEqual(Object.keys(layered.json().base), ['z', 'a']);
    assert.equal(await readFile(missing, 'utf8'), raw);
    assert.deepEqual(layered.json(), getModelPricesForUsageHistory());

    const numericKeys = '{"base":{"1":[1,2,3,4],"z":[1,2,3,4],"0":[1,2,3,4],"01":[1,2,3,4],"4294967295":[1,2,3,4],"4294967294":[1,2,3,4],"__proto__":[1,2,3,4],"z":[5,6,7,8]},"long_context_threshold":1e30}';
    await writeFile(missing, numericKeys);
    const ordered = await app.inject({ url: '/api/models/prices' });
    const orderedDoc = ordered.json();
    assert.deepEqual(orderedDoc, getModelPricesForUsageHistory());
    assert.deepEqual(Object.keys(orderedDoc.base), ['0', '1', '4294967294', 'z', '01', '4294967295', '__proto__']);
    assert.equal(Object.hasOwn(orderedDoc.base, '__proto__'), true);
    assert.equal(orderedDoc.long_context_threshold, 1e30);

    const overflowCases = [
      '{"base":{"model":[1,2,3,4]},"ignored":1e400}',
      '{"base":{"model":[1e400,2,3,4]},"ignored":{"nested":[1e400,{"deep":1e400}]},"long_context_threshold":1e400,"default_key":1e400}',
    ];
    for (const overflowCase of overflowCases) {
      await writeFile(missing, overflowCase);
      assert.deepEqual(await backend.modelPrices(missing), getModelPricesForUsageHistory());
    }
    const overflowReferenced = await backend.modelPrices(missing);
    assert.equal(overflowReferenced.base.model[0], Infinity);
    assert.equal(overflowReferenced.long_context_threshold, 200000);
    assert.equal(overflowReferenced.default_key, '');

    const duplicateBase = '{"base":{"z":[1,2,3,4],"a":[1,2,3,4]},"base":{"c":[1,2,3,4],"b":[1,2,3,4]}}';
    await writeFile(missing, duplicateBase);
    const duplicateBaseDoc = await backend.modelPrices(missing);
    assert.deepEqual(duplicateBaseDoc, getModelPricesForUsageHistory());
    assert.deepEqual(Object.keys(duplicateBaseDoc.base), ['c', 'b']);

    const legacy = join(root, 'legacy.json');
    await writeFile(legacy, '{"opus":[99,99,99,99]}');
    const legacyDoc = await backend.modelPrices(legacy);
    assert.deepEqual(legacyDoc, { base: { opus: [99, 99, 99, 99] }, above_200k: {}, long_context_threshold: 200000, default_key: '' });

    await writeFile(missing, '{not json');
    const corrupt = await app.inject({ url: '/api/models/prices' });
    assert.deepEqual(corrupt.json(), { base: {}, above_200k: {}, long_context_threshold: 200000, default_key: '' });
    const unreadable = await backend.modelPrices(join(root, 'selected'));
    assert.deepEqual(unreadable, { base: {}, above_200k: {}, long_context_threshold: 200000, default_key: '' });
  } finally {
    await backend.stop();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }

  const stopped = createRustBackend();
  const unavailable = Fastify();
  unavailable.get('/api/models/prices', createModelPricesHandler(stopped, missing, unavailable.log));
  const response = await unavailable.inject({ url: '/api/models/prices' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'model prices backend unavailable' });
  await unavailable.close();
});

test('Models HTTP handlers use the fixed server path and preserve catalogue contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-models-'));
  const path = join(root, 'state', 'models.json');
  const attacker = join(root, 'attacker.json');
  const backend = createRustBackend();
  const app = Fastify();
  const handlers = createModelsHandlers(backend, path, app.log);
  app.get('/api/models', handlers.get);
  app.put('/api/models', handlers.set);
  app.post('/api/models/restore-defaults', handlers.restore);
  try {
    await backend.start();
    const first = await app.inject({ url: `/api/models?path=${encodeURIComponent(attacker)}` });
    assert.equal(first.statusCode, 200);
    assert.ok(Array.isArray(first.json().models));
    assert.equal(first.json().models.length, 21);
    await assert.rejects(access(attacker));

    const invalid = await app.inject({ method: 'PUT', url: '/api/models', payload: { path: attacker, models: 'invalid' } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { ok: false, error: 'models must be an array' });
    await assert.rejects(access(attacker));

    const custom = { models: [{ id: 'gpt-5.4', group: 'codex', label: 'Custom', enabled: true }], defaultModel: 'gpt-5.4', summariserModel: 'gpt-5.4' };
    const written = await app.inject({ method: 'PUT', url: '/api/models', payload: { path: attacker, ...custom } });
    assert.equal(written.statusCode, 200);
    assert.deepEqual(written.json(), { ok: true, state: custom });
    await assert.rejects(access(attacker));
    const restored = await app.inject({ method: 'POST', url: '/api/models/restore-defaults' });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().ok, true);
    assert.deepEqual(restored.json().state.models.slice(0, 1), custom.models);
  } finally {
    await backend.stop();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }

  const stopped = createModelsHandlers(backend, path, app.log);
  const failedApp = Fastify();
  failedApp.get('/api/models', stopped.get);
  try {
    const failure = await failedApp.inject({ url: '/api/models' });
    assert.equal(failure.statusCode, 500);
    assert.deepEqual(failure.json(), { error: 'models backend unavailable' });
  } finally { await failedApp.close(); }
});

test('Rust stdio bridge keeps concurrent graph requests matched and preserves route payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-bridge-'));
  const firstRoot = join(root, 'first');
  const secondRoot = join(root, 'second');
  await wiki(firstRoot, 'wiki', { 'from.md': '[[target|label]] [[missing]]', 'target.md': '' });
  await wiki(secondRoot, 'wiki', { 'other.md': '[[target]]', 'target.md': '' });
  const backend = createRustBackend();
  const app = Fastify();
  app.get('/api/wiki/graph', createWikiGraphHandler(backend, app.log));
  try {
    await backend.start();
    const [first, second] = await Promise.all([
      app.inject({ url: `/api/wiki/graph?root=${encodeURIComponent(firstRoot)}&wiki=wiki` }),
      app.inject({ url: `/api/wiki/graph?root=${encodeURIComponent(secondRoot)}&wiki=wiki` }),
    ]);
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json().edges, [{ source: 'from.md', target: 'target.md' }]);
    assert.deepEqual(first.json().nodes.map(({ id, label, category }) => ({ id, label, category })), [
      { id: 'from.md', label: 'from', category: '' },
      { id: 'target.md', label: 'target', category: '' },
    ]);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json().edges, [{ source: 'other.md', target: 'target.md' }]);

    const missingRoot = await app.inject({ url: `/api/wiki/graph?root=${encodeURIComponent(join(root, 'absent'))}&wiki=wiki` });
    assert.equal(missingRoot.statusCode, 200);
    assert.deepEqual(missingRoot.json(), { error: 'not found' });
    const missingWiki = await app.inject({ url: `/api/wiki/graph?root=${encodeURIComponent(firstRoot)}&wiki=absent` });
    assert.equal(missingWiki.statusCode, 200);
    assert.deepEqual(missingWiki.json(), { error: 'wiki not found' });

    await backend.stop();
    await assert.rejects(backend.graph(firstRoot, 'wiki'), /not running/);
  } finally {
    await backend.stop();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Rust stdio bridge serves wiki files, sweeps, cached search, and guarded page content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-wiki-read-'));
  const wikiRoot = join(root, 'selected');
  await wiki(wikiRoot, 'alpha', { 'z.md': 'No match here', 'a.md': 'first needle\nAlias Needle', 'clip.md': `${'x'.repeat(199)}😀 needle` });
  await wiki(wikiRoot, 'Älpha', { 'É.md': 'NEEDLE' });
  await wiki(wikiRoot, 'agentic-coding', { 'meta/websearch-log.md': '## [2026-10-12] shallow | lanes: all\n- NEW: —\n## [2026-10-13] shallow\n- Interrupted.' });
  await wiki(wikiRoot, 'dotnet', { 'meta/websearch-log.md': '## [2026-10-11] deep | lanes: all\n- Sweep completed.' });
  await wiki(wikiRoot, 'iap', { 'wiki-sync.json': JSON.stringify({ lastIngestedAt: '2026-10-10' }) });
  const backend = createRustBackend();
  try {
    await backend.start();
    const listing = await backend.files(wikiRoot);
    const wikiNames = listing.wikis.map(({ name }) => name);
    assert.deepEqual(wikiNames, [...wikiNames].sort((a, b) => a.localeCompare(b)));
    const alphaPages = listing.wikis.find(({ name }) => name === 'alpha').pages.map(({ rel }) => rel);
    assert.deepEqual(alphaPages, [...alphaPages].sort((a, b) => a.localeCompare(b)));
    assert.equal(listing.capped, false);

    const [search, sweeps, content, missing] = await Promise.all([
      backend.search('NEEDLE', wikiRoot),
      backend.sweeps(wikiRoot),
      backend.readFile(join(wikiRoot, 'alpha', 'a.md')),
      backend.readFile(join(wikiRoot, 'alpha', 'missing.md')),
    ]);
    const searchHits = search.results.map(({ rel, line }) => [rel, line]);
    assert.deepEqual(searchHits, [...searchHits].sort((a, b) => a[0].split('/')[0].localeCompare(b[0].split('/')[0])));
    assert.deepEqual(searchHits.map(([rel, line]) => [rel, line]), [
      ['alpha/a.md', 1], ['alpha/a.md', 2], ['alpha/clip.md', 1], ['Älpha/É.md', 1],
    ]);
    assert.equal(search.results.find(({ rel }) => rel === 'alpha/clip.md').text, `${'x'.repeat(199)}\ud83d`);
    assert.equal(search.capped, false);
    assert.deepEqual(sweeps, { wikis: [
      { name: 'agentic-coding', shallow: '2026-10-12', deep: null, horizon: null },
      { name: 'dotnet', shallow: null, deep: '2026-10-11', horizon: null },
      { name: 'iap', shallow: null, deep: '2026-10-10', horizon: null },
    ] });
    assert.deepEqual(content, { ok: true, content: 'first needle\nAlias Needle' });
    assert.deepEqual(missing, { ok: false, error: 'not found' });

    assert.deepEqual(await backend.files(join(root, 'absent')), { wikis: [], capped: false, error: 'not found' });
    assert.deepEqual(await backend.search('needle', join(root, 'absent')), { results: [], capped: false });
  } finally {
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Rust stdio bridge serves configured Plans list and resolved-session detail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-plans-'));
  const sid = 'aaaaaaaa-1111-4111-8111-111111111111';
  const dir = join(root, sid);
  await mkdir(dir);
  await writeFile(join(dir, 'plan.md'), '# Plan A\nStatus: active\n\n## Objective\nShip Plans.\n\n## Phases\n- [x] parse\n- [ ] route\n\n## Next steps\n- verify bridge\n\n## Evidence\n- evidence.md\n');
  await writeFile(join(dir, 'evidence.md'), '# Evidence\nsource notes');
  await writeFile(join(dir, 'state.json'), JSON.stringify({
    generated_at: '2026-10-20T00:00:00.000Z', cwd: 'C:/git/singularity', branch: 'main', context_tokens: 20,
  }));
  const unreadableStateDir = join(root, 'bbbbbbbb-2222-4222-8222-222222222222');
  await mkdir(unreadableStateDir);
  await writeFile(join(unreadableStateDir, 'plan.md'), '# Plan B\nStatus: blocked');
  await mkdir(join(unreadableStateDir, 'state.json'));
  const backend = createRustBackend();
  try {
    await backend.start();
    const sessions = await backend.planSessions(root);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sid, sid);
    assert.equal(sessions[0].planCount, 1);
    assert.deepEqual(sessions[0].statusBuckets, { active: 1, blocked: 0, done: 0, other: 0, superseded: 0 });
    assert.equal(sessions[0].branch, 'main');
    assert.equal(sessions[0].contextTokens, 20);
    const unreadableState = sessions.find(({ sid: listedSid }) => listedSid === 'bbbbbbbb-2222-4222-8222-222222222222');
    assert.equal(unreadableState.planCount, 1);
    assert.equal(unreadableState.branch, null);
    assert.equal(unreadableState.contextTokens, null);

    const detail = await backend.planSession(dir, sid);
    assert.equal(detail.ok, true);
    assert.equal(detail.plans[0].objective, 'Ship Plans.');
    assert.deepEqual(detail.plans[0].phases, [
      { text: 'parse', state: 'done' }, { text: 'route', state: 'open' },
    ]);
    assert.equal(detail.plans[0].nextSteps[0], 'verify bridge');
    assert.equal(detail.notes[0].plan, 'plan.md');
    assert.deepEqual(detail.state, {
      generatedAt: '2026-10-20T00:00:00.000Z',
      cwd: 'C:/git/singularity',
      branch: 'main',
      contextTokens: 20,
    });
    await writeFile(join(dir, 'state.json'), '{ malformed');
    assert.equal((await backend.planSession(dir, sid)).state, null);
    assert.deepEqual(await backend.planSession(join(root, 'missing'), sid), { ok: false, error: 'not found' });
    assert.deepEqual(await backend.planSessions(null), []);
  } finally {
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Rust stdio bridge serves the Rules companion-reference lookup', async () => {
  const refDir = await mkdtemp(join(tmpdir(), 'singularity-rust-rules-'));
  await writeFile(join(refDir, 'skills-reference.md'), '# reference body');
  await writeFile(join(refDir, 'term-reference.md'), 'mixed case stem');
  await mkdir(join(refDir, 'fail-reference.md')); // exists, but unreadable as a file
  const backend = createRustBackend();
  try {
    await backend.start();
    assert.deepEqual(await backend.ruleReference(join(refDir, 'nested', 'skills.md'), refDir), {
      ok: true, path: join(refDir, 'skills-reference.md'), content: '# reference body',
    });
    assert.deepEqual(await backend.ruleReference('dir/term.Md', refDir), {
      ok: true, path: join(refDir, 'term-reference.md'), content: 'mixed case stem',
    });
    assert.deepEqual(await backend.ruleReference('lonely.md', refDir), { ok: false, error: 'no reference' });
    assert.deepEqual(await backend.ruleReference('', refDir), { ok: false, error: 'no path' });
    const unreadable = await backend.ruleReference('fail.md', refDir);
    assert.equal(unreadable.ok, false);
    assert.ok(unreadable.error.length > 0);
  } finally {
    await backend.stop();
    await rm(refDir, { recursive: true, force: true });
  }
});

test('Rust stdio bridge serves the Rules file walk and content search', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-rules-walk-'));
  const dir = join(base, '.claude', 'rules');
  await mkdir(join(dir, 'sub'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(dir, '.hidden'), { recursive: true });
  await writeFile(join(dir, 'a.md'), 'line one\nFIND me here\nline three');
  await writeFile(join(dir, 'sub', 'b.md'), `${'x'.repeat(199)}\u{1F600} needle`);
  await writeFile(join(dir, 'ignore.txt'), 'FIND me');
  await writeFile(join(dir, '.dot.md'), 'FIND me');
  await writeFile(join(dir, '.hidden', 'x.md'), 'FIND me');
  await writeFile(join(dir, 'node_modules', 'dep', 'y.md'), 'FIND me');
  const backend = createRustBackend();
  try {
    await backend.start();
    const scans = [{ root: 'raw-base', dir }];
    const listing = await backend.ruleFiles(scans);
    assert.equal(listing.capped, false);
    const rels = listing.files.map(({ rel }) => rel).sort();
    assert.deepEqual(rels, ['a.md', 'sub/b.md']); // .md only; dot/SKIP_DIRS entries never listed
    const first = listing.files.find(({ rel }) => rel === 'a.md');
    assert.equal(first.root, 'raw-base'); // verbatim raw client string
    assert.equal(first.path, join(dir, 'a.md'));
    assert.equal(first.file, 'a.md');

    const missing = await backend.ruleFiles([{ root: 'raw-base', dir: join(base, 'absent') }]);
    assert.deepEqual(missing, { files: [], capped: false }); // silent skip

    assert.deepEqual(await backend.ruleSearch(scans, ''), { results: [], capped: false });
    const search = await backend.ruleSearch(scans, 'find me');
    assert.equal(search.capped, false);
    assert.equal(search.results.length, 1); // ignore.txt + dot/hidden files never scanned
    assert.deepEqual(search.results[0], {
      root: 'raw-base', path: join(dir, 'a.md'), rel: 'a.md', file: 'a.md', line: 2, text: 'FIND me here',
    });
    const clip = await backend.ruleSearch(scans, 'needle');
    assert.equal(clip.capped, false);
    // 200 UTF-16 code units: the boundary splits the emoji's surrogate pair.
    assert.equal(clip.results[0].text, `${'x'.repeat(199)}\ud83d`);
    assert.equal(clip.results[0].line, 1);
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust stdio bridge writes Rules content with mtime checks and force', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-rules-write-'));
  const path = join(base, '.claude', 'rules', 'note.md');
  await mkdir(join(path, '..'), { recursive: true });
  process.env.SINGULARITY_HOME = join(base, 'app-state');
  const backend = createRustBackend();
  try {
    await backend.start();
    const { setRulesRoots, writeRuleFile } = await import('./rules.mjs');
    const { BACKUPS_DIR } = await import('./app-dir.mjs');
    setRulesRoots([base]);
    await writeFile(path, 'prior rule bytes');
    const saved = await writeRuleFile(path, 'rule ✓', null, false, backend);
    assert.equal(saved.ok, true);
    assert.equal(typeof saved.mtime, 'number');
    const backupDir = join(BACKUPS_DIR, createHash('sha256').update(path).digest('hex').slice(0, 16));
    await assert.rejects(access(backupDir)); // successful Rules overwrite creates no backup artifact
    const { mtimeMs } = await (await import('node:fs/promises')).stat(path);
    assert.ok(Math.abs(saved.mtime - mtimeMs) < 2);
    assert.equal(await readFile(path, 'utf8'), 'rule ✓');

    const roundTrip = await backend.ruleWrite(path, 'round-trip', saved.mtime, false);
    assert.equal(roundTrip.ok, true); // returned metadata is usable with the strict 1ms guard
    const empty = await backend.ruleWrite(path, '', roundTrip.mtime + 1, false);
    assert.equal(empty.ok, true); // the existing 1ms tolerance is inclusive
    assert.equal(await readFile(path, 'utf8'), '');
    await writeFile(path, 'external');
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    const stale = await backend.ruleWrite(path, 'rejected', saved.mtime, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'external');
    const staleNumericString = await backend.ruleWrite(path, 'rejected string mtime', String(saved.mtime), false);
    assert.deepEqual(staleNumericString, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'external');
    const forced = await backend.ruleWrite(path, 'forced', saved.mtime, 'false');
    assert.equal(forced.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'forced');
    const unguarded = await backend.ruleWrite(path, 'unguarded', 'not-a-number', false);
    assert.equal(unguarded.ok, true);
    const missing = await backend.ruleWrite(join(base, 'absent', 'x.md'), 'x', null, false);
    assert.equal(missing.ok, false);
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust stdio bridge serves the Skills list, skill read, and supporting-file read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-skills-'));
  const scopesRoot = join(base, 'scopes');
  const md = '---\nname: freeze\ndescription: Lock edits to a directory.\ntriggers:\n  - freeze edits\n---\n\n# freeze\n\nbody';
  await mkdir(join(scopesRoot, 'coding', '.claude', 'skills', 'freeze', 'scripts'), { recursive: true });
  await writeFile(join(scopesRoot, 'coding', '.claude', 'skills', 'freeze', 'SKILL.md'), md);
  await writeFile(join(scopesRoot, 'coding', '.claude', 'skills', 'freeze', 'scripts', 'run.mjs'), "console.log('run')");
  await writeFile(join(scopesRoot, 'coding', '.claude', 'skills', 'freeze', 'pic.png'), 'binaryish');
  await mkdir(join(scopesRoot, 'common', '.claude', 'skills', 'x'), { recursive: true });
  await writeFile(join(scopesRoot, 'common', '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: hidden\n---\n');
  const flatRoot = join(base, 'flat');
  await mkdir(join(flatRoot, 'declawed'), { recursive: true });
  await writeFile(join(flatRoot, 'declawed', 'SKILL.md'), '---\nname: declawed\n---\n');
  const backend = createRustBackend();
  try {
    await backend.start();

    const listed = await backend.skillsList(scopesRoot);
    assert.equal(listed.flat, false);
    const coding = listed.scopes.find((s) => s.name === 'coding'); // scopes ship in readdir order
    const freeze = coding.skills.find((s) => s.name === 'freeze');
    assert.equal(freeze.description, 'Lock edits to a directory.');
    assert.equal(freeze.raw, md);
    assert.deepEqual(freeze.tree.map((e) => e.n).sort(), ['SKILL.md', 'pic.png', 'scripts']); // readdir order, entry tree not flattened
    const scripts = freeze.tree.find((e) => e.n === 'scripts');
    assert.deepEqual(scripts, { n: 'scripts', f: false, c: [{ n: 'run.mjs', f: true }] });
    assert.equal(listed.scopes.find((s) => s.name === 'common').skills[0].name, 'x');
    const flat = await backend.skillsList(flatRoot);
    assert.equal(flat.flat, true);
    assert.equal(flat.scopes[0].name, 'flat'); // basename of the root
    assert.equal(flat.scopes[0].skills[0].name, 'declawed');
    assert.deepEqual(await backend.skillsList(join(base, 'absent')),
      { scopes: [], flat: false, error: 'skills root not found' });

    const read = await backend.skillRead(scopesRoot, 'coding', 'freeze', false);
    assert.equal(read.ok, true);
    assert.equal(read.name, 'freeze');
    assert.deepEqual(read.triggers, ['freeze edits']);
    assert.equal(read.body, '\n# freeze\n\nbody');
    assert.equal(read.raw, md);
    assert.equal(read.path, join(scopesRoot, 'coding', '.claude', 'skills', 'freeze', 'SKILL.md'));
    assert.equal(typeof read.mtime, 'number');
    assert.deepEqual(await backend.skillRead(scopesRoot, 'coding', 'nope', false),
      { ok: false, error: 'not found' });

    const code = await backend.skillFileRead(scopesRoot, 'coding', 'freeze', 'scripts/run.mjs', false);
    assert.equal(code.ok, true);
    assert.equal(code.type, 'code');
    assert.equal(code.name, 'run.mjs');
    assert.equal(code.content, "console.log('run')");
    const image = await backend.skillFileRead(scopesRoot, 'coding', 'freeze', 'pic.png', false);
    assert.equal(image.type, 'image');
    assert.equal('content' in image, false); // binary never ships
    assert.equal(image.name, 'pic.png');
    assert.deepEqual(await backend.skillFileRead(scopesRoot, 'coding', 'freeze', 'missing.md', false),
      { ok: false, error: 'not found' });
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('gateway turns Rust process failure into a logged 500 response', async () => {
  const app = Fastify();
  app.get('/api/wiki/graph', createWikiGraphHandler({ graph: async () => { throw new Error('child exited'); } }, app.log));
  const response = await app.inject({ url: '/api/wiki/graph?root=x&wiki=y' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'wiki graph backend unavailable' });
  await app.close();
});

test('Rust stdio bridge writes Claude Config with UTF-8, mtime coercion, force, and no parent creation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-config-write-'));
  const path = join(base, '.claude', 'settings.json');
  await mkdir(join(base, '.claude'), { recursive: true });
  await writeFile(path, 'prior');
  const backend = createRustBackend();
  try {
    await backend.start();
    const saved = await backend.configWrite(path, '{"theme":"更新 ✓"}', null, false);
    assert.deepEqual(Object.keys(saved).sort(), ['mtime', 'ok']);
    assert.equal(saved.ok, true);
    assert.equal(await readFile(path, 'utf8'), '{"theme":"更新 ✓"}');
    assert.ok(Math.abs(saved.mtime - (await (await import('node:fs/promises')).stat(path)).mtimeMs) < 2);

    const matchingStringMtime = await backend.configWrite(path, '', String(saved.mtime), false);
    assert.equal(matchingStringMtime.ok, true); // string mtime is Number-coerced
    assert.equal(await readFile(path, 'utf8'), '');

    await writeFile(path, 'external');
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    const stale = await backend.configWrite(path, 'rejected', saved.mtime, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'external');

    const forced = await backend.configWrite(path, 'forced', saved.mtime, 'false');
    assert.equal(forced.ok, true); // truthy force follows JavaScript coercion
    assert.equal(await readFile(path, 'utf8'), 'forced');

    const unguarded = await backend.configWrite(path, 'unguarded', 'not-a-number', false);
    assert.equal(unguarded.ok, true); // Number(NaN) serializes as null and disables the guard

    const missing = join(base, 'absent', '.claude', 'settings.json');
    const failed = await backend.configWrite(missing, '{}', null, false);
    assert.equal(failed.ok, false);
    assert.equal(await access(join(base, 'absent')).then(() => true, () => false), false);
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust stdio bridge writes authorized Hooks payloads with mtime coercion and force semantics', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-hooks-write-'));
  const path = join(base, '.claude', 'hooks', 'pre-commit');
  await mkdir(join(base, '.claude', 'hooks'), { recursive: true });
  await writeFile(path, 'prior');
  const backend = createRustBackend();
  try {
    await backend.start();
    const saved = await backend.hooksWrite(path, 'echo 更新 ✓', null, false);
    assert.deepEqual(Object.keys(saved).sort(), ['mtime', 'ok']);
    assert.equal(saved.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'echo 更新 ✓');
    assert.ok(Math.abs(saved.mtime - (await (await import('node:fs/promises')).stat(path)).mtimeMs) < 2);

    const empty = await backend.hooksWrite(path, '', String(saved.mtime), false);
    assert.equal(empty.ok, true);
    assert.equal(await readFile(path, 'utf8'), '');

    await writeFile(path, 'external');
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    const stale = await backend.hooksWrite(path, 'rejected', saved.mtime, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'external');

    const forced = await backend.hooksWrite(path, 'forced', saved.mtime, 'false');
    assert.equal(forced.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'forced');

    const missing = join(base, 'absent', '.claude', 'hooks', 'pre-commit');
    const failed = await backend.hooksWrite(missing, 'hook', null, false);
    assert.equal(failed.ok, false);
    assert.equal(await access(join(base, 'absent')).then(() => true, () => false), false);
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust Config bridge preserves and checks pre-epoch mtimes', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-config-pre-epoch-'));
  const path = join(base, '.claude', 'settings.json');
  await mkdir(join(base, '.claude'), { recursive: true });
  await writeFile(path, 'prior');
  const backend = createRustBackend();
  try {
    await backend.start();
    const preEpoch = new Date(Date.UTC(1960, 0, 1));
    try { await utimes(path, preEpoch, preEpoch); }
    catch (error) {
      t.skip(`filesystem cannot set a pre-epoch mtime: ${error.message}`);
      return;
    }
    const { mtimeMs } = await (await import('node:fs/promises')).stat(path);
    if (mtimeMs >= 0) {
      t.skip(`filesystem did not retain the pre-epoch mtime; observed ${mtimeMs}`);
      return;
    }

    const stale = await backend.configWrite(path, 'rejected', mtimeMs + 10, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'prior');

    const saved = await backend.configWrite(path, 'updated', String(mtimeMs), false);
    assert.equal(saved.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'updated');
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust Memory write bridge preserves mtime, coercion, force, and missing-parent behavior', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-memory-'));
  const path = join(base, 'project', 'memory', 'fact.md');
  await mkdir(join(base, 'project', 'memory'), { recursive: true });
  await writeFile(path, 'prior');
  const backend = createRustBackend();
  try {
    await backend.start();
    const initial = await backend.memoryWrite(path, '更新 ✓', null, false);
    assert.deepEqual(Object.keys(initial).sort(), ['mtime', 'ok']);
    assert.equal(initial.ok, true);
    assert.equal(await readFile(path, 'utf8'), '更新 ✓');
    assert.ok(Math.abs(initial.mtime - (await (await import('node:fs/promises')).stat(path)).mtimeMs) < 2);

    const empty = await backend.memoryWrite(path, '', initial.mtime + 1, false);
    assert.equal(empty.ok, true);
    assert.equal(await readFile(path, 'utf8'), '');

    await writeFile(path, 'external');
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    const stale = await backend.memoryWrite(path, 'rejected', initial.mtime, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'external');
    const staleNumericString = await backend.memoryWrite(path, 'rejected', String(initial.mtime), false);
    assert.deepEqual(staleNumericString, { ok: false, error: 'changed on disk' });
    const forced = await backend.memoryWrite(path, 'forced', initial.mtime, 'false');
    assert.equal(forced.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'forced');
    const unguarded = await backend.memoryWrite(path, 'unguarded', 'not-a-number', false);
    assert.equal(unguarded.ok, true);

    const missingParent = await backend.memoryWrite(join(base, 'absent', 'child.md'), 'x', null, false);
    assert.equal(missingParent.ok, false);
    assert.equal(await access(join(base, 'absent')).then(() => true, () => false), false);
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust Memory bridge saves pre-epoch files and rejects stale pre-epoch mtimes', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-memory-pre-epoch-'));
  const path = join(base, 'project', 'memory', 'fact.md');
  await mkdir(join(base, 'project', 'memory'), { recursive: true });
  await writeFile(path, 'prior');
  const backend = createRustBackend();
  try {
    await backend.start();
    const preEpoch = new Date(Date.UTC(1960, 0, 1));
    try { await utimes(path, preEpoch, preEpoch); }
    catch (error) {
      t.skip(`filesystem cannot set a pre-epoch mtime: ${error.message}`);
      return;
    }
    const { mtimeMs } = await (await import('node:fs/promises')).stat(path);
    if (mtimeMs >= 0) {
      t.skip(`filesystem did not retain the pre-epoch mtime; observed ${mtimeMs}`);
      return;
    }

    const stale = await backend.memoryWrite(path, 'rejected', mtimeMs + 10, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'prior');

    const saved = await backend.memoryWrite(path, 'updated', mtimeMs, false);
    assert.equal(saved.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'updated');
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});
