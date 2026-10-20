import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

// rules.mjs imports app-dir.mjs (STATE_DIR), which throws without SINGULARITY_HOME.
// Point it at a scratch temp dir before a dynamic import (static imports hoist).
process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
// Isolate RULES_REF_DIR from the real ~/.agents/rules-reference so tests can
// plant reference files without touching the user's FS. Must precede the import.
process.env.SING_RULES_REF = mkdtempSync(join(tmpdir(), 'sing-rules-ref-'));
const { getRulesRoots, setRulesRoots, isRulePath, readRuleFile, createRuleWriteHandler, createRuleReferenceHandler, createRuleFilesHandler, createRuleSearchHandler } = await import('./rules.mjs');

// A base root's rules live at <base>/.claude/rules — make + return that dir.
const mkRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'sing-rules-'));
  const dir = join(root, '.claude', 'rules');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
};

test('rules roots persist to FS: default ~, dedup, roundtrip', () => {
  assert.deepEqual(getRulesRoots(), ['~']); // seeded default when file absent
  const { root } = mkRoot();
  const r = setRulesRoots([root, root, 123, '']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.roots, [root]); // deduped, non-strings dropped
  assert.deepEqual(getRulesRoots(), [root]); // read back from disk
});

// The walk and content search run in Rust (rust-backend.test.mjs holds the
// real-child coverage); rules.mjs owns root resolution and the HTTP mapping.
test('rules files and search handlers resolve scan dirs and pass payloads through', async () => {
  const app = Fastify();
  const { root, dir } = mkRoot();
  const seen = [];
  const backend = {
    ruleFiles: async (scans) => {
      seen.push(['files', scans]);
      return { files: [{ root: '~', path: 'p', rel: 'r', file: 'f' }], capped: false };
    },
    ruleSearch: async (scans, q) => {
      seen.push(['search', scans, q]);
      return { results: [{ root: '~', path: 'p', rel: 'r', file: 'f', line: 1, text: 't' }], capped: false };
    },
  };
  app.post('/rules/files', createRuleFilesHandler(backend, app.log));
  app.post('/rules/search', createRuleSearchHandler(backend, app.log));
  try {
    const listed = await app.inject({ method: 'POST', url: '/rules/files', payload: { roots: ['~', root, 123, ''] } });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), { files: [{ root: '~', path: 'p', rel: 'r', file: 'f' }], capped: false });
    const searched = await app.inject({ method: 'POST', url: '/rules/search', payload: { roots: [root], q: 'find' } });
    assert.equal(searched.statusCode, 200);
    assert.deepEqual(searched.json(), { results: [{ root: '~', path: 'p', rel: 'r', file: 'f', line: 1, text: 't' }], capped: false });
    const noBody = await app.inject({ method: 'POST', url: '/rules/files' });
    assert.equal(noBody.statusCode, 200);
    assert.deepEqual(seen, [
      // '~' resolves to the home rules dir; the mkRoot base resolves to its
      // <base>/.claude/rules; non-string/empty/unresolvable bases drop silently.
      ['files', [
        { root: '~', dir: join(homedir(), '.claude', 'rules') },
        { root, dir },
      ]],
      ['search', [{ root, dir }], 'find'],
      ['files', []],
    ]);
  } finally { await app.close(); }
});

test('rules files and search backend failures map to explicit 500 responses', async () => {
  const app = Fastify();
  const backend = {
    ruleFiles: async () => { throw new Error('child exited'); },
    ruleSearch: async () => { throw new Error('child exited'); },
  };
  app.post('/rules/files', createRuleFilesHandler(backend, app.log));
  app.post('/rules/search', createRuleSearchHandler(backend, app.log));
  const files = await app.inject({ method: 'POST', url: '/rules/files', payload: { roots: [] } });
  assert.equal(files.statusCode, 500);
  assert.deepEqual(files.json(), { ok: false, error: 'rules files backend unavailable' });
  const search = await app.inject({ method: 'POST', url: '/rules/search', payload: { roots: [], q: 'x' } });
  assert.equal(search.statusCode, 500);
  assert.deepEqual(search.json(), { ok: false, error: 'rules search backend unavailable' });
  await app.close();
});

