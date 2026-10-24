import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createModelPricesHandler, createModelsHandlers, createRustBackend, createWikiGraphHandler } from './rust-backend.mjs';

test('Rust Git subprocess preserves argv, environment, streams, stdin, timeout, and errors', async () => {
  const backend = createRustBackend();
  const fixture = fileURLToPath(new URL('./git-process-fixture.mjs', import.meta.url));
  try {
    await backend.start();
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: 'echo' };
    const argv = await backend.git(process.execPath, [fixture, 'args-env', 'one value', 'two'], { env, timeout: 3000, maxBuffer: 1024 * 1024 });
    assert.equal(argv.stdout, 'one value|two|0|never|echo');
    const streams = await backend.git(process.execPath, [fixture, 'streams'], { env, timeout: 3000, maxBuffer: 1024 * 1024 });
    assert.equal(Buffer.byteLength(streams.stdout), 700 * 1024);

    await assert.rejects(backend.git(process.execPath, [fixture, 'multiline-error'], { env, timeout: 3000 }), (error) => {
      assert.match(error.message, /first error line\nsecond error line/);
      assert.equal(error.code, 7);
      assert.equal(error.killed, false);
      assert.equal(error.stdout, 'partial stdout');
      assert.equal(error.stderr, 'first error line\nsecond error line\n');
      return true;
    });
    await assert.rejects(backend.git('singularity-git-missing-executable', [], { env, timeout: 3000 }), (error) => error.code === 'ENOENT');
    await assert.rejects(backend.git(tmpdir(), [], { env, timeout: 3000 }), (error) => {
      assert.notEqual(error.code, 'ENOENT');
      assert.equal(error.code, 'EACCES');
      assert.ok(error.cause);
      return true;
    });
    await assert.rejects(backend.git(process.execPath, [fixture, 'sleep'], { env, timeout: 100 }), (error) => error.killed && error.signal === 'SIGKILL');
    await assert.rejects(backend.git(process.execPath, [fixture, 'wait-stdin'], { env, timeout: 100 }), (error) => error.killed && error.signal === 'SIGKILL');
    for (const mode of ['over-stdout', 'over-stderr']) {
      await assert.rejects(backend.git(process.execPath, [fixture, mode], { env, timeout: 3000, maxBuffer: 1024 * 1024 }), (error) => {
        assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        assert.equal(error.killed, true);
        assert.equal(error.signal, 'SIGKILL');
        assert.equal(Buffer.byteLength(mode === 'over-stdout' ? error.stdout : error.stderr), 1024 * 1024);
        return true;
      });
    }
  } finally { await backend.stop(); }
});

async function wiki(root, name, files) {
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, name, rel);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
}

test('Rust detached spawn returns immediately, inherits cwd and environment, and reports spawn failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-detached-'));
  const marker = join(root, 'child.txt');
  const backend = createRustBackend();
  const oldMarker = process.env.SINGULARITY_DETACHED_MARKER;
  const oldValue = process.env.SINGULARITY_DETACHED_VALUE;
  try {
    await backend.start();
    process.env.SINGULARITY_DETACHED_MARKER = marker;
    process.env.SINGULARITY_DETACHED_VALUE = 'bridge-inherited';
    const started = Date.now();
    await backend.spawnDetached(process.execPath, [fileURLToPath(new URL('./detached-child-fixture.mjs', import.meta.url)), 'argv-value'], root);
    assert.ok(Date.now() - started < 300, 'spawn should return before the synthetic child finishes');
    if (oldMarker === undefined) delete process.env.SINGULARITY_DETACHED_MARKER;
    else process.env.SINGULARITY_DETACHED_MARKER = oldMarker;
    if (oldValue === undefined) delete process.env.SINGULARITY_DETACHED_VALUE;
    else process.env.SINGULARITY_DETACHED_VALUE = oldValue;
    await backend.stop();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { await access(marker); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.equal(await readFile(marker, 'utf8'), `${root}|argv-value|bridge-inherited`);
    const failureBackend = createRustBackend();
    try {
      await failureBackend.start();
      await assert.rejects(failureBackend.spawnDetached('singularity-command-that-does-not-exist', []), /failed to spawn/);
    } finally { await failureBackend.stop(); }
  } finally {
    if (oldMarker === undefined) delete process.env.SINGULARITY_DETACHED_MARKER;
    else process.env.SINGULARITY_DETACHED_MARKER = oldMarker;
    if (oldValue === undefined) delete process.env.SINGULARITY_DETACHED_VALUE;
    else process.env.SINGULARITY_DETACHED_VALUE = oldValue;
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  }
});

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

test('Codex usage bridge sends correlated handle requests without credential values', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let sent;
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    sent = JSON.parse(String(chunk));
    requests.push(sent);
    const response = sent.op === 'codex_usage_begin' ? { kind: 'ready', handle: 'opaque-fixture' }
      : sent.op === 'codex_usage_fetch' ? { kind: 'no_sessions' } : { released: true };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: sent.id, response })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  try {
    await backend.start();
    const begun = await backend.codexUsageBegin('C:/fixture/codex/auth.json');
    assert.deepEqual(begun, { kind: 'ready', handle: 'opaque-fixture' });
    assert.deepEqual(await backend.codexUsageFetch(begun.handle), { kind: 'no_sessions' });
    assert.deepEqual(await backend.codexUsageRelease(begun.handle), { released: true });
    assert.deepEqual(requests.map(({ op }) => op), ['codex_usage_begin', 'codex_usage_fetch', 'codex_usage_release']);
    assert.equal(requests[0].path, 'C:/fixture/codex/auth.json');
    assert.equal(requests[1].credential_handle, 'opaque-fixture');
    for (const request of requests) {
      assert.equal(typeof request.id, 'string');
      assert.equal(Object.hasOwn(request, 'token'), false);
      assert.equal(Object.hasOwn(request, 'account_id'), false);
    }
  } finally { await backend.stop(); }
});

