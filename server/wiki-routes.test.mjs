import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { test } from 'node:test';

process.env.SINGULARITY_HOME ??= mkdtempSync(join(tmpdir(), 'sing-wiki-routes-'));
const { STATE_DIR } = await import('./app-dir.mjs');
const { registerWikiRoutes, wikiAvailable } = await import('./wiki-routes.mjs');

function makeApp(overrides = {}) {
  const calls = [];
  const backend = {
    wikiRootGet: async (context) => { calls.push(['get', context]); return { root: '~/wiki' }; },
    wikiRootSet: async (context, root) => { calls.push(['set', context, root]); return typeof root === 'string' && root ? { ok: true, root } : { ok: false, error: 'bad root' }; },
    wikiRootAuthorize: async (context, root, path) => { calls.push(['authorize', context, root, path]); return { authorized: true }; },
    wikiRootAvailable: async (context) => { calls.push(['available', context]); return { available: true }; },
    readFile: async (path) => { calls.push(['read', path]); return { ok: true, content: 'page' }; },
    ...overrides,
  };
  const app = Fastify({ logger: false });
  registerWikiRoutes(app, backend);
  return { app, backend, calls };
}

test('production Wiki registrar preserves root DTOs, raw JSON strings, and parser status behavior', async (t) => {
  const { app, calls } = makeApp();
  t.after(() => app.close());
  let response = await app.inject('/wiki/root');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { root: '~/wiki' });
  assert.equal(calls[0][1].state_file, resolve(STATE_DIR, 'wiki-root.json'));
  assert.ok(calls[0][1].home);
  assert.ok(calls[0][1].cwd);
  const surrogate = '\ud800';
  response = await app.inject({ method: 'PUT', url: '/wiki/root', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ root: surrogate }) });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true, root: surrogate });
  assert.equal(calls.find(([op]) => op === 'set')[2], surrogate);
  response = await app.inject({ method: 'PUT', url: '/wiki/root', headers: { 'content-type': 'application/json' }, payload: '{' });
  assert.equal(response.statusCode, 400);
  response = await app.inject({ method: 'PUT', url: '/wiki/root', headers: { 'content-type': 'text/plain' }, payload: '{"root":"ignored"}' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: false, error: 'bad root' });
});

test('production Wiki file handler authorizes before reading and preserves status mappings', async (t) => {
  let mode = 'allowed';
  const calls = [];
  const backend = {
    wikiRootGet: async () => ({ root: '~/wiki' }),
    wikiRootSet: async () => ({ ok: false, error: 'bad root' }),
    wikiRootAvailable: async () => ({ available: true }),
    wikiRootAuthorize: async (_context, root, path) => {
      calls.push(['authorize', root, path]);
      if (mode === 'authorization-error') throw new Error('bridge down');
      return { authorized: mode !== 'denied' };
    },
    readFile: async (path) => {
      calls.push(['read', path]);
      if (mode === 'read-error') throw new Error('bridge down');
      if (mode === 'not-found') return { ok: false, error: 'not found' };
      if (mode === 'bad-read') return { ok: false, error: 'unreadable' };
      return { ok: true, content: 'page' };
    },
  };
  const app = Fastify({ logger: false });
  registerWikiRoutes(app, backend);
  t.after(() => app.close());
  const url = '/wiki/file?root=%7E%2Fwiki&path=C%3A%2Fwiki%2Fpage.md';
  let response = await app.inject(url);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls.map(([kind]) => kind), ['authorize', 'read']);
  mode = 'denied'; calls.length = 0;
  response = await app.inject(url);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { ok: false, error: 'path outside wiki root' });
  assert.deepEqual(calls.map(([kind]) => kind), ['authorize']);
  mode = 'authorization-error';
  response = await app.inject(url);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { ok: false, error: 'wiki file backend unavailable' });
  mode = 'not-found';
  response = await app.inject(url);
  assert.equal(response.statusCode, 404);
  mode = 'bad-read';
  response = await app.inject(url);
  assert.equal(response.statusCode, 400);
  mode = 'read-error';
  response = await app.inject(url);
  assert.equal(response.statusCode, 500);
  response = await app.inject('/wiki/file?root=%7E%2Fwiki&path=a.md&path=b.md');
  assert.equal(response.statusCode, 500);
  response = await app.inject('/wiki/file?root=%7E%2Fwiki&root=%7E%2Fwiki&path=a.md');
  assert.equal(response.statusCode, 500);
});

test('capability availability uses the shared Rust helper and fails closed on errors', async () => {
  assert.equal(await wikiAvailable({ wikiRootAvailable: async () => ({ available: true }) }), true);
  assert.equal(await wikiAvailable({ wikiRootAvailable: async () => ({ available: false }) }), false);
  assert.equal(await wikiAvailable({ wikiRootAvailable: async () => { throw new Error('backend down'); } }), false);
});