test('isRulePath rejects a path outside all persisted rules dirs', () => {
  const { root, dir } = mkRoot();
  writeFileSync(join(dir, 'a.md'), 'x');
  setRulesRoots([root]);

  assert.equal(isRulePath(join(dir, 'a.md')), true);
  assert.equal(isRulePath(join(root, 'a.md')), false); // base itself, not under .claude/rules
  assert.equal(isRulePath(join(dir, 'sub', '..', '..', 'escape.md')), false);
  assert.equal(isRulePath(join(tmpdir(), 'outside.md')), false); // outside any root
  assert.equal(isRulePath(join(dir, 'a.txt')), false); // wrong ext
  assert.equal(isRulePath(''), false);
  assert.equal(isRulePath(null), false);
});

test('Rules write handler authorizes in Node and sends empty content through Rust', async () => {
  const app = Fastify();
  const { root, dir } = mkRoot();
  setRulesRoots([root]);
  const p = join(dir, 'note.md');
  const calls = [];
  app.put('/rules/file', createRuleWriteHandler({
    ruleWrite: async (...args) => { calls.push(args); return { ok: true, mtime: 1234.5 }; },
  }, app.log));
  try {
    const saved = await app.inject({ method: 'PUT', url: '/rules/file', payload: { path: p, content: '' } });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json(), { ok: true, mtime: 1234.5 });
    const outside = await app.inject({ method: 'PUT', url: '/rules/file', payload: { path: join(root, 'outside.md'), content: 'x' } });
    assert.equal(outside.statusCode, 400);
    const missing = await app.inject({ method: 'PUT', url: '/rules/file', payload: { path: p } });
    assert.equal(missing.statusCode, 400);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [p, '', undefined, undefined]);
  } finally { await app.close(); }
});

test('readRuleFile reports mtime on success', () => {
  const { root, dir } = mkRoot();
  setRulesRoots([root]);
  const p = join(dir, 'mt.md');
  writeFileSync(p, 'body');
  const r = readRuleFile(p);
  assert.equal(r.ok, true);
  assert.equal(typeof r.mtime, 'number');
  assert.ok(r.mtime > 0);
});

test('Rules write handler maps conflicts and transport failures', async () => {
  const app = Fastify();
  const { root, dir } = mkRoot();
  setRulesRoots([root]);
  const p = join(dir, 'g.md');
  app.put('/rules/file', createRuleWriteHandler({
    ruleWrite: async () => ({ ok: false, error: 'changed on disk' }),
  }, app.log));
  app.put('/transport', createRuleWriteHandler({ ruleWrite: async () => { throw new Error('child exited'); } }, app.log));
  try {
    const conflict = await app.inject({ method: 'PUT', url: '/rules/file', payload: { path: p, content: 'v2', mtime: 10 } });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { ok: false, error: 'changed on disk' });
    const transport = await app.inject({ method: 'PUT', url: '/transport', payload: { path: p, content: 'x' } });
    assert.equal(transport.statusCode, 500);
    assert.deepEqual(transport.json(), { ok: false, error: 'rules write backend unavailable' });
  } finally { await app.close(); }
});

// Reference lookup runs in Rust (see rust-backend.test.mjs for the real-child
// coverage); rules.mjs owns the configured root and the HTTP mapping.
test('rules reference handler passes the configured root and preserves payload and HTTP mapping', async () => {
  const app = Fastify();
  const refDir = process.env.SING_RULES_REF;
  const backend = {
    ruleReference: async (path, root) => {
      assert.equal(root, refDir); // SING_RULES_REF captured at import is passed per call
      if (path === 'skills.md') return { ok: true, path: join(root, 'skills-reference.md'), content: '# reference body' };
      if (path === 'lonely.md') return { ok: false, error: 'no reference' };
      return { ok: false, error: 'no path' };
    },
  };
  app.get('/rules/reference', createRuleReferenceHandler(backend, app.log));
  try {
    const hit = await app.inject('/rules/reference?path=skills.md');
    assert.equal(hit.statusCode, 200);
    assert.deepEqual(hit.json(), { ok: true, path: join(refDir, 'skills-reference.md'), content: '# reference body' });
    const missing = await app.inject('/rules/reference?path=lonely.md');
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { ok: false, error: 'no reference' });
    const empty = await app.inject('/rules/reference');
    assert.equal(empty.statusCode, 400);
    assert.deepEqual(empty.json(), { ok: false, error: 'no path' });
  } finally { await app.close(); }
});

test('rules reference backend failures map to explicit 500 responses', async () => {
  const app = Fastify();
  const backend = { ruleReference: async () => { throw new Error('child exited'); } };
  app.get('/rules/reference', createRuleReferenceHandler(backend, app.log));
  const response = await app.inject('/rules/reference?path=x.md');
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), { ok: false, error: 'rules reference backend unavailable' });
  await app.close();
});