test('Codex usage result bridge resolves failure DTOs and rejects backend errors', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let requestCount = 0;
  child.stdin.write = (chunk, callback) => {
    const sent = JSON.parse(String(chunk));
    const response = requestCount++ === 0
      ? { ok: false, source: 'codex', error: 'auth rejected', fetchedAt: '2026-10-24T00:00:00.000Z' }
      : { error: 'bad request' };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: sent.id, response })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  try {
    await backend.start();
    const failureDto = await backend.codexUsageResult({ status: 401 });
    assert.deepEqual(failureDto, {
      ok: false, source: 'codex', error: 'auth rejected', fetchedAt: '2026-10-24T00:00:00.000Z',
    });
    await assert.rejects(backend.codexUsageResult({ status: 401 }), /bad request/);
  } finally { await backend.stop(); }
});

test('Codex fingerprint bridge sends only the configured path and returns digest or null', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    const sent = JSON.parse(String(chunk));
    requests.push(sent);
    const response = requests.length === 1 ? 'a'.repeat(64)
      : requests.length === 2 ? null : 'synthetic-account-secret';
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: sent.id, response })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  try {
    await backend.start();
    assert.equal(await backend.codexAccountFingerprint('C:/fixture/codex/auth.json'), 'a'.repeat(64));
    assert.equal(await backend.codexAccountFingerprint('C:/fixture/missing-auth.json'), null);
    assert.equal(await backend.codexAccountFingerprint('C:/fixture/unexpected-response.json'), null);
    assert.deepEqual(requests.map(({ op, path }) => [op, path]), [
      ['codex_account_fingerprint', 'C:/fixture/codex/auth.json'],
      ['codex_account_fingerprint', 'C:/fixture/missing-auth.json'],
      ['codex_account_fingerprint', 'C:/fixture/unexpected-response.json'],
    ]);
    for (const request of requests) {
      assert.equal(typeof request.id, 'string');
      assert.equal(Object.hasOwn(request, 'credential_text'), false);
      assert.equal(Object.hasOwn(request, 'account_id'), false);
      assert.equal(Object.hasOwn(request, 'access_token'), false);
    }
  } finally { await backend.stop(); }
});

test('Claude usage bridge correlates its private token request and returns no token field', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let sent;
  child.stdin.write = (chunk, callback) => {
    sent = JSON.parse(String(chunk));
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: sent.id, response: { kind: 'response', status: 200, retry_after: null, body: { ok: '{}' } } })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  const token = 'synthetic-bridge-token';
  try {
    await backend.start();
    const response = await backend.claudeUsageFetch(token);
    assert.deepEqual(response, { kind: 'response', status: 200, retry_after: null, body: { ok: '{}' } });
    assert.equal(sent.op, 'claude_usage_fetch');
    assert.equal(sent.access_token, token);
    assert.equal(typeof sent.id, 'string');
    assert.equal(Object.hasOwn(response, 'access_token'), false);
    assert.equal(JSON.stringify(response).includes(token), false);
  } finally { await backend.stop(); }
});

test('Claude OAuth bridge carries opaque body text with its deadline and exposes no request body in the response', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  let sent;
  child.stdin.write = (chunk, callback) => {
    sent = JSON.parse(String(chunk));
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: sent.id, response: { kind: 'response', status: 429, retry_after: '66', body: { ok: null } } })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  const body = '{"grant_type":"refresh_token","refresh_token":{"opaque":17},"client_id":"fixed"}';
  try {
    await backend.start();
    const response = await backend.claudeOauthRefresh(body, null, 800);
    assert.deepEqual(response, { kind: 'response', status: 429, retry_after: '66', body: { ok: null } });
    assert.equal(sent.op, 'claude_oauth_refresh');
    assert.equal(sent.oauth_body, body);
    assert.ok(sent.header_timeout_ms > 0 && sent.header_timeout_ms <= 800);
    assert.equal(JSON.stringify(response).includes(body), false);
  } finally { await backend.stop(); }
});

test('Claude credential bridge returns raw text and fixed missing/read-failure outcomes', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  const stderr = [];
  const originalStderrWrite = process.stderr.write;
  process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
  child.stdin.write = (chunk, callback) => {
    const sent = JSON.parse(String(chunk));
    requests.push(sent);
    const response = sent.op === 'claude_credentials_write'
      ? { ok: !sent.path.endsWith('write-false') }
      : sent.path.endsWith('rejected') ? null
      : sent.path.endsWith('missing') ? { kind: 'missing' }
      : sent.path.endsWith('failure') ? { kind: 'read_failure' }
        : { kind: 'file', text: '{"claudeAiOauth":{"accessToken":"synthetic-secret"}}' };
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(response === null ? { id: sent.id } : { id: sent.id, response })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  try {
    await backend.start();
    child.stderr.write('synthetic backend diagnostic\n');
    const raw = await backend.claudeCredentialsRead('C:/fixture/.credentials.json');
    assert.deepEqual(raw, { kind: 'file', text: '{"claudeAiOauth":{"accessToken":"synthetic-secret"}}' });
    const credentialText = '{"claudeAiOauth":{"accessToken":"synthetic-write-secret"}}';
    assert.equal(await backend.claudeCredentialsWrite('C:/fixture/.credentials.json', 'C:/fixture/.credentials.json.321.tmp', credentialText), true);
    assert.equal(await backend.claudeCredentialsWrite('C:/fixture/write-false', 'C:/fixture/write-false.321.tmp', credentialText), false);
    assert.deepEqual(await backend.claudeCredentialsRead('C:/fixture/missing'), { kind: 'missing' });
    assert.deepEqual(await backend.claudeCredentialsRead('C:/fixture/failure'), { kind: 'read_failure' });
    await assert.rejects(backend.claudeCredentialsRead('C:/fixture/rejected'), (error) => {
      assert.equal(error.message.includes('synthetic-secret'), false);
      return /uncorrelated response/.test(error.message);
    });
    assert.deepEqual(requests.map(({ op }) => op), ['claude_credentials_read', 'claude_credentials_write', 'claude_credentials_write', 'claude_credentials_read', 'claude_credentials_read', 'claude_credentials_read']);
    assert.equal(requests[0].path, 'C:/fixture/.credentials.json');
    assert.deepEqual(requests[1], {
      op: 'claude_credentials_write',
      path: 'C:/fixture/.credentials.json',
      temp_path: 'C:/fixture/.credentials.json.321.tmp',
      credential_text: credentialText,
      id: 'rust-2',
    });
    assert.equal(JSON.stringify(raw).includes('synthetic-secret'), true);
    assert.equal(Object.hasOwn(raw, 'error'), false);
    assert.equal(stderr.join('').includes('synthetic-secret'), false);
    assert.equal(stderr.join('').includes('synthetic-write-secret'), false);
  } finally {
    await backend.stop();
    process.stderr.write = originalStderrWrite;
  }
});

