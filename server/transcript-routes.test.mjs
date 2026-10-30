import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerTranscriptRoutes } from './transcript-routes.mjs';

function setup(overrides = {}) {
  const calls = {};
  const reg = {
    isLive: (id) => id === 'live',
    snapshot: () => [],
    codexThreadFor: async () => null,
    getLaunchConfig: () => null,
    getLaunchConfigForCodexThread: async () => null,
  };
  const deps = {
    reg,
    listSessions: async (options) => { calls.list = options; return []; },
    readSession: async (...args) => { calls.read = args; return { ok: false, error: 'not found' }; },
    searchSessions: async (...args) => { calls.search = args; return { results: [], capped: false }; },
    subagentsFor: async (...args) => { calls.subagents = [...(calls.subagents || []), args]; return []; },
    getSessionsRoot: async () => '/saved/root',
    setSessionsRoot: async (root) => ({ ok: true, root }),
    ...overrides,
  };
  const app = Fastify();
  const routeDeps = {
    ...deps,
    listSessions: (...args) => deps.listSessions(...args),
    readSession: (...args) => deps.readSession(...args),
    searchSessions: (...args) => deps.searchSessions(...args),
    subagentsFor: (...args) => deps.subagentsFor(...args),
    getSessionsRoot: (...args) => deps.getSessionsRoot(...args),
    setSessionsRoot: (...args) => deps.setSessionsRoot(...args),
  };
  app.register(async (api) => registerTranscriptRoutes(api, routeDeps), { prefix: '/api' });
  return { app, calls, deps, reg };
}

test('transcript root GET/PUT preserve success and setter error responses', async (t) => {
  const { app, deps } = setup();
  t.after(() => app.close());
  const get = await app.inject('/api/transcripts/root');
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json(), { root: '/saved/root' });

  const put = await app.inject({ method: 'PUT', url: '/api/transcripts/root', payload: { root: '/chosen' } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { ok: true, root: '/chosen' });
  deps.setSessionsRoot = async () => ({ ok: false, error: 'bad root' });
  const invalid = await app.inject({ method: 'PUT', url: '/api/transcripts/root', payload: { root: '../escape' } });
  assert.equal(invalid.statusCode, 200);
  assert.deepEqual(invalid.json(), { ok: false, error: 'bad root' });
  deps.setSessionsRoot = async () => { throw new Error('persist failed'); };
  const failed = await app.inject({ method: 'PUT', url: '/api/transcripts/root', payload: { root: '/chosen' } });
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.json(), { statusCode: 500, error: 'Internal Server Error', message: 'persist failed' });
});

test('transcript list forwards cap, root, live callback, and review filter', async (t) => {
  const { app, calls, deps, reg } = setup({ listSessions: async (options) => { calls.list = options; return [{ id: 'one' }]; } });
  t.after(() => app.close());
  const response = await app.inject('/api/transcripts?cap=12&root=%2Froot&hideReviews=1');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { sessions: [{ id: 'one' }] });
  assert.equal(calls.list.cap, 12);
  assert.equal(calls.list.root, '/root');
  assert.equal(calls.list.hideReviews, true);
  // Main passed the codex-aware `reg.isLiveSession` (`66591a9:server/index.mjs:919`):
  // a codex row's id is its rollout thread uuid, so liveness resolves to the live owner.
  // VERIFY: wave5-js_followup-2
  reg.snapshot = () => [
    { id: 'codex-live', cwd: '/repo', tool: 'codex' },
    { id: 'codex-dead', cwd: '/repo', tool: 'codex' },
    { id: 'claude-live', cwd: '/other', tool: 'claude' },
  ];
  reg.isLive = (id) => id === 'codex-live' || id === 'claude-live';
  reg.codexThreadFor = async (id) => ({ 'codex-live': 'thread-live', 'codex-dead': 'thread-dead' }[id] ?? null);
  await app.inject('/api/transcripts');
  const isLive = calls.list.isLive;
  assert.equal(isLive('claude-live', { source: 'claude', cwd: '/other' }), true);
  assert.equal(isLive('thread-live', { source: 'codex', cwd: '/repo' }), true);
  assert.equal(isLive('thread-live', { source: 'codex', cwd: '/elsewhere' }), false);
  assert.equal(isLive('thread-dead', { source: 'codex', cwd: '/repo' }), false);
  assert.equal(isLive('thread-live', { source: 'claude', cwd: '/repo' }), false);
  // An async thread lookup failure leaves the row non-live; the list still serves.
  reg.codexThreadFor = async () => { throw new Error('lookup failed'); };
  const degraded = await app.inject('/api/transcripts');
  assert.equal(degraded.statusCode, 200);
  assert.equal(calls.list.isLive('thread-live', { source: 'codex', cwd: '/repo' }), false);
  const defaultCap = await app.inject('/api/transcripts?cap=0&hideReviews=0');
  assert.equal(defaultCap.statusCode, 200);
  assert.equal(calls.list.cap, 5000);
  assert.equal(calls.list.hideReviews, false);
  deps.listSessions = async () => { throw new Error('list failed'); };
  const failed = await app.inject('/api/transcripts');
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().message, 'list failed');
});

