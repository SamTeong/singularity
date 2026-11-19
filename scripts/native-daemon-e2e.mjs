// Isolated end-to-end check for the native `singularity-backend --http` daemon.
//
// Everything runs in a throwaway temp root: own SINGULARITY_HOME, HOME,
// USERPROFILE, CODEX_HOME, USAGE_REPORT_STATE, fake absolute CLAUDE_BIN /
// OLLAMA_BIN / CODEX_BIN and a work directory with no `.env`. The daemon gets
// an ephemeral loopback port, so no protected listener (4317/5317/6317)
// is touched. No coding agent is ever spawned.
//
// Checks:
//  1. /api/health reports clients 0 -> 1 -> 0 around one /ws socket.
//  2. The initial WS frames arrive in Node order
//     (list, tasks, crons, background, window-anchor).
//  3. /api/config/state answers.
//  4. A second instance on the same port exits 1 after the bounded retry.
//  5. POST /api/restart replies {ok:true}, the socket closes 1001, the daemon
//     exits 0, persists agents.json and respawns; the replacement is killed.
//
// Usage: node scripts/native-daemon-e2e.mjs
// Binary: SINGULARITY_NATIVE_BIN overrides target/{release,debug}/singularity-backend.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repo = resolve(import.meta.dirname, '..');
const exeName = process.platform === 'win32' ? 'singularity-backend.exe' : 'singularity-backend';
const candidate = (profile) => join(repo, 'rust', 'backend', 'target', profile, exeName);
// Prefer the most recently built profile: a stale release binary predating the
// current source would silently test the wrong daemon.
const built = [candidate('release'), candidate('debug')]
  .filter((path) => existsSync(path))
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
const configuredBinary = process.env.SINGULARITY_NATIVE_BIN;
const binary = configuredBinary ? resolve(repo, configuredBinary) : built[0];
if (!binary) {
  console.error('native backend binary not found; run cargo build --release --manifest-path rust/backend/Cargo.toml');
  process.exit(1);
}

const root = await mkdtemp(join(tmpdir(), 'singularity-native-e2e-'));
const appDir = join(root, 'app');
const workDir = join(root, 'work');
const homeDir = join(root, 'home');
const codexHome = join(root, 'codex-home');
const usageState = join(root, 'usage-state');
const binDir = join(root, 'bin');
for (const dir of [appDir, workDir, homeDir, codexHome, usageState, binDir]) {
  mkdirSync(dir, { recursive: true });
}
mkdirSync(join(appDir, 'state'));
writeFileSync(join(appDir, 'state', 'agents.json'), JSON.stringify({
  agents: [{ id: 'fixture-detached', cwd: workDir, scopes: [], tool: 'claude', status: 'detached' }],
  recentRepos: [workDir],
}));
const fake = (name) => {
  const path = join(binDir, process.platform === 'win32' ? `${name}.exe` : name);
  writeFileSync(path, '');
  return path;
};
const claudeBin = fake('claude');
const ollamaBin = fake('ollama');
const codexBin = fake('codex');

const port = await freePort();
const env = {
  ...process.env,
  SINGULARITY_HOME: appDir,
  DAEMON_PORT: String(port),
  VITE_PORT: String(port + 1),
  HOME: homeDir,
  USERPROFILE: homeDir,
  CODEX_HOME: codexHome,
  USAGE_REPORT_STATE: usageState,
  SING_TRUSTED_ROOT: workDir,
  CLAUDE_BIN: claudeBin,
  OLLAMA_BIN: ollamaBin,
  CODEX_BIN: codexBin,
  PATH: [binDir, process.env.PATH ?? ''].join(delimiter),
};
for (const key of ['SING_TOKEN', 'WINDOW_ANCHOR', 'SING_PLANS_ROOT', 'SING_RULES_REF']) {
  delete env[key];
}

const children = new Set();
const stderr = new Map();
let replacementPid;

function startDaemon() {
  const child = spawn(binary, ['--http'], {
    cwd: workDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  let log = '';
  child.stderr.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-8000);
    stderr.set(child, log);
  });
  child.stdout.resume();
  child.on('exit', () => children.delete(child));
  return child;
}