test('Claude usage bridge forwards remaining header budget and cancels an expired queued request', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    requests.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  try {
    await backend.start();
    const blocker = backend.sysStats();
    const controller = new AbortController();
    const delayed = backend.claudeUsageFetch('synthetic-queued-token', controller.signal, 500);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(requests.map(({ op }) => op), ['sysstats_get']);
    child.stdout.write(`${JSON.stringify({ id: requests[0].id, response: { ok: true } })}\n`);
    assert.deepEqual(await blocker, { ok: true });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].op, 'claude_usage_fetch');
    assert.ok(requests[1].header_timeout_ms > 0 && requests[1].header_timeout_ms < 500);
    child.stdout.write(`${JSON.stringify({ id: requests[1].id, response: { kind: 'response', status: 200, body: { ok: '{}' } } })}\n`);
    assert.equal((await delayed).status, 200);

    const nextBlocker = backend.sysStats();
    const expired = backend.claudeUsageFetch('synthetic-expired-token', null, 20);
    await new Promise((resolve) => setTimeout(resolve, 30));
    child.stdout.write(`${JSON.stringify({ id: requests[2].id, response: { ok: true } })}\n`);
    await nextBlocker;
    await assert.rejects(expired, /This operation was aborted/);
    assert.equal(requests.length, 3);
  } finally { await backend.stop(); }
});

test('Rust status replies bypass ordinary FIFO and correlate out of order', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    const request = JSON.parse(String(chunk));
    requests.push(request);
    if (request.op !== 'status_get') queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, response: { type: 'status_reply', id: 'payload-id', ok: true } })}\n`));
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.write('{"ready":true}\n');
    });
    return child;
  } });
  try {
    await backend.start();
    const first = backend.statusGet();
    const ordinary = await backend.sysStats();
    assert.deepEqual(ordinary, { type: 'status_reply', id: 'payload-id', ok: true });
    const second = backend.statusGet(true);
    const statuses = requests.filter(({ op }) => op === 'status_get');
    assert.equal(statuses.length, 2);
    assert.notEqual(statuses[0].id, statuses[1].id);
    assert.equal(statuses[0].force, false);
    assert.equal(statuses[1].force, true);
    child.stdout.write(`${JSON.stringify({ id: statuses[1].id, type: 'status_reply', response: { done: 2 } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: statuses[0].id, type: 'status_reply', response: { done: 1 } })}\n`);
    assert.deepEqual(await second, { done: 2 });
    assert.deepEqual(await first, { done: 1 });
  } finally { await backend.stop(); }
});

test('Rust async one-shot FIFO leaves ordinary and status requests independent', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    const request = JSON.parse(String(chunk));
    requests.push(request);
    if (request.op === 'sysstats_get') {
      const count = requests.filter(({ op }) => op === 'sysstats_get').length;
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, response: { ordinary: count } })}\n`));
    }
    callback?.();
    return true;
  };
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  try {
    await backend.start();
    const first = backend.oneShot('synthetic-cli', ['first'], { timeout: 1000 });
    const second = backend.oneShot('synthetic-cli', ['second'], { timeout: 1000 });
    const ordinary = backend.sysStats();
    const ordinaryNext = backend.sysStats();
    const status = backend.statusGet(true);
    assert.deepEqual(await ordinary, { ordinary: 1 });
    assert.deepEqual(await ordinaryNext, { ordinary: 2 });
    assert.deepEqual(requests.filter(({ op }) => op === 'sysstats_get').map(({ id }) => id), ['rust-3', 'rust-4']);
    const statusRequest = requests.find(({ op }) => op === 'status_get');
    child.stdout.write(`${JSON.stringify({ id: statusRequest.id, type: 'status_reply', response: { status: 'ready' } })}\n`);
    assert.deepEqual(await status, { status: 'ready' });
    assert.deepEqual(requests.filter(({ op }) => op === 'oneshot_async').map(({ args }) => args), [['first']]);

    const firstRequest = requests.find(({ op }) => op === 'oneshot_async');
    child.stdout.write(`${JSON.stringify({ type: 'oneshot_reply', id: firstRequest.id, response: { ok: true, stdout: 'first-output' } })}\n`);
    assert.deepEqual(await first, { stdout: 'first-output' });
    const oneShots = requests.filter(({ op }) => op === 'oneshot_async');
    assert.deepEqual(oneShots.map(({ args }) => args), [['first'], ['second']]);
    child.stdout.write(`${JSON.stringify({ type: 'oneshot_reply', id: oneShots[1].id, response: { ok: true, stdout: 'second-output' } })}\n`);
    assert.deepEqual(await second, { stdout: 'second-output' });
  } finally { await backend.stop(); }
});

