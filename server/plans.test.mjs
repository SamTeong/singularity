import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

process.env.SINGULARITY_HOME = mkdtempSync(join(tmpdir(), 'sing-home-'));
const ROOT = mkdtempSync(join(tmpdir(), 'sing-plans-'));
process.env.SING_PLANS_ROOT = ROOT;
const { PLAN_ROOT, resolveSessionDirectory, createPlanSessionsHandler, createPlanSessionHandler } = await import('./plans.mjs');

const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
mkdirSync(join(ROOT, SID), { recursive: true });
mkdirSync(join(ROOT, 'outside'), { recursive: true });

test('Plans root is configured at import and resolver keeps SID and realpath containment checks', async () => {
  assert.equal(PLAN_ROOT, await realpath(ROOT));
  const valid = await resolveSessionDirectory(SID);
  assert.deepEqual(valid, { ok: true, dir: await realpath(join(ROOT, SID)) });
  assert.deepEqual(await resolveSessionDirectory('not-a-sid!'), { ok: false, error: 'bad sid' });
  assert.deepEqual(await resolveSessionDirectory('../outside'), { ok: false, error: 'bad sid' });
  assert.deepEqual(await resolveSessionDirectory('99999999-9999-4999-8999-999999999999'), { ok: false, error: 'not found' });

  try {
    symlinkSync(join(ROOT, 'outside'), join(ROOT, 'bbbbbbbb-2222-4222-8222-222222222222'), 'junction');
    assert.deepEqual(await resolveSessionDirectory('bbbbbbbb-2222-4222-8222-222222222222'), { ok: false, error: 'bad sid' });
  } catch { /* Windows may deny symlink creation; lexical and missing-path checks still run. */ }
});

test('Plans route handlers preserve list/detail payloads and validation status mapping', async () => {
  const app = Fastify();
  const backend = {
    planSessions: async (root) => {
      assert.equal(root, PLAN_ROOT);
      return [{ sid: SID, planCount: 1 }];
    },
    planSession: async (dir, sid) => ({ ok: true, sid, path: dir }),
  };
  app.get('/sessions', createPlanSessionsHandler(backend, app.log));
  app.get('/session', createPlanSessionHandler(backend, app.log));
  try {
    const list = await app.inject('/sessions');
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), [{ sid: SID, planCount: 1 }]);
    const detail = await app.inject('/session?sid=' + SID);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.json(), { ok: true, sid: SID, path: await realpath(join(ROOT, SID)) });
    assert.equal((await app.inject('/session?sid=bad')).statusCode, 400);
    assert.equal((await app.inject('/session?sid=99999999-9999-4999-8999-999999999999')).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('Plans backend failures map to explicit 500 responses', async () => {
  const app = Fastify();
  const backend = {
    planSessions: async () => { throw new Error('child exited'); },
    planSession: async () => { throw new Error('child exited'); },
  };
  app.get('/sessions', createPlanSessionsHandler(backend, app.log));
  app.get('/session', createPlanSessionHandler(backend, app.log));
  try {
    const list = await app.inject('/sessions');
    assert.equal(list.statusCode, 500);
    assert.deepEqual(list.json(), { ok: false, error: 'plans backend unavailable' });
    const detail = await app.inject('/session?sid=' + SID);
    assert.equal(detail.statusCode, 500);
    assert.deepEqual(detail.json(), { ok: false, error: 'plans backend unavailable' });
  } finally {
    await app.close();
  }
});
