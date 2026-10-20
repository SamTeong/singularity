import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createExternalSessionLaunchHandler, createSessionFolderOpenHandler } from './detached-launch.mjs';

test('external launch keeps the registry row on spawn failure and removes it after accepted spawn', async () => {
  let removed = false;
  let acceptSpawn;
  let markSpawnStarted;
  const spawnStarted = new Promise((resolveStarted) => { markSpawnStarted = resolveStarted; });
  const app = Fastify();
  app.post('/session/external', createExternalSessionLaunchHandler({
    reg: {
      externalLaunch: async () => ({ ok: true, launcher: 'terminal', launcherArgs: ['--new-window'], cwd: 'C:/repo' }),
      remove: () => { removed = true; },
    },
    rustBackend: { spawnDetached: () => new Promise((resolve) => { acceptSpawn = resolve; markSpawnStarted(); }) },
  }));
  try {
    const pending = app.inject({ method: 'POST', url: '/session/external', payload: { id: 'session-1' } });
    await spawnStarted;
    assert.equal(removed, false);
    acceptSpawn({ ok: true });
    const success = await pending;
    assert.equal(success.statusCode, 200);
    assert.deepEqual(success.json(), { ok: true });
    assert.equal(removed, true);
  } finally { await app.close(); }

  const failedApp = Fastify();
  let preserved = true;
  failedApp.post('/session/external', createExternalSessionLaunchHandler({
    reg: {
      externalLaunch: async () => ({ ok: true, launcher: 'terminal', launcherArgs: [], cwd: 'C:/repo' }),
      remove: () => { preserved = false; },
    },
    rustBackend: { spawnDetached: async () => { throw new Error('launch denied'); } },
  }));
  try {
    const failed = await failedApp.inject({ method: 'POST', url: '/session/external', payload: { id: 'session-2' } });
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.json(), { ok: false, error: 'launch denied' });
    assert.equal(preserved, true);
  } finally { await failedApp.close(); }
});

test('session-folder launch is Windows-only and inherits cwd', async () => {
  const calls = [];
  const app = Fastify();
  app.post('/plans/open', createSessionFolderOpenHandler({
    resolveSessionDirectory: async () => ({ ok: true, dir: 'C:/plans/session' }),
    rustBackend: { spawnDetached: async (...args) => { calls.push(args); return { ok: true }; } },
    platform: 'win32',
    systemRoot: 'D:/Windows',
  }));
  try {
    const opened = await app.inject({ method: 'POST', url: '/plans/open', payload: { sid: 'valid' } });
    assert.equal(opened.statusCode, 200);
    assert.deepEqual(opened.json(), { ok: true });
    assert.deepEqual(calls, [[resolve('D:/Windows', 'explorer.exe'), ['C:/plans/session']]]);
  } finally { await app.close(); }

  const unsupported = Fastify();
  let spawned = false;
  unsupported.post('/plans/open', createSessionFolderOpenHandler({
    resolveSessionDirectory: async () => ({ ok: true, dir: '/plans/session' }),
    rustBackend: { spawnDetached: async () => { spawned = true; } },
    platform: 'darwin',
  }));
  try {
    const response = await unsupported.inject({ method: 'POST', url: '/plans/open', payload: { sid: 'valid' } });
    assert.equal(response.statusCode, 501);
    assert.deepEqual(response.json(), { ok: false, error: 'unsupported platform' });
    assert.equal(spawned, false);
  } finally { await unsupported.close(); }
});

test('session-folder launch maps spawn failures to stable response text', async () => {
  const app = Fastify();
  app.post('/plans/open', createSessionFolderOpenHandler({
    resolveSessionDirectory: async () => ({ ok: true, dir: 'C:/plans/session' }),
    rustBackend: { spawnDetached: async () => { throw new Error('unavailable'); } },
    platform: 'win32',
  }));
  try {
    const response = await app.inject({ method: 'POST', url: '/plans/open', payload: { sid: 'valid' } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { ok: false, error: 'failed to open session folder' });
  } finally { await app.close(); }
});