test('Rust async one-shot rejects malformed and duplicate reply frames through bridge failure', async () => {
  const makeBackend = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const requests = [];
    child.stdin.write = (chunk, callback) => {
      requests.push(JSON.parse(String(chunk)));
      callback?.();
      return true;
    };
    child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
    const backend = createRustBackend({ spawnProcess: () => {
      queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
      return child;
    } });
    return { backend, child, requests };
  };

  const malformed = makeBackend();
  await malformed.backend.start();
  const malformedPending = malformed.backend.oneShot('synthetic-cli', [], { timeout: 1000 });
  malformed.child.stdout.write(`${JSON.stringify({ type: 'oneshot_reply', id: malformed.requests[0].id })}\n`);
  await assert.rejects(malformedPending, /malformed one-shot reply/);
  await malformed.backend.stop();

  const duplicate = makeBackend();
  await duplicate.backend.start();
  const completed = duplicate.backend.oneShot('synthetic-cli', [], { timeout: 1000 });
  const id = duplicate.requests[0].id;
  duplicate.child.stdout.write(`${JSON.stringify({ type: 'oneshot_reply', id, response: { ok: true, stdout: 'done' } })}\n`);
  assert.deepEqual(await completed, { stdout: 'done' });
  const ordinaryPending = duplicate.backend.sysStats();
  duplicate.child.stdout.write(`${JSON.stringify({ type: 'oneshot_reply', id, response: { ok: true, stdout: 'duplicate' } })}\n`);
  await assert.rejects(ordinaryPending, /unknown one-shot reply ID/);
  await duplicate.backend.stop();
});

test('Rust async one-shot stop rejects dispatched and queued calls and ends stdin', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    requests.push(JSON.parse(String(chunk)));
    callback?.();
    return true;
  };
  let stdinEnded = false;
  child.stdin.end = () => {
    stdinEnded = true;
    queueMicrotask(() => child.emit('exit', 0, null));
  };
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => child.stdout.write('{"ready":true}\n'));
    return child;
  } });
  await backend.start();
  const dispatched = backend.oneShot('synthetic-cli', ['dispatched'], { timeout: 1000 });
  const queued = backend.oneShot('synthetic-cli', ['queued'], { timeout: 1000 });
  const dispatchedRejected = assert.rejects(dispatched, /Rust backend stopped/);
  const queuedRejected = assert.rejects(queued, /Rust backend stopped/);
  await backend.stop();
  await Promise.all([dispatchedRejected, queuedRejected]);
  assert.equal(stdinEnded, true);
  assert.deepEqual(requests.filter(({ op }) => op === 'oneshot_async').map(({ args }) => args), [['dispatched']]);
});

test('Rust bridge rejects pending status requests on exit and stop', async () => {
  const makeBackend = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.write = (_chunk, callback) => { callback?.(); return true; };
    child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
    child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
    const backend = createRustBackend({ spawnProcess: () => {
      queueMicrotask(() => {
        child.emit('spawn');
        child.stdout.write('{"ready":true}\n');
      });
      return child;
    } });
    return { backend, child };
  };

  const exited = makeBackend();
  await exited.backend.start();
  const onExit = exited.backend.statusGet();
  exited.child.emit('exit', 7, null);
  await assert.rejects(onExit, /exited \(7\)/);

  const stopped = makeBackend();
  await stopped.backend.start();
  const onStop = stopped.backend.statusGet();
  await stopped.backend.stop();
  await assert.rejects(onStop, /Rust backend stopped/);
});

