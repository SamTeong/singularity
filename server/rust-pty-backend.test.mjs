import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRustBackend } from './rust-backend.mjs';
import { createRustPtyBackend } from './rust-pty-backend.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixture = path.join(here, 'fixtures', 'rust-pty-child.mjs');
const fakeService = path.join(here, 'fixtures', 'rust-pty-protocol-fixture.mjs');
const binary = process.env.SINGULARITY_RUST_PTY_BINARY
  ?? path.join(root, 'rust', 'backend', 'target', 'debug', process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend');

function fakeBackend() {
  return createRustPtyBackend({ executable: process.execPath, args: [fakeService], cwd: root, logger: { error() {} } });
}

function handlers(handle) {
  const events = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  handle.onData((text) => {
    events.push({ type: 'data', text });
  });
  handle.onExit((exitCode) => { events.push({ type: 'exit', exitCode }); resolveExit(exitCode); });
  return { events, exited, activate: () => handle.activate() };
}

test('buffers early split UTF-8 output until handlers activate and drains it before exit', async (t) => {
  const backend = fakeBackend();
  t.after(() => backend.stop());
  const handle = await backend.spawn({ id: 'early', bin: 'early', args: [], cwd: root, env: {} });
  const seen = handlers(handle);
  assert.deepEqual(seen.events, []);
  seen.activate();
  assert.equal(await seen.exited, 0);
  assert.deepEqual(seen.events, [{ type: 'data', text: '€' }, { type: 'exit', exitCode: 0 }]);
});

test('flushes final service frames and UTF-8 decoder tail before unexpected service exit', async (t) => {
  const backend = fakeBackend();
  t.after(() => backend.stop());
  const handle = await backend.spawn({ id: 'final', bin: 'final-exit', args: [], cwd: root, env: {} });
  const seen = handlers(handle);
  seen.activate();
  assert.equal(await seen.exited, 17);
  assert.deepEqual(seen.events, [{ type: 'data', text: '€' }, { type: 'exit', exitCode: 17 }]);
});

test('waits for child close after stdout closes before reporting service exit', async (t) => {
  const backend = fakeBackend();
  t.after(() => backend.stop());
  const handle = await backend.spawn({ id: 'stdout-first', bin: 'stdout-closes-first', args: [], cwd: root, env: {} });
  const seen = handlers(handle);
  seen.activate();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(seen.events, []);
  assert.equal(await seen.exited, 0);
  assert.deepEqual(seen.events, [{ type: 'exit', exitCode: 0 }]);
});

test('spawn failures reject and later generations ignore stale output', async (t) => {
  const backend = fakeBackend();
  t.after(() => backend.stop());
  await assert.rejects(backend.spawn({ id: 'bad', bin: 'fail', args: [], cwd: root, env: {} }), /fixture spawn failure/);
  const first = await backend.spawn({ id: 'same', bin: 'ok', args: [], cwd: root, env: {} });
  const firstSeen = handlers(first);
  firstSeen.activate();
  const second = await backend.spawn({ id: 'same', bin: 'ok', args: [], cwd: root, env: {} });
  const secondSeen = handlers(second);
  secondSeen.activate();
  assert.equal(second.generation, first.generation + 1);
  assert.deepEqual(firstSeen.events, []);
  assert.deepEqual(secondSeen.events, []);
});

test('real PTY preserves command cwd/env and round-trips input, resize, kill, and exit', { skip: !existsSync(binary) && 'Build rust/backend first' }, async (t) => {
  const backend = createRustPtyBackend({ executable: binary, cwd: root, env: process.env, logger: { error() {} } });
  t.after(() => backend.stop());
  t.after(() => backend.stop());
  const handle = await backend.spawn({
    id: 'real', bin: process.execPath, args: [fixture], cwd: root,
    env: { ...process.env, PTY_TEST_ENV: 'bridge-env' }, cols: 80, rows: 24,
  });
  const seen = handlers(handle);
  seen.activate();
  await waitForOutput(seen.events, /READY:/);
  assert.ok(seen.events.some((event) => event.text?.includes(`${root}:bridge-env`)));
  assert.ok(!seen.events.some((event) => event.text?.includes('\u001b[6n')), 'ConPTY startup query must be handled internally');
  await handle.write('PING\r');
  await waitForOutput(seen.events, /GOT:PING/);
  await handle.resize(100, 40);
  await handle.kill();
  await Promise.race([seen.exited, new Promise((_, reject) => setTimeout(() => reject(new Error('PTY exit exceeded 5 seconds')), 5000))]);
  assert.equal(seen.events.at(-1).type, 'exit');
});

test('real PTY drains split final UTF-8 output before child exit', { skip: !existsSync(binary) && 'Build rust/backend first' }, async (t) => {
  const backend = createRustPtyBackend({ executable: binary, cwd: root, env: process.env, logger: { error() {} } });
  t.after(() => backend.stop());
  const handle = await backend.spawn({ id: 'final-output', bin: process.execPath, args: [fixture, '--final-split'], cwd: root, env: process.env });
  const seen = handlers(handle);
  seen.activate();
  assert.equal(await Promise.race([seen.exited, new Promise((_, reject) => setTimeout(() => reject(new Error('PTY exit exceeded 5 seconds')), 5000))]), 23);
  assert.equal(seen.events.at(-1).type, 'exit');
  assert.equal(seen.events.slice(0, -1).map((event) => event.text).join('').includes('€'), true);
});

test('backpressured PTY writes do not block resize or kill, and service stop reaps children', { skip: !existsSync(binary) && 'Build rust/backend first' }, async (t) => {
  const backend = createRustPtyBackend({ executable: binary, cwd: root, env: process.env, logger: { error() {} } });
  t.after(() => backend.stop());
  const handle = await backend.spawn({ id: 'blocked', bin: process.execPath, args: [fixture, '--no-read'], cwd: root, env: process.env });
  const seen = handlers(handle);
  seen.activate();
  await waitForOutput(seen.events, /READY/);
  await handle.write('x'.repeat(1024 * 1024));
  const started = Date.now();
  await handle.resize(120, 42).catch((error) => { throw new Error(`${error.message}; events: ${JSON.stringify(seen.events)}`); });
  await handle.kill();
  assert.ok(Date.now() - started < 1000, 'resize and kill should be accepted within one second');
  await Promise.race([seen.exited, new Promise((_, reject) => setTimeout(() => reject(new Error('PTY exit exceeded 5 seconds')), 5000))]);
  await backend.stop();
});

test('slow ordinary one-shot does not delay dedicated PTY controls', { skip: !existsSync(binary) && 'Build rust/backend first' }, async (t) => {
  const ordinary = createRustBackend({ binaryPath: binary });
  const pty = createRustPtyBackend({ executable: binary, cwd: root, env: process.env, logger: { error() {} } });
  t.after(() => ordinary.stop());
  t.after(() => pty.stop());
  await ordinary.start();
  const slow = ordinary.oneShot(process.execPath, [fixture, '--slow'], { timeout: 5000 });
  const handle = await pty.spawn({ id: 'independent-control', bin: process.execPath, args: [fixture, '--no-read'], cwd: root, env: process.env });
  const seen = handlers(handle);
  seen.activate();
  await waitForOutput(seen.events, /READY/);
  await handle.write('x'.repeat(1024 * 1024));
  const started = Date.now();
  await handle.resize(120, 42);
  await handle.kill();
  assert.ok(Date.now() - started < 1000, 'PTY controls should remain responsive during an ordinary one-shot');
  await Promise.race([seen.exited, new Promise((_, reject) => setTimeout(() => reject(new Error('PTY exit exceeded 5 seconds')), 5000))]);
  assert.equal((await slow).stdout, 'SLOW_DONE');
});

async function waitForOutput(events, pattern) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (events.some((event) => pattern.test(event.text ?? ''))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for output matching ${pattern}; events: ${JSON.stringify(events)}`);
}
