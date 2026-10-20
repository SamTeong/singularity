import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createRustBackend, createWikiGraphHandler } from './rust-backend.mjs';

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

test('gateway turns Rust process failure into a logged 500 response', async () => {
  const app = Fastify();
  app.get('/api/wiki/graph', createWikiGraphHandler({ graph: async () => { throw new Error('child exited'); } }, app.log));
  const response = await app.inject({ url: '/api/wiki/graph?root=x&wiki=y' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { error: 'wiki graph backend unavailable' });
  await app.close();
});