test('Rust pricing read normalizes the explicit path without writing and maps transport failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singularity-rust-prices-'));
  process.env.SINGULARITY_HOME = root;
  process.env.USAGE_REPORT_STATE = join(root, 'selected');
  const { createModelPricesPutHandler, getModelPricesForUsageHistory, getModelPricesPath } = await import('./model-prices.mjs');
  const missing = join(root, 'selected', 'pricing.json');
  assert.equal(getModelPricesPath(), missing);
  const backend = createRustBackend();
  const app = Fastify();
  app.get('/api/models/prices', createModelPricesHandler(backend, missing, app.log));
  let writeDispatches = 0;
  const productionPutHandler = createModelPricesPutHandler(
    (path, text) => { writeDispatches += 1; return backend.modelPricesWrite(path, text); }, getModelPricesPath(),
  );
  app.put('/api/models/prices', productionPutHandler);
  const blocked = join(root, 'blocked');
  await writeFile(blocked, 'file blocks parent directory creation');
  app.put('/api/models/prices-failure', createModelPricesPutHandler(
    (path, text) => backend.modelPricesWrite(path, text), join(blocked, 'pricing.json'),
  ));
  let releaseWrite;
  let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const blockedWrite = new Promise((resolve) => { releaseWrite = resolve; });
  app.put('/api/models/prices-completion', createModelPricesPutHandler(async (path, text) => {
    writeStarted();
    await blockedWrite;
    await backend.modelPricesWrite(path, text);
  }, missing));
  try {
    await backend.start();
    const absent = await app.inject({ url: '/api/models/prices' });
    assert.equal(absent.statusCode, 200);
    assert.deepEqual(absent.json(), { base: {}, above_200k: {}, long_context_threshold: 200000, default_key: '' });
    await assert.rejects(access(missing));

    const submitted = {
      base: { opus: [15, 75, 1.5, 18.75] }, above_200k: {},
      long_context_threshold: 200000, default_key: '', path: join(root, 'attacker.json'),
    };
    const saved = await app.inject({ method: 'PUT', url: '/api/models/prices', payload: submitted });
    const expected = { base: submitted.base, above_200k: {}, long_context_threshold: 200000, default_key: '' };
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json(), expected);
    assert.equal(await readFile(missing, 'utf8'), JSON.stringify(expected, null, 2));
    assert.deepEqual(getModelPricesForUsageHistory(), expected);
    await assert.rejects(access(join(root, 'attacker.json')));

    let responseSettled = false;
    const pendingResponse = app.inject({ method: 'PUT', url: '/api/models/prices-completion', payload: submitted })
      .then((response) => { responseSettled = true; return response; });
    await started;
    assert.equal(responseSettled, false);
    releaseWrite();
    const completedResponse = await pendingResponse;
    assert.equal(completedResponse.statusCode, 200);
    assert.equal(responseSettled, true);

    const savedBytes = await readFile(missing);
    const dispatchesBeforeInvalid = writeDispatches;
    const invalid = await app.inject({ method: 'PUT', url: '/api/models/prices', payload: { ...submitted, long_context_threshold: 0 } });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: 'long_context_threshold must be a positive integer' });
    assert.equal(writeDispatches, dispatchesBeforeInvalid);
    assert.deepEqual(await readFile(missing), savedBytes);
    const failedWrite = await app.inject({ method: 'PUT', url: '/api/models/prices-failure', payload: expected });
    assert.equal(failedWrite.statusCode, 400);
    assert.equal(typeof failedWrite.json().error, 'string');
    assert.ok(failedWrite.json().error.length > 0);

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
      '{"base":{"model":[1e400,-1e400,-0,4],"nested":[1e400,{"deep":-1e400,"negativeZero":-0}]},"long_context_threshold":1e400,"default_key":1e400}',
    ];
    for (const overflowCase of overflowCases) {
      await writeFile(missing, overflowCase);
      assert.deepEqual(await backend.modelPrices(missing), getModelPricesForUsageHistory());
    }
    const overflowReferenced = await backend.modelPrices(missing);
    assert.equal(overflowReferenced.base.model[0], Infinity);
    assert.equal(overflowReferenced.base.model[1], -Infinity);
    assert.equal(Object.is(overflowReferenced.base.model[2], -0), true);
    assert.equal(overflowReferenced.base.nested[0], Infinity);
    assert.equal(overflowReferenced.base.nested[1].deep, -Infinity);
    assert.equal(Object.is(overflowReferenced.base.nested[1].negativeZero, -0), true);
    assert.equal(overflowReferenced.long_context_threshold, 200000);
    assert.equal(overflowReferenced.default_key, '');

    const rawControl = String.fromCharCode(1);
    for (const invalidControl of [
      `{"base":{"model":[1,2,3,4],"bad${rawControl}key":[1,2,3,4]}}`,
      `{"base":{"model":[1,2,3,4]},"unknown":"bad${rawControl}value"}`,
    ]) {
      await writeFile(missing, invalidControl);
      assert.deepEqual(await backend.modelPrices(missing), getModelPricesForUsageHistory());
    }

    await writeFile(missing, '{"base":{"\\u0001":[1,2,3,4]},"unknown":"\\u0001"}');
    const escapedControl = await backend.modelPrices(missing);
    assert.deepEqual(Object.keys(escapedControl.base), ['\u0001']);
    assert.deepEqual(escapedControl.base['\u0001'], [1, 2, 3, 4]);

    const duplicateBase = '{"base":{"z":[1,2,3,4],"a":[1,2,3,4]},"base":{"c":[1,2,3,4],"b":[1,2,3,4]}}';
    await writeFile(missing, duplicateBase);
    const duplicateBaseDoc = await backend.modelPrices(missing);
    assert.deepEqual(duplicateBaseDoc, getModelPricesForUsageHistory());
    assert.deepEqual(Object.keys(duplicateBaseDoc.base), ['c', 'b']);

    for (const depth of [127, 128, 129]) {
      let nested = '1';
      for (let level = 0; level < depth - 2; level += 1) nested = `[${nested}]`;
      await writeFile(missing, `{"base":{"model":${nested}}}`);
      const deepDoc = await backend.modelPrices(missing);
      assert.deepEqual(deepDoc, getModelPricesForUsageHistory());
      assert.deepEqual(Object.keys(deepDoc.base), ['model']);
    }

    const loneSurrogate = '{"base":{"\\ud800":[1,2,3,4]}}';
    await writeFile(missing, loneSurrogate);
    const loneDoc = await backend.modelPrices(missing);
    assert.deepEqual(loneDoc, getModelPricesForUsageHistory());
    assert.deepEqual(Object.keys(loneDoc.base), ['\ud800']);
    assert.equal(Object.hasOwn(loneDoc.base, '\ud800'), true);

    const binaryPath = process.env.SINGULARITY_RUST_BACKEND_BINARY
      ?? fileURLToPath(new URL(`../rust/backend/target/release/${process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend'}`, import.meta.url));
    const rawChild = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const rawLines = createInterface({ input: rawChild.stdout });
    let rawReadyResolve;
    let rawReplyResolve;
    const rawReady = new Promise((resolve) => { rawReadyResolve = resolve; });
    const rawReply = new Promise((resolve) => { rawReplyResolve = resolve; });
    rawLines.on('line', (line) => {
      const frame = JSON.parse(line);
      if (frame.ready === true) rawReadyResolve();
      if (frame.id === 'pricing-surrogate-raw') rawReplyResolve(line);
    });
    await rawReady;
    rawChild.stdin.write(`${JSON.stringify({ op: 'model_prices', id: 'pricing-surrogate-raw', path: missing })}\n`);
    const rawLine = await rawReply;
    assert.ok(rawLine.includes('"\\ud800"'), 'raw JSON keeps the lone surrogate escaped');
    const rawFrame = JSON.parse(rawLine);
    assert.equal(Object.hasOwn(rawFrame.response.pricing.base, '\ud800'), true);
    rawChild.stdin.end();
    await new Promise((resolve) => rawChild.once('exit', resolve));
    rawLines.close();

    const malformedKey = Buffer.concat([Buffer.from('{"base":{"'), Buffer.from([0xff]), Buffer.from('":[1,2,3,4]}}')]);
    await writeFile(missing, malformedKey);
    const malformedDoc = await backend.modelPrices(missing);
    assert.deepEqual(malformedDoc, getModelPricesForUsageHistory());
    assert.deepEqual(Object.keys(malformedDoc.base), ['�']);

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