function exited(child, timeoutMs = 15000) {
  return new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null) {
      resolveExit(child.exitCode);
      return;
    }
    const timer = setTimeout(() => rejectExit(new Error('daemon did not exit in time')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function health() {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitFor(check, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

function waitForHealth() {
  return waitFor(
    async () => {
      const body = await health();
      return body.ok === true ? body : undefined;
    },
    'native daemon health',
  );
}

async function waitForClients(want) {
  return waitFor(
    async () => {
      const body = await health();
      return body.clients === want ? body : undefined;
    },
    `/api/health clients ${want}`,
  );
}

// Minimal RFC 6455 client over a raw TCP stream: the daemon's own dependency
// set has no test WebSocket crate, and the Node global client adds its own
// failure modes around the upgrade response.
function openSocket() {
  return new Promise((resolveSocket, rejectSocket) => {
    const stream = connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const socket = { frames: [], close: () => sendFrame(stream, 0x8) };
    socket.closed = new Promise((resolveClose) => {
      socket.resolveClosed = resolveClose;
    });
    let buffer = Buffer.alloc(0);
    let upgraded = false;

    const parse = () => {
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          rejectSocket(new Error(`upgrade failed: ${head.split('\r\n')[0]}`));
          stream.destroy();
          return;
        }
        const acceptHeader = head
          .split('\r\n')
          .find((line) => line.toLowerCase().startsWith('sec-websocket-accept:'))
          ?.split(':')[1]
          ?.trim();
        if (acceptHeader !== accept) {
          rejectSocket(new Error('upgrade failed: bad Sec-WebSocket-Accept'));
          stream.destroy();
          return;
        }
        upgraded = true;
        resolveSocket(socket);
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x1) {
          socket.frames.push(JSON.parse(payload.toString('utf8')));
        } else if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          socket.resolveClosed(code);
          stream.end();
          return;
        } else if (opcode === 0x9) {
          sendFrame(stream, 0xa, payload);
        }
      }
    };

    stream.on('connect', () => {
      stream.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    stream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    stream.on('error', rejectSocket);
    stream.on('close', () => {
      if (upgraded) socket.resolveClosed(1006);
      else rejectSocket(new Error('websocket stream closed during upgrade'));
    });
  });
}

function sendFrame(stream, opcode, payload = Buffer.alloc(0)) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  stream.write(Buffer.concat([header, mask, masked]));
}

function waitForFrames(socket, count) {
  return waitFor(
    () => (socket.frames.length >= count ? socket.frames : undefined),
    `${count} initial websocket frames`,
    5000,
  );
}

let primary;
try {
  // 1. Startup.
  primary = startDaemon();
  const ready = await waitForHealth();
  assert.equal(ready.clients, 0);
  assert.equal(ready.pid, primary.pid);

  // 2. One socket: health 0 -> 1, ordered frames, then 0 after close.
  console.log('step: open first socket');
  const socket = await openSocket();
  await waitForClients(1);
  const frames = await waitForFrames(socket, 5);
  assert.deepEqual(
    frames.slice(0, 5).map((frame) => frame.t),
    ['list', 'tasks', 'crons', 'background', 'window-anchor'],
  );
  assert.deepEqual(frames[0].agents.map((agent) => agent.id), ['fixture-detached']);
  assert.equal(frames[4].anchor.claude.enabled, false);
  socket.close();
  await waitForClients(0);

  // 3. Config/state route from the native server.
  console.log('step: config state');
  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/config/state`);
  assert.equal(stateResponse.status, 200);
  const stateBody = await stateResponse.json();
  assert.ok(stateBody.state && typeof stateBody.state === 'object');

  // 3b. Wave-7 routes are mounted (answer JSON, not the 404 fallback).
  console.log('step: mounted routes');
  for (const [method, path] of [
    ['GET', '/api/history?days=1'],
    ['GET', '/api/usage/history'],
    ['GET', '/api/skill-scopes'],
    ['GET', '/api/window-anchor'],
    ['GET', '/api/subagents'],
    ['POST', '/api/usagereport/refresh'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    assert.notEqual(response.status, 404, `${method} ${path}`);
    assert.match(response.headers.get('content-type') ?? '', /json/, `${method} ${path}`);
  }

  // 4. Bind conflict: same port, bounded retry, exit 1.
  console.log('step: bind conflict');
  const second = startDaemon();
  const secondCode = await exited(second, 20000);
  assert.equal(secondCode, 1);
  assert.match(stderr.get(second) ?? '', /already in use/);

  // 5. Restart: reply, 1001 close, exit 0, persisted state, respawn.
  console.log('step: restart');
  const before = await health();
  const watcher = await openSocket();
  await waitForFrames(watcher, 5);
  const closed = watcher.closed;
  const restartResponse = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST' });
  assert.equal(restartResponse.status, 200);
  assert.deepEqual(await restartResponse.json(), { ok: true });

  assert.equal(await closed, 1001);
  assert.equal(await exited(primary, 15000), 0);
  assert.ok(existsSync(join(appDir, 'state', 'agents.json')), 'agents.json was persisted');
  const persisted = JSON.parse(readFileSync(join(appDir, 'state', 'agents.json'), 'utf8'));
  assert.deepEqual(persisted.agents.map((agent) => agent.id), ['fixture-detached']);

  const replacement = await waitFor(
    async () => {
      const body = await health();
      return body.ok === true && body.pid !== before.pid ? body : undefined;
    },
    'replacement daemon health',
    20000,
  );
  replacementPid = replacement.pid;
  assert.notEqual(replacementPid, before.pid);
  const restored = await openSocket();
  const restoredFrames = await waitForFrames(restored, 5);
  assert.deepEqual(restoredFrames[0].agents.map((agent) => agent.id), ['fixture-detached']);
  assert.deepEqual(restoredFrames[0].recentRepos, [workDir]);
  restored.close();
  await waitForClients(0);
  console.log(`native daemon e2e ok (port ${port}, replacement pid ${replacementPid})`);
} catch (error) {
  for (const [child, log] of stderr) console.error(`daemon ${child.pid} stderr:\n${log}`);
  throw error;
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }
  if (replacementPid) {
    try {
      process.kill(replacementPid);
    } catch {}
    await waitFor(
      async () => {
        try {
          await health();
          return undefined;
        } catch {
          return true;
        }
      },
      'replacement shutdown',
      5000,
    ).catch(() => {});
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      break;
    } catch {
      await delay(200);
    }
  }
}