test('transcript read validates, maps misses, enriches both registry identities, and reports I/O errors', async (t) => {
  const { app, deps, reg, calls } = setup();
  t.after(() => app.close());
  const missing = await app.inject('/api/transcript?id=only');
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(missing.json(), { ok: false, error: 'project + id required' });
  const notFound = await app.inject('/api/transcript?project=p&id=missing');
  assert.equal(notFound.statusCode, 404);
  assert.deepEqual(notFound.json(), { ok: false, error: 'not found' });

  deps.readSession = async (...args) => { calls.read = args; return { ok: true, meta: { cwd: '/repo' }, messages: [] }; };
  reg.getLaunchConfig = (id) => id === 'claude-id' ? { scopes: ['/claude-scope'] } : null;
  const claude = await app.inject('/api/transcript?project=p&id=claude-id&root=%2Froot&source=claude&file=f');
  assert.equal(claude.statusCode, 200);
  assert.deepEqual(claude.json().meta.scopes, ['/claude-scope']);
  assert.deepEqual(calls.read, ['p', 'claude-id', '/root', 'claude', 'f']);

  reg.getLaunchConfigForCodexThread = async (id, cwd) => {
    assert.equal(id, 'thread-id');
    assert.equal(cwd, '/repo');
    return { scopes: ['/codex-scope'] };
  };
  const codex = await app.inject('/api/transcript?project=p&id=thread-id&source=codex');
  assert.equal(codex.statusCode, 200);
  assert.deepEqual(codex.json().meta.scopes, ['/codex-scope']);
  deps.readSession = async () => { throw new Error('disk failed'); };
  const failed = await app.inject('/api/transcript?project=p&id=io');
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().message, 'disk failed');
});

test('transcript search forwards filters, returns capped results, and reports backend errors', async (t) => {
  const { app, calls, deps } = setup({ searchSessions: async (...args) => { calls.search = args; return { results: [{ id: 'hit' }], capped: true }; } });
  t.after(() => app.close());
  const response = await app.inject('/api/transcripts/search?q=needle&project=p&id=i&root=%2Froot&hideReviews=1');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { results: [{ id: 'hit' }], capped: true });
  assert.deepEqual(calls.search, ['needle', { project: 'p', id: 'i', root: '/root', hideReviews: true }]);
  deps.searchSessions = async () => { throw new Error('search failed'); };
  const failed = await app.inject('/api/transcripts/search?q=x');
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.json().message, 'search failed');
});

test('subagents scans only eligible registry rows and omits empty groups', async (t) => {
  const { app, calls, reg, deps } = setup();
  t.after(() => app.close());
  reg.snapshot = () => [
    { id: 'running', cwd: '/a', status: 'running' },
    { id: 'idle', cwd: '/b', status: 'idle' },
    { id: 'starting', cwd: '/c', status: 'starting' },
    { id: 'stopped', cwd: '/d', status: 'stopped' },
  ];
  deps.subagentsFor = async (_cwd, id, isLive) => {
    calls.subagents.push([_cwd, id, isLive]);
    return id === 'idle' ? [{ id: 'child' }] : [];
  };
  calls.subagents = [];
  const response = await app.inject('/api/subagents');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { subagents: { idle: [{ id: 'child' }] } });
  assert.deepEqual(calls.subagents.map(([, id]) => id), ['running', 'idle', 'starting']);
  assert.ok(calls.subagents.every(([, , isLive]) => isLive === reg.isLive));
});

test('Codex thread registry route preserves missing, unmapped, and mapped responses', async (t) => {
  const { app, reg } = setup();
  t.after(() => app.close());
  const missing = await app.inject('/api/transcripts/codex-thread');
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(missing.json(), { ok: false, error: 'id required' });
  const absent = await app.inject('/api/transcripts/codex-thread?id=agent');
  assert.equal(absent.statusCode, 404);
  assert.deepEqual(absent.json(), { ok: false, error: 'not found' });
  reg.codexThreadFor = async (id) => id === 'agent' ? 'thread-uuid' : null;
  const found = await app.inject('/api/transcripts/codex-thread?id=agent');
  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json(), { ok: true, threadId: 'thread-uuid' });
});

test('Rust-backed session adapter serves a transcript through the HTTP registrar', async () => {
  const state = await mkdtemp(join(tmpdir(), 'sing-transcript-http-state-'));
  const root = await mkdtemp(join(tmpdir(), 'sing-transcript-http-root-'));
  process.env.SINGULARITY_HOME = state;
  process.env.CODEX_HOME = join(state, 'codex');
  const modelStore = await import('./model-store.mjs');
  const { createRustBackend } = await import('./rust-backend.mjs');
  const backend = createRustBackend();
  const sessions = await import('./sessions.mjs');
  const app = Fastify();
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'hello over HTTP' }, timestamp: '2026-10-21T00:00:00Z' })}\n`);
  try {
    await backend.start();
    sessions.setTranscriptBackend(backend);
    modelStore.setModelsBackend(backend);
    registerTranscriptRoutes(app, {
      reg: {
        isLive: () => false,
        snapshot: () => [],
        codexThreadFor: async () => null,
        getLaunchConfig: () => null,
        getLaunchConfigForCodexThread: async () => null,
      },
      listSessions: sessions.listSessions,
      readSession: sessions.readSession,
      searchSessions: sessions.searchSessions,
      subagentsFor: sessions.subagentsFor,
      getSessionsRoot: sessions.getSessionsRoot,
      setSessionsRoot: sessions.setSessionsRoot,
    });
    const response = await app.inject(`/transcript?project=project&id=session&root=${encodeURIComponent(root)}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().messages[0].text, 'hello over HTTP');
  } finally {
    await app.close();
    await backend.stop();
    await rm(state, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