test('Rust stdio bridge writes Codex Config with UTF-8, coercions, stale guard, and no parent creation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-codex-config-write-'));
  const path = join(base, '.codex', 'config.toml');
  await mkdir(join(base, '.codex'), { recursive: true });
  await writeFile(path, 'prior');
  const backend = createRustBackend();
  try {
    await backend.start();
    const saved = await backend.codexConfigWrite(path, 'model = "更新 ✓"', null, false);
    assert.deepEqual(Object.keys(saved).sort(), ['mtime', 'ok']);
    assert.equal(saved.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'model = "更新 ✓"');
    assert.ok(Math.abs(saved.mtime - (await (await import('node:fs/promises')).stat(path)).mtimeMs) < 2);

    const empty = await backend.codexConfigWrite(path, '', String(saved.mtime), false);
    assert.equal(empty.ok, true);
    assert.equal(await readFile(path, 'utf8'), '');

    await writeFile(path, 'external');
    const future = new Date(Date.now() + 5000);
    await utimes(path, future, future);
    const stale = await backend.codexConfigWrite(path, 'rejected', saved.mtime, false);
    assert.deepEqual(stale, { ok: false, error: 'changed on disk' });
    assert.equal(await readFile(path, 'utf8'), 'external');

    const forced = await backend.codexConfigWrite(path, 'forced', saved.mtime, 'false');
    assert.equal(forced.ok, true);
    assert.equal(await readFile(path, 'utf8'), 'forced');

    const unguarded = await backend.codexConfigWrite(path, 'unguarded', 'not-a-number', false);
    assert.equal(unguarded.ok, true);

    const missing = join(base, 'absent', '.codex', 'config.toml');
    const failed = await backend.codexConfigWrite(missing, '', null, false);
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

test('Rust Explorer state bridge reads and merges one fresh fixed state file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'singularity-rust-explorer-state-'));
  const statePath = join(home, 'state', 'explorer-state.json');
  const backend = createRustBackend();
  const defaults = { root: '~', expanded: [], tabs: [], active: null, autosave: false };
  try {
    await backend.start();
    assert.deepEqual(await backend.explorerStateGet(statePath), defaults);
    const saved = await backend.explorerStateSet(statePath, {
      root: ' ~/work ', tabs: ['/a', 1, '/b'], expanded: ['/z', 1, '/a'],
      active: '/a', autosave: true, custom: 'ignored',
    });
    assert.deepEqual(Object.keys(saved), ['ok', 'state']);
    assert.deepEqual(saved.state, {
      ...defaults, root: ' ~/work ', tabs: ['/a', '/b'], expanded: ['/z', '/a'], active: '/a', autosave: true,
    });
    const clearActive = await backend.explorerStateSet(statePath, { active: null });
    assert.equal(clearActive.state.active, null);

    await writeFile(statePath, JSON.stringify({ root: 7, unknown: { retained: true }, tabs: 'legacy' }));
    assert.deepEqual(await backend.explorerStateGet(statePath), {
      ...defaults, root: 7, unknown: { retained: true }, tabs: 'legacy',
    });
    const noop = await backend.explorerStateSet(statePath, null);
    assert.equal(noop.ok, true);
    assert.deepEqual(noop.state.unknown, { retained: true });
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), noop.state);

    await writeFile(statePath, '{ malformed');
    assert.deepEqual(await backend.explorerStateGet(statePath), defaults);
    assert.equal(await readFile(statePath, 'utf8'), '{ malformed');

    const blocker = join(home, 'file-blocker');
    await writeFile(blocker, 'file');
    const failed = await backend.explorerStateSet(join(blocker, 'state.json'), null);
    assert.equal(failed.ok, false);
    assert.equal(typeof failed.error, 'string');
  } finally {
    await backend.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('Rust Explorer filesystem bridge mutates isolated files and directories', async () => {
  const home = await mkdtemp(join(tmpdir(), 'singularity-rust-explorer-fs-'));
  const backend = createRustBackend();
  const path = (...parts) => join(home, ...parts);
  try {
    await backend.start();
    const target = path('nested', 'file.txt');
    const parentFailure = await backend.explorerCreate(path('missing', 'file.txt'), 'unknown');
    assert.equal(parentFailure.ok, false);
    assert.deepEqual(await backend.explorerCreate(path('nested', 'child'), 'dir'), { ok: true });
    const emptyWrite = await backend.explorerWrite(target, '', null, false);
    assert.equal(emptyWrite.ok, true);
    assert.equal(typeof emptyWrite.mtime, 'number');
    await writeFile(target, 'external');
    assert.deepEqual(await backend.explorerWrite(target, 'stale', 0, false), { ok: false, error: 'changed on disk' });
    assert.deepEqual(await backend.explorerWrite(target, 'forced', 0, true).then(({ ok, mtime }) => ({ ok, hasMtime: typeof mtime === 'number' })), { ok: true, hasMtime: true });
    assert.equal(await readFile(target, 'utf8'), 'forced');

    const collision = path('taken.txt');
    await writeFile(collision, 'keep');
    assert.equal((await backend.explorerRename(target, collision)).ok, false);
    assert.equal((await backend.explorerRename(path('missing-source'), collision)).ok, false);
    assert.deepEqual(await backend.explorerRename(target, path('renamed.txt')), { ok: true });
    assert.deepEqual(await backend.explorerDelete(path('nested')), { ok: true });
    assert.equal((await backend.explorerDelete(path('nested'))).ok, false);
    assert.equal(await readFile(collision, 'utf8'), 'keep');
  } finally {
    await backend.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test('Rust one-shot bridge execs a binary and maps stdout, failure, and timeout', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-oneshot-'));
  const backend = createRustBackend();
  try {
    await backend.start();
    const okScript = join(base, 'ok.mjs');
    const failScript = join(base, 'fail.mjs');
    const slowScript = join(base, 'slow.mjs');
    const envScript = join(base, 'env.mjs');
    const bigScript = join(base, 'big.mjs');
    await writeFile(okScript, "process.stdout.write('bridge-ok');");
    await writeFile(failScript, "process.stdout.write('bridge-boom'); process.exit(3);");
    await writeFile(slowScript, 'setTimeout(() => {}, 5000);');
    await writeFile(envScript, "process.stdout.write(process.env.SING_BRIDGE_PROBE ?? 'unset');");
    await writeFile(bigScript, "process.stdout.write('x'.repeat(64));");

    const ok = await backend.oneShot(process.execPath, [okScript], { timeout: 10_000 });
    assert.equal(ok.stdout, 'bridge-ok');

    const env = await backend.oneShot(process.execPath, [envScript], {
      timeout: 10_000, env: { SING_BRIDGE_PROBE: 'bridge-env-ok' },
    });
    assert.equal(env.stdout, 'bridge-env-ok');

    await assert.rejects(backend.oneShot(process.execPath, [bigScript], { timeout: 10_000, maxBuffer: 8 }), (error) => {
      assert.match(error.message, /Command failed:/);
      assert.ok(error.stdout.length > 8, 'captured stdout should exceed the 8-byte cap');
      return true;
    });

    await assert.rejects(backend.oneShot(process.execPath, [failScript], { timeout: 10_000 }), (error) => {
      assert.match(error.message, /Command failed:/);
      assert.equal(error.code, 3);
      assert.equal(error.killed, false);
      assert.equal(error.stdout, 'bridge-boom');
      return true;
    });

    await assert.rejects(backend.oneShot(process.execPath, [slowScript], { timeout: 200 }), (error) => {
      assert.match(error.message, /timed out after 200ms/);
      assert.equal(error.killed, true);
      return true;
    });
  } finally {
    await backend.stop();
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust async one-shot drains a synthetic child and replies before direct EOF exit', async () => {
  const base = await mkdtemp(join(tmpdir(), 'singularity-rust-oneshot-eof-'));
  const script = join(base, 'delayed.mjs');
  const binaryPath = process.env.SINGULARITY_RUST_BACKEND_BINARY
    ?? fileURLToPath(new URL(`../rust/backend/target/release/${process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend'}`, import.meta.url));
  await writeFile(script, 'setTimeout(() => process.stdout.write("eof-drained"), 250);');
  const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let readyResolve;
  let readyReject;
  const replyResolvers = new Map();
  let replyObserved = false;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })));
  lines.on('line', (line) => {
    const frame = JSON.parse(line);
    if (frame.ready === true) readyResolve();
    if (frame.type === 'oneshot_reply') {
      replyObserved = true;
      replyResolvers.get(frame.id)?.(frame);
    }
  });
  child.once('error', (error) => {
    readyReject(error);
  });
  try {
    await ready;
    const waitForReply = (id) => new Promise((resolveReply) => replyResolvers.set(id, resolveReply));
    const reply = waitForReply('eof-drain-check');
    const overlap = waitForReply('eof-overlap-check');
    const exitBeforeReply = exited.then((exit) => ({ exitBeforeReply: exit }));
    for (const id of ['eof-drain-check', 'eof-overlap-check']) {
      child.stdin.write(`${JSON.stringify({
        op: 'oneshot_async', id, bin: process.execPath, args: [script],
        timeout_ms: 5000, max_buffer: null, env: null,
      })}\n`);
    }
    child.stdin.end();
    const overlapResult = await Promise.race([overlap.then((frame) => ({ frame })), exited.then((exit) => ({ exitBeforeOverlap: exit }))]);
    assert.equal(Object.hasOwn(overlapResult, 'frame'), true, `Rust backend exited before rejecting overlap (${overlapResult.exitBeforeOverlap?.signal || overlapResult.exitBeforeOverlap?.code})`);
    assert.equal(overlapResult.frame.response.error, 'async one-shot already running');
    const result = await Promise.race([reply.then((frame) => ({ frame })), exitBeforeReply]);
    assert.equal(Object.hasOwn(result, 'frame'), true, `Rust backend exited before its one-shot reply (${result.exitBeforeReply?.signal || result.exitBeforeReply?.code})`);
    const { frame } = result;
    assert.equal(child.exitCode, null, 'reply must arrive while Rust is still alive');
    assert.equal(replyObserved, true);
    assert.equal(frame.id, 'eof-drain-check');
    assert.equal(frame.response.ok, true);
    assert.equal(frame.response.stdout, 'eof-drained');
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally {
    lines.close();
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
    await rm(base, { recursive: true, force: true });
  }
});

test('Rust usage auth bridge keeps platform and attempted-auth outcomes private', async () => {
  const backend = createRustBackend();
  try {
    await backend.start();
    assert.equal(await backend.usageKeychain('win32', process.execPath), null);
    assert.equal(await backend.usageKeychain('darwin', process.execPath), null);
    assert.deepEqual(await backend.usageAuthStatus(process.execPath, 10_000), { attempted: true });
    assert.deepEqual(await backend.usageAuthStatus(join(tmpdir(), 'missing-usage-auth-cli'), 10_000), { attempted: true });
  } finally {
    await backend.stop();
  }
});

test('Rust usage auth bridge forwards the current environment in both private requests', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.end = () => {
    queueMicrotask(() => child.emit('exit', 0, null));
  };
  child.kill = () => {
    queueMicrotask(() => child.emit('exit', 0, null));
    return true;
  };
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    const request = JSON.parse(String(chunk));
    requests.push(request);
    queueMicrotask(() => {
      const response = request.op === 'usage_keychain' ? { ok: false } : { attempted: true };
      child.stdout.write(`${JSON.stringify({ id: request.id, response })}\n`);
      callback?.();
    });
    return true;
  };
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => {
      child.emit('spawn');
      child.stdout.write('{"ready":true}\n');
    });
    return child;
  } });
  const key = 'SINGULARITY_TEST_AUTH_ENV';
  const previous = process.env[key];
  const marker = 'synthetic-bridge-auth-env-marker';
  process.env[key] = marker;
  try {
    await backend.start();
    assert.equal(await backend.usageKeychain('darwin', 'synthetic-security'), null);
    assert.deepEqual(await backend.usageAuthStatus('synthetic-claude', 10_000), { attempted: true });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ op, env }) => [op, env[key]]), [
      ['usage_keychain', marker],
      ['usage_auth_status', marker],
    ]);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await backend.stop();
  }
});

test('Rust Ollama config bridge preserves its private payloads and stable filesystem errors', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.end = () => queueMicrotask(() => child.emit('exit', 0, null));
  child.kill = () => { queueMicrotask(() => child.emit('exit', 0, null)); return true; };
  const requests = [];
  child.stdin.write = (chunk, callback) => {
    const request = JSON.parse(String(chunk));
    requests.push(request);
    const response = request.op.endsWith('_read')
      ? { kind: 'file', text: '{"mode":"browser"}' }
      : request.path === 'failure-path'
        ? { kind: 'error', path: request.path, operation: 'rename', error_kind: 'permission-denied' }
        : { ok: true };
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: request.id, response })}\n`);
      callback?.();
    });
    return true;
  };
  const backend = createRustBackend({ spawnProcess: () => {
    queueMicrotask(() => { child.emit('spawn'); child.stdout.write('{"ready":true}\n'); });
    return child;
  } });
  try {
    await backend.start();
    assert.deepEqual(await backend.ollamaModeConfigRead('scratch/ollama.json'), {
      kind: 'file', text: '{"mode":"browser"}',
    });
    assert.equal(await backend.ollamaModeConfigWrite('scratch/ollama.json', 'scratch/ollama.json.7.9.tmp', '{"mode":"browser"}'), true);
    assert.deepEqual(requests.map(({ op, path, temp_path, ollama_config_text }) => [op, path, temp_path, ollama_config_text]), [
      ['ollama_mode_config_read', 'scratch/ollama.json', undefined, undefined],
      ['ollama_mode_config_write', 'scratch/ollama.json', 'scratch/ollama.json.7.9.tmp', '{"mode":"browser"}'],
    ]);
    await assert.rejects(backend.ollamaModeConfigWrite('failure-path', 'failure-path.7.9.tmp', '{}'),
      /^Error: bad failure-path: rename failed \(permission-denied\)$/);
  } finally {
    await backend.stop();
  }
});

test('Rust process classifier bridge uses the supplied post-query identity snapshot', async () => {
  const backend = createRustBackend();
  try {
    await backend.start();
    const rows = await backend.procsClassify({
      platform: 'windows',
      alive: [],
      rows: [{ pid: 41, ppid: 1, name: 'claude.exe', started: '2025-01-02T03:04:05', cmd: 'claude.exe --resume wrapper-session' }],
    }, [], ['wrapper-session'], 'C:/repo', 900);
    assert.deepEqual(rows, [{
      pid: 41, ppid: 1, name: 'claude.exe', started: '2025-01-02T03:04:05', session: 'wrapper-session', kind: 'tracked',
    }]);
  } finally {
    await backend.stop();
  }
});

test('Rust procs kill bridge terminates a scratch child and rejects bad pids', async () => {
  const backend = createRustBackend();
  try {
    await backend.start();
    assert.deepEqual(await backend.procsKill('x'), { ok: false, error: 'bad pid' });
    assert.deepEqual(await backend.procsKill(0), { ok: false, error: 'kill ESRCH' });
    const missing = await backend.procsKill(2_000_000_000);
    assert.equal(missing.ok, false);
    assert.match(missing.error, /^kill E/);
    // a pid no live process owns: only the test's own scratch child, killed here
    const slow = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => slow.once('exit', resolve));
    try {
      assert.deepEqual(await backend.procsKill(slow.pid), { ok: true });
      await exited; // the scratch child is gone: kill really terminated it
    } finally { slow.kill(); }
  } finally {
    await backend.stop();
  }
});

test('Rust window-anchor bridge persists configured state and telemetry paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'singularity-rust-window-anchor-'));
  const statePath = join(home, 'custom-state', 'window-anchor.json');
  const telemetryPath = join(home, 'custom-usage', 'window-anchor-runs.jsonl');
  const backend = createRustBackend();
  const state = { claude: { enabled: true, lastResult: 'Ok' }, codex: { enabled: false } };
  try {
    await backend.start();
    await mkdir(join(home, 'custom-state'), { recursive: true });
    const initialized = await backend.windowAnchorRequest('window_anchor_init', {
      state_path: statePath,
      telemetry_path: telemetryPath,
      window_anchor_env: 'claude',
      now_ms: 0,
    });
    assert.equal(initialized.snapshot.claude.enabled, true);
    assert.equal(initialized.snapshot.codex.enabled, false);
    assert.deepEqual((await backend.windowAnchorRequest('window_anchor_snapshot', { now_ms: 1 })).snapshot, initialized.snapshot);
    const firstAdmission = await backend.windowAnchorRequest('window_anchor_poke', {
      provider: 'claude', force: true, started_at_ms: 100_000, now_ms: 100_000,
    });
    const secondAdmission = await backend.windowAnchorRequest('window_anchor_poke', {
      provider: 'claude', force: true, started_at_ms: 200_000, now_ms: 200_000,
    });
    const firstAction = firstAdmission.effects.find((effect) => effect.type === 'run_action');
    const secondAction = secondAdmission.effects.find((effect) => effect.type === 'run_action');
    assert.ok(firstAction?.action_id);
    assert.ok(secondAction?.action_id);
    assert.notEqual(firstAction.action_id, secondAction.action_id);
    await backend.windowAnchorRequest('window_anchor_action_result', {
      action_id: secondAction.action_id, outcome: 'error', error: 'later action failed', ended_at_ms: 250_000, now_ms: 250_000,
    });
    await backend.windowAnchorRequest('window_anchor_action_result', {
      action_id: firstAction.action_id, outcome: 'ok', ended_at_ms: 300_000, now_ms: 300_000,
    });
    const completed = (await backend.windowAnchorRequest('window_anchor_snapshot', { now_ms: 300_001 })).snapshot;
    assert.equal(completed.claude.lastResult, 'Ok');
    assert.equal(completed.claude.lastAnchorAt, 300_000);
    assert.equal(await backend.windowAnchorLoad(statePath), null);
    await backend.windowAnchorSave(statePath, state);
    assert.equal(await readFile(statePath, 'utf8'), JSON.stringify(state, null, 2));
    assert.deepEqual(await backend.windowAnchorLoad(statePath), state);
    const record = { provider: 'claude', result: 'Ok', usage: { input_tokens: 3 } };
    await backend.windowAnchorTelemetry(telemetryPath, record);
    assert.deepEqual(JSON.parse((await readFile(telemetryPath, 'utf8')).trim()), record);
    await assert.rejects(backend.windowAnchorSave(join(home, 'missing', 'parent.json'), state), /No such file|os error/);
  } finally {
    await backend.stop();
    await rm(home, { recursive: true, force: true });
  }
});
